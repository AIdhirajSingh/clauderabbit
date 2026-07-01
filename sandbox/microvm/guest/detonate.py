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
import socket
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


def containment_probe() -> bool:
    """POSITIVE containment evidence (the analog of the two-VM control probe): try to
    reach a real external host by IP. If the forge is intercepting, the reply is the
    forge's forged signature, NOT the real host — so containment is positively CONFIRMED.
    If we somehow got a real response, a real packet escaped and we must NOT claim
    containment. Returns True iff the egress was intercepted (contained)."""
    try:
        with urllib.request.urlopen("http://1.1.1.1/cr-containment-probe", timeout=6) as r:
            body = r.read(256).decode("utf-8", "replace")
            # The forge answers every non-registry flow with {"status":"ok","ok":true}.
            return '"ok":true' in body or '"status":"ok"' in body
    except Exception:  # noqa: BLE001 — a blocked/forged probe (no real internet) is contained
        return True


def udp_egress_contained() -> bool:
    """POSITIVE evidence that NON-TCP egress is contained. The forge's interception is the
    TCP REDIRECT — it does NOT touch UDP. So we fire a REAL UDP DNS query straight at
    8.8.8.8:53 (bypassing the forge's dnsmasq): if a genuine DNS answer comes back, UDP
    escaped the sandbox and containment is BROKEN; if it times out / errors, the forge
    netns dropped it (ip_forward=0 + FORWARD DROP) and non-TCP egress is contained.
    Returns True iff contained (no real answer). Pairs with the TCP containment_probe."""
    import struct
    # a minimal well-formed DNS A-query for example.com (id 0x1234, RD set)
    query = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0)
    for label in (b"example", b"com"):
        query += bytes([len(label)]) + label
    query += b"\x00" + struct.pack(">HH", 1, 1)  # QTYPE=A, QCLASS=IN
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(4)
        s.sendto(query, ("8.8.8.8", 53))
        data, _ = s.recvfrom(512)
        # A real resolver echoes our id (0x1234) with QR set → that is a LEAK.
        leaked = bool(data) and len(data) >= 2 and data[0] == 0x12 and data[1] == 0x34
        return not leaked
    except Exception:  # noqa: BLE001 — dropped / no answer → contained
        return True
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass


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
        # Install ALL deps (NOT --omit=dev): a TypeScript/bundled repo's build step needs
        # devDeps (e.g. `tsc`), so omitting them dies with "tsc: not found" and the repo
        # never builds or runs — we'd observe no runtime behavior. Installing dev deps also
        # runs MORE lifecycle hooks (more install-time attack surface to capture). The
        # fetch-retry flags ride out any intermittent registry hiccup.
        return "node", ["npm", "install", "--no-audit", "--no-fund",
                        "--fetch-retries=5", "--fetch-retry-mintimeout=2000",
                        "--fetch-retry-maxtimeout=30000"], ["npm", "start"]
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
    p = None
    try:
        p = subprocess.run(full, cwd=REPO_DIR, timeout=timeout, capture_output=True)
        rc, timed_out = p.returncode, False
    except subprocess.TimeoutExpired as e:
        rc, timed_out = None, True
        p = e  # TimeoutExpired carries any partial output captured before the timeout
    except FileNotFoundError:
        try:
            p = subprocess.run(cmd, cwd=REPO_DIR, timeout=timeout, capture_output=True)
            rc, timed_out = p.returncode, False
        except subprocess.TimeoutExpired as e:
            rc, timed_out = None, True
            p = e
        trace = ""
    # Keep a stderr/stdout tail so a build FAILURE is diagnosable (and can be surfaced as
    # forensic data — "why the build did not complete") rather than a silent "did not build".
    def _tail(attr: str) -> str:
        raw = getattr(p, attr, None)
        if not raw:
            return ""
        text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        return text[-1500:]
    return {"ran": True, "rc": rc, "timed_out": timed_out, "secs": round(time.time() - t0, 2),
            "trace": trace if observe_syscalls else "",
            "stderr_tail": _tail("stderr"), "stdout_tail": _tail("stdout")}


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
    # POSITIVE containment evidence BEFORE the untrusted code runs: confirm the forge
    # intercepts a direct-to-IP TCP egress attempt AND that a direct UDP egress attempt is
    # dropped (the forge only redirects TCP — UDP must be blocked by the netns FORWARD DROP).
    contained = containment_probe()
    udp_contained = udp_egress_contained()
    print(f"CR_CONTAINMENT tcp_contained={contained} udp_contained={udp_contained}",
          file=sys.stderr, flush=True)
    plant_decoys()
    # DIAGNOSTIC: what does the microVM resolve the registry to? (real IP = passthrough
    # path is healthy; forge IP / failure = the registry DNS forward isn't reaching us).
    import socket as _socket
    for _h in ("registry.npmjs.org", "evil-c2.example"):
        try:
            _ips = sorted({a[4][0] for a in _socket.getaddrinfo(_h, 443, proto=_socket.IPPROTO_TCP)})
            print(f"CR_DNS {_h} -> {_ips}", file=sys.stderr, flush=True)
        except Exception as _e:  # noqa: BLE001
            print(f"CR_DNS {_h} FAILED: {type(_e).__name__}: {_e}", file=sys.stderr, flush=True)
    ptype, install_cmd, run_cmd = detect_commands()
    # BUILD untraced (fast — the forge captures install-time network); RUN traced (cheap).
    build = _run(install_cmd, BUILD_TIMEOUT, "build", observe_syscalls=False) if install_cmd else {"ran": False, "reason": "no install"}
    print(f"CR_BUILD rc={build.get('rc')} timed_out={build.get('timed_out')} secs={build.get('secs')} "
          f"stderr_tail={build.get('stderr_tail','')[:900]!r}", file=sys.stderr, flush=True)
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
        "containment_probe_contained": contained,
        "udp_egress_contained": udp_contained,
        "t": round(time.time(), 3),
    }
    emit(record)
    print("CR_HARNESS_DONE " + json.dumps({k: record[k] for k in ("project_type", "auto_build_succeeded", "ran_without_crash", "observed")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
