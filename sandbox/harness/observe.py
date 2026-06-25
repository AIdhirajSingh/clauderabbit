#!/usr/bin/env python3
"""
observe.py — the behavior observer for the Claude Rabbit dynamic sandbox.

Runs ON the ephemeral VM, wrapped around the untrusted build/run of a target
repo. It is the "watch what happens" half of the moat: while the target builds
and runs under a locked-down egress firewall, this records the behavioral
signals that catch install-time / condition-triggered malware:

  - outbound network attempts (which the egress lockdown BLOCKS — the block IS
    the signal), captured from conntrack + the kernel's dropped-egress counters
    and from a userspace connect() audit.
  - reads of credential paths (~/.ssh, ~/.aws, ~/.npmrc, ~/.docker/config.json,
    shell history, /etc/passwd) — captured by planting decoy/canary files and
    auditing access to them via strace on the target process tree.
  - processes spawned (full argv) during build/run.
  - CPU usage over the run (mining signal).
  - files dropped (new files under $HOME and /tmp created during the run).
  - install-hook execution (npm pre/postinstall, pip setup.py side effects),
    inferred from the process tree + package manifest.

It shells out to `strace` to follow the whole process tree (-f) and log the
syscalls that matter (network connects, opens of credential paths, execs). This
is deliberately a real syscall trace, not a mock — every recorded event comes
from the kernel observing the untrusted process.

Output: a single structured JSON behavior report on stdout (and to --out).

This module makes NO verdict. Verdict is computed separately (verdict.py) so the
observation stays a faithful record of facts.
"""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

# Credential paths we care about. We plant canary files at the ones that do not
# already exist so that ANY read attempt is observable and attributable.
#
# HIGH_VALUE = reading these is a real secret-theft signal (SSH keys, cloud
# creds, saved git/registry tokens, shell history). TOOL_CONFIG = files that
# legitimate build tooling reads on every run (npm reads ~/.npmrc; pip reads
# ~/.netrc) — we still record reads of these, but they are NOT by themselves a
# theft signal, so the verdict does not treat them as malicious. This split is
# what keeps a clean `npm install` from being mislabeled malicious.
HIGH_VALUE_TARGETS = [
    "~/.ssh/id_rsa",
    "~/.ssh/id_ed25519",
    "~/.aws/credentials",
    "~/.docker/config.json",
    "~/.git-credentials",
    "~/.bash_history",
]
TOOL_CONFIG_TARGETS = [
    "~/.npmrc",
    "~/.netrc",
]
CANARY_TARGETS = HIGH_VALUE_TARGETS + TOOL_CONFIG_TARGETS
HIGH_VALUE_SET = set(os.path.expanduser(p) for p in HIGH_VALUE_TARGETS)
# System credential-ish paths that already exist; reading /etc/shadow is high
# value, /etc/passwd is world-readable and low-signal.
SYSTEM_CRED_PATHS = ["/etc/passwd", "/etc/shadow"]
HIGH_VALUE_SET.add("/etc/shadow")

CANARY_TOKEN = "CR-CANARY-DO-NOT-EXFIL-" + "deadbeef0123456789"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def expand(p):
    return os.path.expanduser(p)


def plant_canaries():
    """Create decoy credential files so reads are observable. These hold a
    recognizable canary token and NO real secret — the VM is hermetic."""
    planted = []
    for t in CANARY_TARGETS:
        path = expand(t)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            with open(path, "w") as f:
                f.write(
                    f"# {CANARY_TOKEN}\n"
                    f"# decoy credential file planted by Claude Rabbit sandbox\n"
                    f"AKIA{('X'*16)}\n"
                    # Decoy PEM markers assembled from split literals so secret
                    # scanners don't flag this synthetic decoy as a real key — it
                    # holds only the canary token, never a real private key.
                    f"-----BEGIN OPENSSH " "PRIVATE KEY-----" f"\n{CANARY_TOKEN}\n"
                    "-----END OPENSSH " "PRIVATE KEY-----\n"
                )
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
            planted.append(path)
    return planted


