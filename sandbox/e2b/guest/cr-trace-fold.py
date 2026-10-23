#!/usr/bin/env python3
"""Fold the package manager's own file traffic in an install trace into counts.

usage: cr-trace-fold.py <trace> <home> <folded.json>

The install trace (strace -f -ttt) of a large workspace is mostly the package
manager unpacking tarballs into its store and node_modules: hundreds of
thousands of open, rename and chmod lines that are the registry's files, not
the repo's behaviour. They pushed the trace past its size cap, so the record
was cut. This keeps every line from install scripts and everything they start,
every exec, connect and send from any process, and any path outside the
package manager's own working places, and replaces the rest with counts.

Which process is which, from the trace alone: the first process is the
harness shell; a process seen before its parent's clone returned is a script. A process that execs a package-manager binary is the package
manager, and so is every thread or child it starts. A package-manager process
that execs anything else (a lifecycle script runs as `sh -c ...`) is a script,
and so is everything it starts. Nothing a script does is folded.

A build tool the harness starts (make, ninja, cmake, a configure script) and everything
it starts is the build: its recipes run through sh, so it stays the build through any
exec. The build's reads of the build tree and the toolchains, and its writes inside the
build tree, fold; its execs, connects, sends, writes anywhere else and reads of any other
path (a home directory, /proc, /etc beyond the loader cache) stay line by line.

The trace is rewritten in place only when the fold finished; on any error the
original stays and the harness cap applies as before.
"""

from __future__ import annotations

import json
import os
import posixpath
import re
import sys

PM_BINS = {"node", "nodejs", "npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack", "uv", "pip", "pip3",
           # Go and Cargo and the compilers and linkers they drive. A Cargo build script
           # (build-script-build) and anything it starts is a script and is never folded.
           "go", "compile", "link", "asm", "cgo", "buildid", "cargo", "rustc",
           "cc", "gcc", "cc1", "as", "ld", "collect2", "x86_64-linux-gnu-gcc", "x86_64-linux-gnu-ld", "ld.bfd"}
BUILD_BINS = {"make", "gmake", "ninja", "cmake", "configure"}
# Inside the build, starts of these toolchain binaries (and the build's own recipe shells)
# fold into a count per binary after the first SAMPLE_STARTS kept in full.
TOOL_BINS = {"cc", "gcc", "g++", "c++", "clang", "clang++", "cc1", "cc1plus", "as", "ld", "ld.bfd", "ld.gold", "collect2",
             "ar", "ranlib", "strip", "pkg-config", "make", "gmake", "x86_64-linux-gnu-gcc", "x86_64-linux-gnu-g++",
             "x86_64-linux-gnu-ld", "x86_64-linux-gnu-ar", "x86_64-linux-gnu-as"}
SHELLS = {"sh", "bash", "dash"}
# A recipe shell whose command line names a network tool, a decoder or an interpreter is kept.
RISKY_CMD = re.compile(r"\b(curl|wget|nc|ncat|netcat|socat|base64|xxd|openssl|python[0-9.]*|node|perl|ruby|php|ssh|scp)\b")
SAMPLE_STARTS = 20
# The build's process bookkeeping: which process starts which, and where it runs.
BUILD_STARTS = ("clone", "clone3", "fork", "vfork", "chdir")
ARGV_CAP = 512
WRITE_FLAGS = re.compile(r"O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND")
FOLD_CALLS = {"open", "openat", "creat", "unlink", "unlinkat", "rename", "renameat", "renameat2", "chmod", "fchmodat"}
LINE_RE = re.compile(r"^(\d+)\s+[\d.]+\s+(\w+)\((.*)$")
CHILD_RE = re.compile(r"\)\s+=\s+(\d+)\s*$")
EXEC_RE = re.compile(r'^"([^"]*)"')
PATH_RE = re.compile(r'"([^"]*)"')
RESUMED_RE = re.compile(r"^(\d+)\s+[\d.]+\s+<\.\.\. (\w+) resumed>(.*)$")


def cap_argv(line: str) -> str:
    """Cut an exec line's argv array to ARGV_CAP bytes of whole strings, then `...` and the original size."""
    i = line.find(", [")
    if i < 0:
        return line
    j, k, depth, inq, esc = i + 2, i + 2, 0, False, False
    while k < len(line):
        ch = line[k]
        if inq:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                inq = False
        elif ch == '"':
            inq = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                break
        k += 1
    arr = line[j:k + 1]
    if len(arr.encode("utf-8", "surrogateescape")) <= ARGV_CAP:
        return line
    items = re.findall(r'"(?:[^"\\]|\\.)*"', arr)
    kept, size = [], 0
    for it in items:
        if size + len(it) > ARGV_CAP:
            break
        kept.append(it)
        size += len(it) + 2
    note = '"[argv cut: %d bytes]"' % len(arr.encode("utf-8", "surrogateescape"))
    return line[:j] + "[" + ", ".join(kept + [note]) + ", ...]" + line[k + 1:]


