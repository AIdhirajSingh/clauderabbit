#!/usr/bin/env python3
"""
detonate.py — the in-container detonation harness. Runs INSIDE the Cloud Run Job
execution (the container the entrypoint launches), BEFORE and AROUND the
untrusted repo already cloned at CR_REPO_DIR. It:

  1. Plants decoy credential canaries at the high-value paths real malware
     targets, so any read is observable (the read shows up in strace).
  2. Runs the repo's real install + run under strace observation (the project's
     own deps install for real through the gateway's registry fast-path —
     genuine runtime).
  3. Runs two POSITIVE containment self-checks: a TCP probe to a real external IP
     (expecting the gateway's forged reply, never the real host) and a raw UDP
     DNS query (expecting it to be dropped/timeout — the gateway/route only
     forces TCP-shaped egress through itself; non-TCP must still be contained by
     the VPC's egress posture).
  4. Emits one JSON observation record. Unlike the old microVM harness, this
     record is NOT sent over the network here — the entrypoint (entrypoint.sh)
     reads the gateway's one-shot `/forensics?scan_id=` capture AFTER this
     script exits, and folds this script's own local observation (auto-build
     success, credential reads, exec/connect counts) into the final forensic
     record via assemble-forensics.py. This script just writes its observation
     to CR_OBSERVATION_PATH (default /tmp/cr-observation.json) for the
     entrypoint to pick up.
  5. Beacons the install-end/run-start PHASE BOUNDARY to the gateway's telemetry
     endpoint (the SAME host the gateway's forge_addon.py already recognizes as
     harness telemetry, `cr-harness.cr.internal`), so the host can tell a benign
     build-time dependency fetch apart from a genuine run-phase network attempt
     when it scores the run — see assemble-forensics.py.

ARCHITECTURE CHANGE FROM THE OLD MICROVM HARNESS (read this before editing):
  The OLD guest ran inside a Kata/Firecracker microVM on a persistent host, with
  a per-run network-namespace forge intercepting DNS + egress; the guest had to
  rewrite /etc/resolv.conf to point DNS at the forge (`configure_egress()`).
  Cloud Run Gen2 containers get NO CAP_NET_ADMIN and no netns access, so there is
  no DNS-hijacking to do here: the container's outbound route is forced to the
  gateway VM (10.200.0.10) by a GCP custom route at the VPC layer, REGARDLESS of
  what a hostname resolves to. Real DNS resolution works normally. Containment
  is purely route-based, not DNS-based. `configure_egress()` is therefore a
  documented no-op, kept only so nothing else in this file has to change shape.

Env:
  CR_TELEMETRY_HOST     host the gateway recognizes as harness telemetry
                        (default cr-harness.cr.internal — unchanged from the old
                        guest; the gateway's forge_addon.py already special-cases
                        this host for the phase-marker beacon)
  CR_REPO_DIR           the pinned repo clone (default /repo)
  CR_RUN_TIMEOUT        seconds to let the repo run under observation (default 25)
  CR_BUILD_TIMEOUT      seconds for the adaptive install ladder (default 240)
  CR_OBSERVATION_PATH   where to write the local observation JSON (default
                        /tmp/cr-observation.json) — entrypoint.sh reads this
  CR_GATEWAY_IP         the forge gateway's DNS + egress IP (default 10.200.0.10)
                        — configure_egress() points /etc/resolv.conf at it
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

TELEMETRY_HOST = os.environ.get("CR_TELEMETRY_HOST", "cr-harness.cr.internal")
GATEWAY_IP = os.environ.get("CR_GATEWAY_IP", "10.200.0.10")
# A distinct path from the main telemetry POST so assemble-forensics.py can tell
# the phase-boundary beacon apart from the full observation record at a glance.
PHASE_MARKER_PATH = "/cr-phase-marker"
REPO_DIR = os.environ.get("CR_REPO_DIR", "/repo")
OBSERVATION_PATH = os.environ.get("CR_OBSERVATION_PATH", "/tmp/cr-observation.json")
# Real, granular progress reporting (the processing-timeline feature) — a
# SEPARATE mechanism from emit_phase_marker above: that beacon goes through the
# gateway's telemetry endpoint for FORENSICS phase-boundary classification;
# this one reaches the deep-queue Supabase edge function directly (a verified
# control-plane passthrough, same as attach-forensics) purely to report live
# UI progress. Losing this beacon never affects the detonation or its
# forensics — it's observability only, same contract as entrypoint.sh's own
# report_stage() (bash) which calls the same op for the container/clone/agent
# stages; this is the one stage transition (install-done -> run-start) that's
# only knowable from inside detonate.py itself.
CR_SCAN_ID = os.environ.get("CR_SCAN_ID", "")
CR_SUPABASE_URL = os.environ.get("CR_SUPABASE_URL", "")
CR_SUPABASE_ANON_KEY = os.environ.get("CR_SUPABASE_ANON_KEY", "")
CR_DEEP_RUNNER_KEY = os.environ.get("CR_DEEP_RUNNER_KEY", "")
# Build gets a realistic budget (real installs run postinstall hooks — that's where most
# install-time malware fires); the run phase is shorter (beacon/exfil happen fast). The
# budget is the TOTAL for the adaptive ladder (native install + any error-driven retry all
# share it), so a repo whose first attempt fails fast still has room for a second attempt.
BUILD_TIMEOUT = int(os.environ.get("CR_BUILD_TIMEOUT", "240"))
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
    """REINSTATED (see module docstring for why the first cut made this a no-op,
    and why that was wrong): route-based containment alone only catches malware
    whose C2 domain actually resolves to SOME real IP. A genuinely non-existent
    or sinkholed domain fails DNS resolution INSIDE the container before any
    connection is even attempted — confirmed on a real deployed run: a beacon to
    a non-resolving example C2 domain never appeared in the gateway's capture at
    all, i.e. it went silently DORMANT, the exact failure mode this product
    exists to prevent. The gateway now runs dnsmasq (answer-all-except-allowlist,
    same discipline as the old per-run design, just centralized on the shared
    gateway instead of a per-run instance) — pointing DNS at it makes every
    domain resolvable to SOMETHING reachable, so a condition-gated sample's
    connection attempt actually happens and the forced route + forge can
    intercept it. Real registries/control-plane/source hosts still resolve to
    their REAL IPs (dnsmasq forwards those), so containment for a genuinely
    malicious real-IP C2 is unchanged — this only fixes the non-existent-domain
    gap. Cloud Run containers get a writable, per-container /etc/resolv.conf
    (no CAP_NET_ADMIN needed to write a plain file — confirmed by this actually
    working on a real deployed execution)."""
    try:
        with open("/etc/resolv.conf", "w", encoding="utf-8") as f:
            f.write(f"nameserver {GATEWAY_IP}\noptions timeout:2 attempts:2\n")
    except OSError as e:
        print(f"CR_HARNESS resolv.conf write failed: {e}", file=sys.stderr)


def containment_probe() -> bool:
    """POSITIVE containment evidence: try to reach a real external host by IP.
    If the gateway's custom route + mitmproxy addon is intercepting, the reply
    is the gateway's forged signature, NOT the real host — so containment is
    positively CONFIRMED. If we somehow got a real response, a real packet
    escaped and we must NOT claim containment. Returns True iff the egress was
    intercepted (contained)."""
    try:
        with urllib.request.urlopen("http://1.1.1.1/cr-containment-probe", timeout=6) as r:
            body = r.read(256).decode("utf-8", "replace")
            # The gateway answers every non-registry/non-control-plane flow with
            # a forged {"status":"ok","ok":true}-shaped body.
            return '"ok":true' in body or '"status":"ok"' in body
    except Exception:  # noqa: BLE001 — a blocked/forged probe (no real internet) is contained
        return True


def udp_egress_contained() -> bool:
    """POSITIVE evidence that NON-TCP egress is contained. mitmproxy's transparent
    interception is TCP-only — it does not touch UDP. So we fire a REAL UDP DNS
    query straight at 8.8.8.8:53: if a genuine DNS answer comes back, UDP escaped
    the sandbox and containment is BROKEN; if it times out / errors, the
    container's egress posture (the custom route + firewall) dropped it and
    non-TCP egress is contained. Returns True iff contained (no real answer).
    Pairs with the TCP containment_probe."""
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


def raise_fd_limit() -> None:
    """A large monorepo install opens thousands of files at once; the default RLIMIT_NOFILE
    soft cap makes npm/yarn/pnpm die with `EMFILE: too many open files` (observed on
    react/react's 30-package monorepo) — a resource limit, NOT a dependency wrinkle. Raise
    the soft limit to the hard limit in-process; the build children inherit it. No privilege
    escalation, no containment change."""
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        target = 1048576 if hard == resource.RLIM_INFINITY else hard
        if soft < target:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
        print(f"CR_FDLIMIT soft={soft}->{resource.getrlimit(resource.RLIMIT_NOFILE)[0]} hard={hard}",
              file=sys.stderr, flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"CR_FDLIMIT raise failed: {e}", file=sys.stderr, flush=True)


def plant_decoys() -> None:
    for path, content in DECOYS.items():
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError:
            pass


# npm flags every attempt carries: install ALL deps (NOT --omit=dev — a TS/bundled repo's
# build needs devDeps like `tsc`; omitting them dies with "tsc: not found" and the repo
# never builds/runs; installing them also fires MORE lifecycle hooks = more install-time
# attack surface to capture). The fetch-retry flags ride out an intermittent registry hiccup.
NPM_FLAGS = ["--no-audit", "--no-fund", "--fetch-retries=5",
             "--fetch-retry-mintimeout=2000", "--fetch-retry-maxtimeout=30000"]


def _read_pkg() -> dict:
    try:
        with open(os.path.join(REPO_DIR, "package.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 — a malformed/absent manifest is not our problem to solve
        return {}


def detect_node_pm() -> str:
    """The package manager the repo is NATIVE to — from its lockfile first (authoritative),
    then the packageManager field. A plain `npm install` on a yarn/pnpm-native repo is
    often already the wrong tool, so pick the right one before adapting on error."""
    j = os.path.join
    if os.path.exists(j(REPO_DIR, "pnpm-lock.yaml")):
        return "pnpm"
    if os.path.exists(j(REPO_DIR, "yarn.lock")):
        return "yarn"
    if os.path.exists(j(REPO_DIR, "package-lock.json")) or os.path.exists(j(REPO_DIR, "npm-shrinkwrap.json")):
        return "npm"
    pm = str(_read_pkg().get("packageManager", ""))
    if pm.startswith("pnpm"):
        return "pnpm"
    if pm.startswith("yarn"):
        return "yarn"
    return "npm"


def _node_run_cmd() -> list[str]:
    """How to RUN the repo after the build. `npm start` runs the start script regardless of
    which PM installed node_modules; fall back to a main entry so a lib without a start
    script still executes something observable."""
    pkg = _read_pkg()
    scripts = pkg.get("scripts") or {}
    if isinstance(scripts, dict) and "start" in scripts:
        return ["npm", "start"]
    main = pkg.get("main")
    if isinstance(main, str) and main and os.path.exists(os.path.join(REPO_DIR, main)):
        return ["node", main]
    for entry in ("index.js", "server.js", "app.js", "dist/index.js", "build/index.js"):
        if os.path.exists(os.path.join(REPO_DIR, entry)):
            return ["node", entry]
    return ["npm", "start"]


def _node_build_cmd(pm: str) -> list[str]:
    """The repo's OWN `build` script, run with the package manager that installed it — or []
    when the repo declares none. A compiled app (Next.js/Vite/CRA/Angular/etc.) must run its
    build BEFORE its start script will boot: `next start` with no prior `next build` exits
    immediately with 'no production build found', which the harness then recorded as "never
    reached a runnable state" even though install + start were both fine. Running the real
    build first is what makes "we run it" true for a compiled app, not only for a bare
    `node index.js`. This runs in the BUILD phase (before the run_start marker) so any fetch
    it makes — telemetry, font/CDN pulls a framework build does — is classified as build-time
    supply-chain, not a run-phase attack (see emit_phase_marker / assemble-forensics.py)."""
    scripts = _read_pkg().get("scripts") or {}
    build = scripts.get("build") if isinstance(scripts, dict) else None
    if not (isinstance(build, str) and build.strip()):
        return []
    if pm == "pnpm":
        return ["pnpm", "run", "build"]
    if pm == "yarn":
        return ["yarn", "build"]
    return ["npm", "run", "build"]


def detect_project() -> tuple[str, list[str]]:
    """Return (project_type, run_cmd). The BUILD for node is handled by adaptive_node_build();
    python/unknown use a single install (below)."""
    j = os.path.join
    if os.path.exists(j(REPO_DIR, "package.json")):
        return "node", _node_run_cmd()
    if os.path.exists(j(REPO_DIR, "requirements.txt")):
        return "python", ["python", "main.py"]
    if os.path.exists(j(REPO_DIR, "setup.py")) or os.path.exists(j(REPO_DIR, "pyproject.toml")):
        return "python", ["python", "-c", "import sys; sys.exit(0)"]
    return "unknown", []


def _pip_install() -> list[str]:
    j = os.path.join
    if os.path.exists(j(REPO_DIR, "requirements.txt")):
        return ["pip", "install", "-r", "requirements.txt"]
    return ["pip", "install", "."]


def adaptive_node_build(budget_s: int) -> tuple[dict, list[dict], str]:
    """Adaptive, error-DRIVEN dependency install — the decision tree a developer runs when
    `npm install` fails, executed INSIDE the sealed container through the gateway. No model
    egress and no elevated trust are needed (the gateway blocks everything but registries, so
    an in-container model agent can't run without breaking containment); this encodes the exact
    error->flag rules a terminal-driving agent would apply, with the SAME isolation.

    Ladder (stop at the first rc==0, each step gated on the PREVIOUS real error):
      1. native install with the repo's OWN package manager (pnpm/yarn/npm from the lockfile),
         given the FULL budget in one run — corepack serves the repo's pinned yarn/pnpm
         version, so one command covers npm, classic yarn, yarn-berry, and pinned pnpm alike;
         a native TIMEOUT stops honestly (a killed install can't be cleanly resumed and npm
         can't rescue a yarn/pnpm-only repo).
      2. pnpm 'outdated/frozen lockfile'  -> pnpm install --no-frozen-lockfile
      3. npm ERESOLVE peer-dep conflict   -> npm install --legacy-peer-deps -> --force
      4. universal fallback (npm can install almost any package.json, incl. yarn/pnpm-native
         repos) -> npm --legacy-peer-deps -> --force, if not already tried
    Returns (best_result, attempt_log, package_manager). Budget-aware: each attempt gets the
    REMAINING time so the ladder never blows the container's overall run cap."""
    pm = detect_node_pm()
    deadline = time.time() + budget_s
    log: list[dict] = []

    def attempt(cmd: list[str], why: str) -> dict | None:
        remaining = int(deadline - time.time())
        if remaining < 12:  # not enough budget to meaningfully try — stop honestly
            return None
        r = _run(cmd, remaining, "build", observe_syscalls=False)
        entry = {"cmd": " ".join(cmd), "why": why, "rc": r.get("rc"),
                 "timed_out": r.get("timed_out"), "secs": r.get("secs")}
        log.append(entry)
        print(f"CR_BUILD_TRY [{why}] {' '.join(cmd)} -> rc={r.get('rc')} "
              f"secs={r.get('secs')} timed_out={r.get('timed_out')}", file=sys.stderr, flush=True)
        return r

    def err_of(r: dict | None) -> str:
        if not r:
            return ""
        return ((r.get("stderr_tail") or "") + " " + (r.get("stdout_tail") or "")).lower()

    def tried() -> str:
        return " | ".join(e["cmd"] for e in log)

    # 1) native — the repo's OWN package manager, given the FULL budget in ONE continuous
    #    run. corepack (enabled in the base image) makes `yarn`/`pnpm` resolve to the EXACT
    #    version the repo pins (packageManager field / .yarn release), so a single native
    #    command handles npm, classic yarn, yarn-berry, and every pinned pnpm alike. Two
    #    hard-won reasons it is never capped short:
    #      * For a yarn/pnpm-only repo the npm fallbacks below are doomed (its link:/workspace:
    #        deps use protocols npm can't read), so the native tool is the ONE thing that can
    #        work — cutting it off to "save budget for a retry" kills the only viable install.
    #      * A hard-killed install can't be cleanly resumed (partial state makes the re-run
    #        error out), so a half-run is worse than a full one. A real monorepo (react)
    #        installs in ~1.5-3 min — it must run to the end.
    #    npm's own failure mode (ERESOLVE) still surfaces in seconds, so an npm repo that needs
    #    a --legacy-peer-deps retry leaves almost the whole budget for it. `yarn install` runs
    #    WITHOUT --network-timeout: that flag is classic-yarn-only and yarn-berry rejects it as
    #    unknown, so passing it would break every berry install corepack now enables.
    if pm == "pnpm" and shutil.which("pnpm"):
        native_cmd, native_why = ["pnpm", "install"], "pnpm — native (pnpm-lock.yaml)"
    elif pm == "yarn" and shutil.which("yarn"):
        native_cmd, native_why = ["yarn", "install"], "yarn — native (yarn.lock)"
    else:
        native_cmd = ["npm", "install", *NPM_FLAGS]
        native_why = "npm — native" if pm == "npm" else f"npm — native ({pm} repo; native tool unavailable)"
    last = attempt(native_cmd, native_why)
    if last and last.get("rc") == 0:
        return last, log, pm
    # Timed out = killed mid-install; its partial state can't be cleanly resumed and npm can't
    # help a yarn/pnpm repo, so report the timeout honestly rather than corrupt-retrying.
    if last and last.get("timed_out"):
        return last, log, pm
    e = err_of(last)

    # 2) pnpm lockfile drift (lockfile out of sync with package.json)
    if pm == "pnpm" and shutil.which("pnpm") and ("lockfile" in e or "frozen" in e or "outdated" in e):
        r = attempt(["pnpm", "install", "--no-frozen-lockfile"],
                    "pnpm --no-frozen-lockfile (lockfile out of sync)")
        if r and r.get("rc") == 0:
            return r, log, pm
        last = r or last
        e = err_of(last)

    # 3) npm ERESOLVE peer-dependency conflict — the react/react case
    if ("eresolve" in e) or ("peer dep" in e) or ("could not resolve dependency" in e):
        r = attempt(["npm", "install", "--legacy-peer-deps", *NPM_FLAGS],
                    "npm --legacy-peer-deps (ERESOLVE peer conflict)")
        if r and r.get("rc") == 0:
            return r, log, pm
        last = r or last
        r = attempt(["npm", "install", "--force", *NPM_FLAGS],
                    "npm --force (peer conflict persisted)")
        if r and r.get("rc") == 0:
            return r, log, pm
        last = r or last
        e = err_of(last)

    # 4) universal fallback: npm can install almost any package.json even for a yarn/pnpm
    #    native repo; try the peer-conflict flags if the ladder hasn't already.
    if (not last or last.get("rc") != 0) and "--legacy-peer-deps" not in tried():
        r = attempt(["npm", "install", "--legacy-peer-deps", *NPM_FLAGS],
                    "npm --legacy-peer-deps (universal fallback)")
        if r and r.get("rc") == 0:
            return r, log, pm
        last = r or last
    if (not last or last.get("rc") != 0) and "--force" not in tried():
        r = attempt(["npm", "install", "--force", *NPM_FLAGS],
                    "npm --force (last resort)")
        if r and r.get("rc") == 0:
            return r, log, pm
        last = r or last

    return (last or {"ran": False, "reason": "no attempt fit the build budget"}), log, pm


# Env-var name prefixes/substrings that must NEVER reach the untrusted build/run.
_SENSITIVE_ENV_PREFIXES = ("CR_", "GOOGLE_", "GCP_", "SUPABASE_", "AWS_", "GH_", "GITHUB_", "VERTEX_")
_SENSITIVE_ENV_SUBSTR = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PRIVATE")


def _untrusted_env() -> dict[str, str]:
    """Environment for the UNTRUSTED build/run subprocess (security review, critical #1).

    The harness inherits real secrets — the Vertex service-account credential
    (GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_SERVICE_ACCOUNT_JSON), the attach-forensics
    runner key (CR_DEEP_RUNNER_KEY), the forge control key (CR_FORGE_CONTROL_KEY), and this
    scan's id (CR_SCAN_ID). Passing the container's raw env to the repo's own install/run
    commands hands ALL of that to attacker-controlled code (a real credential inside the
    blast radius, violating CLAUDE.md rail 2; and the scan id / control key that would let
    it blank its own forensics or re-open egress). This strips every secret-shaped variable
    while keeping what a normal build legitimately needs — PATH, HOME, locale, the forged-TLS
    CA bundle (SSL_CERT_FILE / REQUESTS_CA_BUNDLE / NODE_EXTRA_CA_CERTS), package-manager
    caches. Denylist (keep-by-default) so an ordinary build is never starved of a benign var."""
    out: dict[str, str] = {}
    for k, v in os.environ.items():
        ku = k.upper()
        if ku.startswith(_SENSITIVE_ENV_PREFIXES):
            continue
        if any(s in ku for s in _SENSITIVE_ENV_SUBSTR):
            continue
        out[k] = v
    return out


def _untrusted_user() -> str | None:
    """Optional unprivileged user to drop the untrusted build/run to (defense in depth
    for the /proc/1/environ + SA-key-file residual: an unprivileged process cannot read
    root's environ or the 0600 root credential file). OFF by default so the live
    detonation path is byte-identical until provisioning sets CR_UNTRUSTED_USER to a real
    user the image created (and chowns /repo to) — enabling it must be validated by a live
    detonation, never shipped blind. Returns None (current behavior) when unset."""
    u = os.environ.get("CR_UNTRUSTED_USER", "").strip()
    return u or None


def _run(cmd: list[str], timeout: int, trace_id: str = "", observe_syscalls: bool = True) -> dict:
    """Run a command, optionally under strace. strace -f ptrace-stops on EVERY syscall
    (huge overhead on a process-heavy npm/pip install), so the BUILD runs UNTRACED for
    speed — the gateway captures ALL network (install-time exfil included). strace is
    reserved for the short RUN phase, where it catches credential-file reads cheaply.

    The command is the UNTRUSTED repo's own install/run, so it runs with a SCRUBBED
    environment (no harness secrets — see _untrusted_env) and, when configured, as an
    unprivileged user (_untrusted_user)."""
    if not cmd:
        return {"ran": False, "reason": "no command"}
    trace = f"/tmp/cr-strace-{trace_id}.log" if trace_id else "/tmp/cr-strace.log"
    full = (["strace", "-f", "-e", "trace=openat,execve", "-o", trace, *cmd]
            if observe_syscalls else cmd)
    env = _untrusted_env()
    user = _untrusted_user()
    # subprocess.run accepts user= on Python 3.9+; pass it only when configured so the
    # default code path (no user=) is unchanged. Kept in a kwargs dict so both the traced
    # and the FileNotFound-fallback calls stay identical.
    extra = {"env": env}
    if user is not None:
        extra["user"] = user
    t0 = time.time()
    p = None
    try:
        p = subprocess.run(full, cwd=REPO_DIR, timeout=timeout, capture_output=True, **extra)
        rc, timed_out = p.returncode, False
    except subprocess.TimeoutExpired as e:
        rc, timed_out = None, True
        p = e  # TimeoutExpired carries any partial output captured before the timeout
    except FileNotFoundError:
        try:
            p = subprocess.run(cmd, cwd=REPO_DIR, timeout=timeout, capture_output=True, **extra)
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
    """Persist the observation LOCALLY (entrypoint.sh reads this after detonate.py
    exits and folds it into the final forensic record). Also best-effort POST it
    to the gateway's harness-telemetry host, mirroring the old guest's behavior —
    this is a secondary channel (the gateway may capture it in the one-shot
    /forensics readback as an extra http_request line), the local file is the
    PRIMARY and authoritative source the entrypoint relies on."""
    try:
        with open(OBSERVATION_PATH, "w", encoding="utf-8") as f:
            f.write(json.dumps(record))
    except OSError as e:
        print(f"CR_HARNESS observation write failed: {e}", file=sys.stderr, flush=True)
    body = json.dumps(record).encode("utf-8")
    try:
        req = urllib.request.Request(f"http://{TELEMETRY_HOST}/cr-telemetry", data=body, method="POST")
        urllib.request.urlopen(req, timeout=6).read(64)
    except Exception:  # noqa: BLE001 — best effort; the local file is authoritative
        pass


def report_stage(stage: str, detail: str = "") -> None:
    """Best-effort live progress report to /api/deep via the deep-queue edge
    function's set_stage op (see supabase/functions/deep-queue). Never raises —
    a lost report only means one missed UI tick, never a detonation impact."""
    if not (CR_SCAN_ID and CR_SUPABASE_URL and CR_DEEP_RUNNER_KEY):
        return
    try:
        headers = {"Content-Type": "application/json", "x-runner-key": CR_DEEP_RUNNER_KEY}
        if CR_SUPABASE_ANON_KEY:
            headers["apikey"] = CR_SUPABASE_ANON_KEY
            headers["Authorization"] = f"Bearer {CR_SUPABASE_ANON_KEY}"
        body = json.dumps({"op": "set_stage", "token": CR_SCAN_ID, "stage": stage, "detail": detail}).encode("utf-8")
        req = urllib.request.Request(
            f"{CR_SUPABASE_URL.rstrip('/')}/functions/v1/deep-queue",
            data=body,
            headers=headers,
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10).read(256)
    except Exception:  # noqa: BLE001 — best effort, observability only
        pass


def emit_phase_marker(phase: str) -> None:
    """Beacon the install-end/run-start boundary to the gateway through the SAME
    telemetry-host convention the old guest used (`cr-harness.cr.internal`),
    which the gateway addon (forge_addon.py) already recognizes and timestamps
    with its OWN wall clock (the same clock every other captured line gets) — so
    assemble-forensics.py can classify every captured attempt as build-phase
    (before this beacon) or run-phase (after), with no container/gateway clock-
    skew risk. Best-effort: a lost beacon means assemble-forensics.py sees no
    phase boundary and conservatively treats every captured attempt at full
    weight — the existing, safe behavior — so a dropped marker can only fail
    toward the STRONGER classification, never a softer one."""
    try:
        req = urllib.request.Request(
            f"http://{TELEMETRY_HOST}{PHASE_MARKER_PATH}",
            data=json.dumps({"phase": phase}).encode("utf-8"),
            method="POST",
        )
        urllib.request.urlopen(req, timeout=6).read(64)
    except Exception:  # noqa: BLE001 — best effort; a lost beacon fails toward full weight
        pass


def main() -> int:
    configure_egress()  # no-op on Cloud Run — see module docstring
    # POSITIVE containment evidence BEFORE the untrusted code runs: confirm the gateway
    # intercepts a direct-to-IP TCP egress attempt AND that a direct UDP egress attempt is
    # dropped (mitmproxy only redirects TCP — UDP must be blocked by the container's own
    # egress posture / the VPC firewall).
    contained = containment_probe()
    udp_contained = udp_egress_contained()
    print(f"CR_CONTAINMENT tcp_contained={contained} udp_contained={udp_contained}",
          file=sys.stderr, flush=True)
    raise_fd_limit()
    plant_decoys()
    # DIAGNOSTIC: what does the container resolve the registry to? (real IP = passthrough
    # path is healthy; a failure means the registry DNS/route isn't reaching the gateway).
    import socket as _socket
    for _h in ("registry.npmjs.org", "evil-c2.example"):
        try:
            _ips = sorted({a[4][0] for a in _socket.getaddrinfo(_h, 443, proto=_socket.IPPROTO_TCP)})
            print(f"CR_DNS {_h} -> {_ips}", file=sys.stderr, flush=True)
        except Exception as _e:  # noqa: BLE001
            print(f"CR_DNS {_h} FAILED: {type(_e).__name__}: {_e}", file=sys.stderr, flush=True)
    ptype, run_cmd = detect_project()
    # BUILD untraced (fast — the gateway captures install-time network); RUN traced (cheap).
    # Node goes through ADAPTIVE recovery (detect the PM + read the real error + retry with
    # the right flag) instead of one fixed command; python/unknown use a single install.
    build_strategies: list[dict] = []
    package_manager = ""
    if ptype == "node":
        build, build_strategies, package_manager = adaptive_node_build(BUILD_TIMEOUT)
    elif ptype == "python":
        build = _run(_pip_install(), BUILD_TIMEOUT, "build", observe_syscalls=False)
    else:
        build = {"ran": False, "reason": "no supported manifest"}
    print(f"CR_BUILD rc={build.get('rc')} timed_out={build.get('timed_out')} secs={build.get('secs')} "
          f"pm={package_manager} attempts={len(build_strategies)} "
          f"stderr_tail={build.get('stderr_tail','')[:900]!r}", file=sys.stderr, flush=True)

    # The strategy that actually installed the deps (transparency: the report/forensics can say
    # "built with npm --legacy-peer-deps", never silently loosen what "built" means) — and the
    # verbatim command, cited as the forensic record's `install_command`.
    winning = next((s for s in build_strategies if s.get("rc") == 0), None)
    install_command = (winning or {}).get("cmd", "") or (
        " ".join(_pip_install()) if ptype == "python" else "")

    # BUILD SCRIPT — a compiled app (Next.js/Vite/CRA/Angular/…) must run its OWN `build`
    # BEFORE its start script will boot: install alone left `next start` to exit immediately
    # with "no production build found", which the record then scored as "never reached a
    # runnable state" even though install + start were both fine. Running the real build is
    # what makes "we run it" true for a compiled app. It runs in the BUILD phase (before the
    # run_start marker) so any fetch it makes — a framework build's telemetry/font/CDN pulls —
    # is classified as build-time supply-chain, not a run-phase attack.
    build_script: dict = {"ran": False, "reason": "no build script / not a node build"}
    if ptype == "node" and build.get("rc") == 0:
        bcmd = _node_build_cmd(package_manager or detect_node_pm())
        if bcmd:
            report_stage("building", f"running `{' '.join(bcmd)}`")
            build_script = _run(bcmd, BUILD_TIMEOUT, "build", observe_syscalls=False)
            print(f"CR_BUILDSCRIPT {' '.join(bcmd)} -> rc={build_script.get('rc')} "
                  f"secs={build_script.get('secs')} timed_out={build_script.get('timed_out')} "
                  f"stderr_tail={build_script.get('stderr_tail','')[:600]!r}", file=sys.stderr, flush=True)

    # "Built" = deps installed AND (no build script, or the build script itself succeeded).
    install_ok = build.get("rc") == 0
    auto_build_succeeded = install_ok and (
        build_script.get("rc") == 0 if build_script.get("ran") else True)

    # The install is DONE and the run is about to start — beacon this exact boundary so
    # the host can tell a benign build-time dependency fetch apart from a genuine
    # run-phase network attempt (see emit_phase_marker + assemble-forensics.py).
    emit_phase_marker("run_start")
    report_stage("running", f"executing the repo's start command (pm={package_manager or 'n/a'})")
    run = _run(run_cmd, RUN_TIMEOUT, "run", observe_syscalls=True) if run_cmd else {"ran": False, "reason": "no run cmd"}
    obs = observe([build.get("trace", ""), run.get("trace", "")])

    # RAN WITHOUT CRASH — a long-lived server (a web app, an API, a daemon) is the COMMON case
    # and it is a CLEAN run: it boots and keeps serving, so it is still alive (timed_out) when
    # the fixed observation window closes. A CRASH is the opposite: it exits BEFORE the window
    # with a non-zero code. So a run is clean when it either exited 0 OR survived the whole
    # window without an error exit; only an early non-zero exit is a crash. The old
    # `not timed_out and rc==0` mislabelled every healthy server as a failed run — capping its
    # score — which is exactly why this project's own Next.js repo scored "not runnable" despite
    # building and serving fine. (A caught ATTACK is judged separately and still hard-caps the
    # score regardless of this, so "survived the window" can never launder malicious egress.)
    run_ran = bool(run.get("ran"))
    run_crashed = run_ran and not run.get("timed_out") and run.get("rc") not in (0, None)
    ran_without_crash = run_ran and not run_crashed

    record = {
        "schema": "claude-rabbit/in-guest-observation/1",
        "project_type": ptype,
        "package_manager": package_manager,
        "install_command": install_command,
        "run_command": " ".join(run_cmd) if run_cmd else "",
        "auto_build_succeeded": auto_build_succeeded,
        "build_strategy": (winning or {}).get("why", ""),
        "build_attempts": build_strategies,
        "build_script": build_script,
        "ran_without_crash": ran_without_crash,
        "build": build,
        "run": run,
        "observed": obs,
        "containment_probe_contained": contained,
        "udp_egress_contained": udp_contained,
        "t": round(time.time(), 3),
    }
    emit(record)
    print("CR_HARNESS_DONE " + json.dumps({k: record[k] for k in (
        "project_type", "package_manager", "auto_build_succeeded", "build_strategy",
        "ran_without_crash", "observed")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