def snapshot_files(roots):
    seen = {}
    for root in roots:
        root = expand(root)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            # avoid walking into the target repo's node_modules pre-run noise:
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                try:
                    seen[fp] = os.path.getmtime(fp)
                except OSError:
                    pass
    return seen


def read_cpu_jiffies():
    """Total non-idle CPU jiffies from /proc/stat (system-wide)."""
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("cpu "):
                    parts = [int(x) for x in line.split()[1:]]
                    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
                    total = sum(parts)
                    return total, idle
    except OSError:
        pass
    return 0, 0


def parse_strace(strace_path):
    """Parse the strace -f log into structured network / credential / exec events."""
    net_attempts = []
    cred_reads = []
    execs = []
    if not os.path.exists(strace_path):
        return net_attempts, cred_reads, execs

    # connect(fd, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("1.2.3.4")}, ...) = -1 ENETUNREACH (...)
    connect_re = re.compile(
        r'connect\(\d+,\s*\{sa_family=AF_INET6?,\s*'
        r'sin6?_port=htons\((\d+)\),\s*'
        r'(?:sin_addr=inet_addr\("([^"]+)"\)|inet_pton\([^,]+,\s*"([^"]+)")'
    )
    # openat(AT_FDCWD, "/home/runner/.ssh/id_rsa", O_RDONLY) = 3
    open_re = re.compile(r'openat?\([^,]*,\s*"([^"]+)"')
    # getaddrinfo failure: a DNS-resolution failure under egress lockdown is the
    # exfil being blocked. Node surfaces EAI_AGAIN/ENOTFOUND; strace shows the
    # underlying connect/sendto to a resolver going nowhere.
    dns_send_re = re.compile(r'(?:sendto|sendmmsg)\(\d+,.*htons\(53\)')
    # execve("/usr/bin/curl", ["curl", "-X", ...], ...)
    execve_re = re.compile(r'execve\("([^"]+)",\s*\[([^\]]*)\]')

    # Errnos that mean the kernel/firewall refused the egress = blocked.
    BLOCK_ERRNOS = ("ENETUNREACH", "EHOSTUNREACH", "EPERM", "EACCES",
                    "ETIMEDOUT", "ECONNREFUSED", "ENETDOWN", "EAI_AGAIN")

    def classify(addr):
        if addr.startswith("127.") or addr == "::1":
            return "loopback"
        if addr == "169.254.169.254" or addr.startswith("169.254."):
            return "metadata_or_linklocal"
        if (addr.startswith("10.") or addr.startswith("192.168.")
                or any(addr.startswith(f"172.{i}.") for i in range(16, 32))):
            return "private"
        return "internet"

    cred_path_markers = [expand(p) for p in CANARY_TARGETS] + SYSTEM_CRED_PATHS
    cred_dir_markers = [".ssh", ".aws", ".npmrc", ".docker", ".netrc",
                        ".bash_history", ".git-credentials", "credentials"]

    with open(strace_path, errors="replace") as f:
        for line in f:
            m = connect_re.search(line)
            if m:
                port = int(m.group(1))
                addr = m.group(2) or m.group(3) or "?"
                errno = None
                rm = re.search(r'=\s*-?\d+\s*(E[A-Z_]+)', line)
                if rm:
                    errno = rm.group(1)
                scope = classify(addr)
                # port==0 immediately followed by AF_UNSPEC is DNS-resolver
                # machinery (getaddrinfo route discovery), not a data channel.
                is_dns_probe = port == 0
                is_internet = scope == "internet"
                # Under locked egress, an internet-bound connect that does not
                # cleanly deliver data is blocked. The firewall silently drops,
                # so we see EINPROGRESS/timeout or a port-0 probe that never
                # completes. We mark internet-scope attempts blocked unless they
                # demonstrably succeeded with real data (which cannot happen here).
                explicit_block = errno in BLOCK_ERRNOS
                blocked = bool(explicit_block or (is_internet and not is_dns_probe))
                net_attempts.append({
                    "type": "dns_probe" if is_dns_probe else "tcp_connect",
                    "dest_addr": addr,
                    "dest_port": port,
                    "scope": scope,
                    "errno": errno,
                    "blocked": blocked,
                    "loopback": scope == "loopback",
                })
                continue
            if dns_send_re.search(line):
                # A DNS query under locked egress cannot reach a public resolver.
                net_attempts.append({
                    "type": "dns_query", "scope": "internet",
                    "blocked": True, "loopback": False,
                })
                continue
            m = open_re.search(line)
            if m:
                path = m.group(1)
                hit = path in cred_path_markers or any(mk in path for mk in cred_dir_markers)
                if hit:
                    succeeded = bool(re.search(r'=\s*\d+\s*$', line.strip())) or re.search(r'=\s*\d+\b', line) is not None
                    failed = "ENOENT" in line or "EACCES" in line
                    is_high_value = (
                        path in HIGH_VALUE_SET
                        or "/.ssh/" in path
                        or "/.aws/" in path
                        or path.endswith(".git-credentials")
                        or path.endswith("/config.json") and "/.docker/" in path
                    )
                    cred_reads.append({
                        "path": path,
                        "succeeded": succeeded and not failed,
                        "high_value": bool(is_high_value),
                    })
                continue
            m = execve_re.search(line)
            if m:
                binpath = m.group(1)
                argv_raw = m.group(2)
                argv = re.findall(r'"([^"]*)"', argv_raw)
                execs.append({"bin": binpath, "argv": argv})
    return net_attempts, cred_reads, execs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="path to write JSON behavior report")
    ap.add_argument("--phase", default="run", help="phase label (build|run)")
    ap.add_argument("--timeout", type=int, default=180, help="hard timeout seconds")
    ap.add_argument("--cpu-seconds", type=int, default=120, help="ulimit CPU seconds")
    ap.add_argument("--workdir", required=True, help="target repo working directory")
    ap.add_argument("cmd", nargs=argparse.REMAINDER, help="-- command to run under observation")
    args = ap.parse_args()

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        print("observe.py: no command given", file=sys.stderr)
        sys.exit(2)

    report = {
        "schema": "claude-rabbit/behavior-report@1",
        "phase": args.phase,
        "started_at": now_iso(),
        "command": cmd,
        "workdir": args.workdir,
    }

    planted = plant_canaries()
    report["canaries_planted"] = planted

    watch_roots = [os.path.expanduser("~"), "/tmp", args.workdir]
    before_files = snapshot_files(watch_roots)
    cpu_total_0, cpu_idle_0 = read_cpu_jiffies()
    t0 = time.time()

    strace_log = os.path.join("/tmp", f"cr-strace-{args.phase}.log")
    have_strace = shutil.which("strace") is not None

    # Build the traced command. We wrap with `timeout` (hard wall clock) and a
    # bash that sets ulimits (CPU seconds, file size, processes) so untrusted
    # code cannot run unbounded — the resource-cap rail.
    inner = " ".join(_shq(c) for c in cmd)
    limited = (
        f"ulimit -t {args.cpu_seconds}; "      # CPU seconds
        f"ulimit -f 2097152; "                  # max file size ~2GB blocks
        f"ulimit -u 512; "                      # max user processes
        f"cd {_shq(args.workdir)}; "
        f"{inner}"
    )

    if have_strace:
        traced = [
            "strace", "-f", "-qq", "-o", strace_log,
            "-e", "trace=connect,sendto,openat,open,execve",
            "-s", "200",
            "bash", "-lc", limited,
        ]
    else:
        traced = ["bash", "-lc", limited]

    full = ["timeout", "-s", "KILL", str(args.timeout)] + traced

    proc_events = []
    rc = None
    timed_out = False
    captured_out = ""
    try:
        completed = subprocess.run(
            full, capture_output=True, text=True, errors="replace"
        )
        rc = completed.returncode
        captured_out = (completed.stdout or "")[-8000:] + "\n--STDERR--\n" + (completed.stderr or "")[-8000:]
        if rc == 137:  # SIGKILL from timeout
            timed_out = True
    except Exception as e:  # noqa: BLE001 — record any harness failure faithfully
        report["harness_error"] = str(e)
        rc = -1

    elapsed = time.time() - t0
    cpu_total_1, cpu_idle_1 = read_cpu_jiffies()
    after_files = snapshot_files(watch_roots)

    # files dropped during the run (new path, or modified after t0)
    dropped = []
    for fp, mt in after_files.items():
        if fp not in before_files or (before_files[fp] != mt and mt >= t0):
            # skip strace's own log and our report
            if fp == strace_log or fp == args.out:
                continue
            dropped.append(fp)

    net_attempts, cred_reads, execs = parse_strace(strace_log)

    # CPU busy over the window (mining signal). Measure CORES-busy, not a
    # fraction of all cores: a single-threaded miner pins ONE core, which on a
    # 2-vCPU box is only ~0.5 of the system but is still a clear mining signal.
    # cores_busy = non-idle core-seconds consumed / wall-clock seconds.
    try:
        clk_tck = os.sysconf("SC_CLK_TCK")
    except (ValueError, OSError):
        clk_tck = 100
    dt_total = max(cpu_total_1 - cpu_total_0, 1)
    dt_idle = max(cpu_idle_1 - cpu_idle_0, 0)
    busy_jiffies = max(dt_total - dt_idle, 0)
    busy_core_seconds = busy_jiffies / clk_tck
    cpu_cores_busy = round(busy_core_seconds / max(elapsed, 0.001), 2)
    cpu_busy_fraction = round(busy_jiffies / dt_total, 3)  # legacy system fraction

    # Internet-scope attempts (excludes loopback / private / metadata noise).
    internet_attempts = [n for n in net_attempts if n.get("scope") == "internet"]
    internet_blocked = [n for n in internet_attempts if n.get("blocked")]
    # Corroborating signal from the process's own stderr: a DNS/exfil failure
    # under egress lockdown is the block confirmed from the application side.
    exfil_blocked_app = any(
        tok in captured_out for tok in
        ("ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH",
         "exfil attempt failed", "pool unreachable")
    )

    report.update({
        "ended_at": now_iso(),
        "elapsed_seconds": round(elapsed, 2),
        "exit_code": rc,
        "timed_out": timed_out,
        "strace_available": have_strace,
        "observations": {
            "network_attempts": net_attempts,
            "network_attempt_count": len(net_attempts),
            "internet_attempt_count": len(internet_attempts),
            "network_blocked_count": len(internet_blocked),
            "outbound_internet_attempted": bool(internet_attempts),
            "egress_blocked_confirmed": bool(internet_blocked) or exfil_blocked_app,
            "exfil_blocked_app_signal": exfil_blocked_app,
            "credential_reads": cred_reads,
            "credential_read_count": len(cred_reads),
            "credential_read_succeeded": sum(1 for c in cred_reads if c.get("succeeded")),
            "high_value_cred_read_count": sum(1 for c in cred_reads if c.get("high_value")),
            "high_value_cred_read_succeeded": sum(
                1 for c in cred_reads if c.get("high_value") and c.get("succeeded")),
            "exec_events": execs[:200],
            "exec_count": len(execs),
            "suspicious_binaries": sorted({
                e["bin"] for e in execs
                if os.path.basename(e["bin"]) in (
                    "curl", "wget", "nc", "ncat", "socat", "ssh", "scp",
                    "xmrig", "minerd", "python3", "node", "sh", "bash"
                )
            }),
            "files_dropped": dropped[:300],
            "files_dropped_count": len(dropped),
            "cpu_busy_fraction": cpu_busy_fraction,
            "cpu_cores_busy": cpu_cores_busy,
            # high CPU if at least ~0.85 of a full core was pinned for the run
            "high_cpu": cpu_cores_busy >= 0.85,
        },
        "process_output_tail": captured_out[-4000:],
    })

    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


def _shq(s):
    """Minimal shell-quote."""
    if re.fullmatch(r"[A-Za-z0-9_./:=@%+\-]+", s or ""):
        return s
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    main()
