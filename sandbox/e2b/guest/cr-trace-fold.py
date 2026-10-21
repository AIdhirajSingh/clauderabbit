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

The trace is rewritten in place only when the fold finished; on any error the
original stays and the harness cap applies as before.
"""

from __future__ import annotations

import json
import os
import re
import sys

PM_BINS = {"node", "nodejs", "npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack", "uv", "pip", "pip3"}
FOLD_CALLS = {"open", "openat", "creat", "unlink", "unlinkat", "rename", "renameat", "renameat2", "chmod", "fchmodat"}
LINE_RE = re.compile(r"^(\d+)\s+[\d.]+\s+(\w+)\((.*)$")
CHILD_RE = re.compile(r"\)\s+=\s+(\d+)\s*$")
EXEC_RE = re.compile(r'^"([^"]*)"')
PATH_RE = re.compile(r'"([^"]*)"')
RESUMED_RE = re.compile(r"^(\d+)\s+[\d.]+\s+<\.\.\. (\w+) resumed>(.*)$")


def main(trace: str, home: str, out_json: str) -> int:
    places = ("/work/", "/tmp/", home.rstrip("/") + "/.npm/", home.rstrip("/") + "/.cache/", home.rstrip("/") + "/.local/")
    state: dict = {}
    first = None
    counts: dict = {}
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
            # A process first seen before its parent's clone returned is treated as
            # a script (never folded) until the clone return names its parent.
            st = state.get(pid, "script")
            if call in ("clone", "clone3", "fork", "vfork"):
                c = CHILD_RE.search(rest)
                if c and c.group(1) not in state:
                    state[c.group(1)] = st
            elif call in ("execve", "execveat") and m:
                # Any exec attempt counts, finished or not: a failed PATH probe for
                # `sh` already marks the process as a script.
                e = EXEC_RE.match(rest if call == "execve" else rest.split(", ", 1)[-1])
                base = os.path.basename(e.group(1)) if e else ""
                if st == "harness" and base in PM_BINS:
                    st = "pm"
                elif st == "pm" and base not in PM_BINS:
                    st = "script"
                state[pid] = st
            if r:
                dst.write(line)
                kept += 1
                continue
            if st == "pm" and call in FOLD_CALLS and "<unfinished" not in rest:
                p = PATH_RE.search(rest)
                path = p.group(1) if p else ""
                if path.startswith(places):
                    parts = path.strip("/").split("/")
                    key = call + " /" + "/".join(parts[:3])
                    counts[key] = counts.get(key, 0) + 1
                    folded += 1
                    continue
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