def main(trace: str, home: str, out_json: str) -> int:
    # The package manager's and compilers' own reads of the toolchains and system files
    # (GOROOT, the Rust sysroot, Node, C headers and libraries) fold too: a Go compile of a
    # thousand packages read them hundreds of thousands of times and the trace was cut.
    places = ("/work/", "/tmp/", home.rstrip("/") + "/.npm/", home.rstrip("/") + "/.cache/", home.rstrip("/") + "/.local/", home.rstrip("/") + "/go/", home.rstrip("/") + "/.cargo/",
              "/opt/cr/go/", "/opt/cr/rust/", "/opt/cr/node/", "/usr/", "/lib/", "/lib64/")
    # Where a build writes without it being behaviour: its own tree and scratch places.
    build_tree = ("/work/", "/tmp/", home.rstrip("/") + "/.cache/")
    build_reads = places + ("/etc/ld.so.cache",)
    state: dict = {}
    starts: dict = {}
    # Each process's working directory (the harness runs the install in /work/src or a folder
    # below it; chdir and clone carry it on), so a relative path resolves before it is judged.
    cwd: dict = {}
    first = None
    counts: dict = {}
    # pid -> call whose first half (with the path) was folded; its resumed half folds too.
    pm_unfinished: dict = {}
    folded = 0
    kept = 0
    tmp = trace + ".fold"
    with open(trace, "r", encoding="utf-8", errors="surrogateescape") as src, open(tmp, "w", encoding="utf-8", errors="surrogateescape") as dst:
        for line in src:
            m = LINE_RE.match(line)
            r = None if m else RESUMED_RE.match(line)
            if not m and not r:
                dst.write(line)
                kept += 1
                continue
            pid, call, rest = (m or r).group(1), (m or r).group(2), (m or r).group(3).rstrip("\n")
            if first is None:
                first = pid
                state[pid] = "harness"
                cwd[pid] = "/work/src"
            # A process first seen before its parent's clone returned is treated as
            # a script (never folded) until the clone return names its parent.
            st = state.get(pid, "script")
            if call in ("clone", "clone3", "fork", "vfork"):
                c = CHILD_RE.search(rest)
                if c and pid in cwd and c.group(1) not in cwd:
                    cwd[c.group(1)] = cwd[pid]
                if c and c.group(1) not in state:
                    state[c.group(1)] = st
                elif c and st == "build":
                    # A child of the build is the build, also when its first lines (a recipe's
                    # exec of sh) came before this clone returned and marked it a script.
                    state[c.group(1)] = "build"
            elif call in ("execve", "execveat") and m:
                # Any exec attempt counts, finished or not: a failed PATH probe for
                # `sh` already marks the process as a script.
                e = EXEC_RE.match(rest if call == "execve" else rest.split(", ", 1)[-1])
                base = os.path.basename(e.group(1)) if e else ""
                if st == "harness" and base in BUILD_BINS:
                    st = "build"
                elif st == "harness" and base in PM_BINS:
                    st = "pm"
                elif st == "pm" and base not in PM_BINS:
                    st = "script"
                state[pid] = st
            if r:
                # The second half of a split call (a busy multi-threaded tool, such as a
                # compiler, splits most of them): folded with its first half for the
                # package manager's own file calls, kept for everything else.
                if st in ("pm", "build") and (call in FOLD_CALLS or (st == "build" and call in BUILD_STARTS)) and pid in pm_unfinished and pm_unfinished.pop(pid) == call:
                    folded += 1
                    continue
                dst.write(line)
                kept += 1
                continue
            if st == "pm" and call in FOLD_CALLS:
                p = PATH_RE.search(rest)
                path = p.group(1) if p else ""
                if path.startswith(places):
                    parts = path.strip("/").split("/")
                    key = call + " /" + "/".join(parts[:3])
                    counts[key] = counts.get(key, 0) + 1
                    folded += 1
                    if "<unfinished" in rest:
                        pm_unfinished[pid] = call
                    continue
            if st == "build" and m and call in ("execve", "execveat"):
                e = EXEC_RE.match(rest if call == "execve" else rest.split(", ", 1)[-1])
                base = os.path.basename(e.group(1)) if e else ""
                if base in TOOL_BINS or (base in SHELLS and not RISKY_CMD.search(rest)):
                    n = starts.get(base, 0) + 1
                    starts[base] = n
                    if n > SAMPLE_STARTS:
                        key = "build start " + base
                        counts[key] = counts.get(key, 0) + 1
                        folded += 1
                        continue
            if m and call == "chdir" and pid in cwd and rest.rstrip().endswith("= 0"):
                p = PATH_RE.search(rest)
                if p:
                    cwd[pid] = posixpath.normpath(posixpath.join(cwd[pid], p.group(1)))
            if st == "build" and m and call in BUILD_STARTS:
                key = "build " + call
                counts[key] = counts.get(key, 0) + 1
                folded += 1
                if "<unfinished" in rest:
                    pm_unfinished[pid] = call
                continue
            if st == "build" and call in FOLD_CALLS:
                p = PATH_RE.search(rest)
                path = p.group(1) if p else ""
                # A path relative to the working directory (open, or openat on AT_FDCWD) resolves
                # against it; one relative to another descriptor stays as it is (kept).
                if path and not path.startswith("/") and pid in cwd and (call in ("open", "creat", "chmod", "unlink", "rename") or rest.startswith("AT_FDCWD")):
                    path = posixpath.normpath(posixpath.join(cwd[pid], path))
                writes = call not in ("open", "openat") or bool(WRITE_FLAGS.search(rest))
                if path.startswith(build_tree if writes else build_reads):
                    parts = path.strip("/").split("/")
                    key = "build " + call + " /" + "/".join(parts[:3])
                    counts[key] = counts.get(key, 0) + 1
                    folded += 1
                    if "<unfinished" in rest:
                        pm_unfinished[pid] = call
                    continue
            if m and call in ("execve", "execveat"):
                line = cap_argv(line.rstrip("\n")) + "\n"
            dst.write(line)
            kept += 1
    os.replace(tmp, trace)
    top = sorted(counts.items(), key=lambda kv: -kv[1])
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"folded": folded, "kept": kept, "counts": dict(top[:200]), "groups": len(top)}, f)
    print(f"{folded} {kept}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
    except Exception as e:  # noqa: BLE001 - the harness keeps the original trace
        try:
            os.unlink(sys.argv[1] + ".fold")
        except OSError:
            pass
        print(f"fold failed: {e}", file=sys.stderr)
        sys.exit(1)
