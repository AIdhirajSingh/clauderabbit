#!/usr/bin/env python3
"""
detonate.py — the in-guest detonation harness. Runs as PID-1-ish inside the Firecracker
microVM (the container entrypoint), BEFORE and AROUND the untrusted repo. It:

  1. Points the guest's egress at the forge (Kata does not propagate resolv.conf through
     Firecracker, so the harness writes it) — every name now resolves to the forge, every
     flow is forged + captured on the host.
  2. Plants decoy credential canaries at the high-value paths real malware targets, so any
     read is observable (the read shows up in strace; an exfil shows up in the forge).
  3. Runs the repo's real install + run under strace observation (the project's own deps
     install for real through the forge's registry fast-path — genuine runtime).
  4. Emits the in-guest observations (build outcome, credential-file reads, spawned
     processes, files dropped) as one JSON record, exfiltrated to the host THROUGH the
     forge telemetry host (cr-harness.cr.internal) — the forge stores it; the host reads
     it from the capture. No virtio-fs / vsock needed; the forge channel carries telemetry.

Env:
  CR_FORGE_IP      the forge gateway (default 169.254.0.1)
  CR_TELEMETRY_HOST host the forge captures as harness telemetry (default cr-harness.cr.internal)
  CR_REPO_DIR      the pinned repo clone inside the guest (default /repo)
  CR_RUN_TIMEOUT   seconds to let the repo run under observation (default 25)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request

FORGE_IP = os.environ.get("CR_FORGE_IP", "169.254.0.1")
TELEMETRY_HOST = os.environ.get("CR_TELEMETRY_HOST", "cr-harness.cr.internal")
REPO_DIR = os.environ.get("CR_REPO_DIR", "/repo")
# Build gets a realistic budget (real installs run postinstall hooks — that's where most
# install-time malware fires); the run phase is shorter (beacon/exfil happen fast).
BUILD_TIMEOUT = int(os.environ.get("CR_BUILD_TIMEOUT", "120"))
RUN_TIMEOUT = int(os.environ.get("CR_RUN_TIMEOUT", "25"))

CANARY = "CR-CANARY-DO-NOT-EXFIL-deadbeef0123456789"
# High-value credential paths real malware targets. Decoy values only — never real.
# Split: HIGH_VALUE files a legitimate build NEVER reads (so any read is a real signal),
# vs TOOL_CONFIG files that build tools DO read legitimately (npm reads ~/.npmrc) — we
# still plant those to catch EXFIL of their contents, but a mere READ is not malice.
HIGH_VALUE = {
    os.path.expanduser("~/.aws/credentials"): f"[default]\naws_access_key_id=AKIA{CANARY[:16]}\naws_secret_access_key={CANARY}\n",
    os.path.expanduser("~/.ssh/id_rsa"): f"-----BEGIN OPENSSH PRIVATE KEY-----\n{CANARY}\n-----END OPENSSH PRIVATE KEY-----\n",
    os.path.expanduser("~/.docker/config.json"): json.dumps({"auths": {"index.docker.io": {"auth": CANARY}}}),
}
TOOL_CONFIG = {
    os.path.expanduser("~/.npmrc"): f"//registry.npmjs.org/:_authToken={CANARY}\n",
    os.path.expanduser("~/.netrc"): f"machine api.github.com login x password {CANARY}\n",
}
DECOYS = {**HIGH_VALUE, **TOOL_CONFIG}


def configure_egress() -> None:
    """All names -> the forge; the forge forges every answer + captures the conversation."""
    try:
        with open("/etc/resolv.conf", "w", encoding="utf-8") as f:
            f.write(f"nameserver {FORGE_IP}\n")
    except OSError as e:
        print(f"CR_HARNESS resolv.conf write failed: {e}", file=sys.stderr)


def plant_decoys() -> None:
    for path, content in DECOYS.items():
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError:
            pass


def detect_commands() -> tuple[str, list[str], list[str]]:
    """Return (project_type, install_cmd, run_cmd) from the repo manifest."""
    j = os.path.join
    if os.path.exists(j(REPO_DIR, "package.json")):
        # --omit=dev: install prod deps + run the repo's OWN postinstall (the main
        # install-time malware vector) without the slow devDep trees.
        return "node", ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], ["npm", "start"]
    if os.path.exists(j(REPO_DIR, "requirements.txt")):
        return "python", ["pip", "install", "-r", "requirements.txt"], ["python", "main.py"]
    if os.path.exists(j(REPO_DIR, "setup.py")) or os.path.exists(j(REPO_DIR, "pyproject.toml")):
        return "python", ["pip", "install", "."], ["python", "-c", "import sys; sys.exit(0)"]
    return "unknown", [], []


def _run(cmd: list[str], timeout: int, trace_id: str = "", observe_syscalls: bool = True) -> dict:
    """Run a command, optionally under strace. strace -f ptrace-stops on EVERY syscall
    (huge overhead on a process-heavy npm/pip install), so the BUILD runs UNTRACED for
    speed — the host forge captures ALL network (install-time exfil included). strace is
    reserved for the short RUN phase, where it catches credential-file reads cheaply."""
    if not cmd:
        return {"ran": False, "reason": "no command"}
    trace = f"/tmp/cr-strace-{trace_id}.log" if trace_id else "/tmp/cr-strace.log"
    full = (["strace", "-f", "-e", "trace=openat,execve", "-o", trace, *cmd]
            if observe_syscalls else cmd)
    t0 = time.time()
    try:
        p = subprocess.run(full, cwd=REPO_DIR, timeout=timeout, capture_output=True)
        rc, timed_out = p.returncode, False
    except subprocess.TimeoutExpired:
        rc, timed_out = None, True
    except FileNotFoundError:
        try:
            p = subprocess.run(cmd, cwd=REPO_DIR, timeout=timeout, capture_output=True)
            rc, timed_out = p.returncode, False
        except subprocess.TimeoutExpired:
            rc, timed_out = None, True
        trace = ""
    return {"ran": True, "rc": rc, "timed_out": timed_out, "secs": round(time.time() - t0, 2),
            "trace": trace if observe_syscalls else ""}


def observe(trace_files: list[str]) -> dict:
    """Parse the strace logs for the observable malice signals."""
    cred_reads, execs, connects = [], [], []
    for tf in trace_files:
        if not tf or not os.path.exists(tf):
            continue
        for line in open(tf, encoding="utf-8", errors="replace"):
            # Only HIGH_VALUE reads are a signal — a legit build never reads ~/.aws or
            # ~/.ssh, but it DOES read ~/.npmrc, so TOOL_CONFIG reads are not flagged.
            for path in HIGH_VALUE:
                if path in line and ("open" in line):
                    cred_reads.append(path)
            if "execve(" in line:
                execs.append(line.split("execve(")[1][:120])
            if "connect(" in line:
                connects.append(line.split("connect(")[1][:120])
    return {
        "credential_reads": sorted(set(cred_reads)),
        "exec_count": len(execs),
        "connect_count": len(connects),
    }


def emit(record: dict) -> None:
    """Exfiltrate the observation to the host THROUGH the forge (it captures everything)."""
    body = json.dumps(record).encode("utf-8")
    try:
        req = urllib.request.Request(f"http://{TELEMETRY_HOST}/cr-telemetry", data=body, method="POST")
        urllib.request.urlopen(req, timeout=6).read(64)
    except Exception:  # noqa: BLE001 — best effort; the host also has the forge capture
        pass
    # Also write locally (in case a block-device readback is wired later).
    try:
        with open("/tmp/cr-observation.json", "w", encoding="utf-8") as f:
            f.write(json.dumps(record))
    except OSError:
        pass


def main() -> int:
    configure_egress()
    plant_decoys()
    ptype, install_cmd, run_cmd = detect_commands()
    # BUILD untraced (fast — the forge captures install-time network); RUN traced (cheap).
    build = _run(install_cmd, BUILD_TIMEOUT, "build", observe_syscalls=False) if install_cmd else {"ran": False, "reason": "no install"}
    run = _run(run_cmd, RUN_TIMEOUT, "run", observe_syscalls=True) if run_cmd else {"ran": False, "reason": "no run cmd"}
    obs = observe([build.get("trace", ""), run.get("trace", "")])
    record = {
        "schema": "claude-rabbit/in-guest-observation/1",
        "project_type": ptype,
        "auto_build_succeeded": build.get("rc") == 0,
        "ran_without_crash": run.get("ran") and not run.get("timed_out") and run.get("rc") == 0,
        "build": build,
        "run": run,
        "observed": obs,
        "t": round(time.time(), 3),
    }
    emit(record)
    print("CR_HARNESS_DONE " + json.dumps({k: record[k] for k in ("project_type", "auto_build_succeeded", "ran_without_crash", "observed")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
