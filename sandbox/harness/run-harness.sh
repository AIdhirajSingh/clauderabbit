#!/usr/bin/env bash
#
# run-harness.sh — runs ON the ephemeral sandbox VM.
#
# Pipeline (the "we run it" core):
#   1. Unpack the pre-staged target repo (delivered as a tarball, so the RUN
#      phase needs zero egress — the clone already happened off-VM or pre-lock).
#   2. Detect project type (Node / Python / generic).
#   3. Attempt install/build UNATTENDED under observation (observe.py).
#   4. Attempt to run/start the project UNATTENDED under observation.
#   5. Emit a single merged behavior report JSON.
#
# All untrusted work runs as the unprivileged `runner` user, under a hard
# `timeout`, with ulimits, while the VM's egress is locked by firewall. The
# observer (observe.py) records network attempts, credential-path reads, spawned
# processes, CPU, and dropped files via a real strace of the process tree.
#
# Usage (invoked by the orchestrator over SSH). Two modes:
#
#   Single-shot (egress stays locked the whole time):
#     sudo run-harness.sh /path/to/target.tar.gz /path/to/out-report.json
#
#   Split-phase (monitored SINKHOLE):
#     BUILD reaches package registries ONLY, via the trap's allowlist proxy, so
#     normal repos install deps and build. RUN flips to the full sinkhole (DNS +
#     iptables DNAT to the trap) so every outbound call is intercepted and
#     recorded, and NO real packet reaches a real destination.
#     sudo run-harness.sh prepare /path/to/target.tar.gz   # unpack + detect
#     CR_PROXY=http://10.200.0.x:3128 sudo run-harness.sh build   # install via proxy
#     CR_TRAP_IP=10.200.0.x          sudo run-harness.sh run      # run under sinkhole
#     sudo run-harness.sh merge /path/to/out-report.json   # combine
#
#   Agentic detonation (Phase 2 — the agent brain's ONLY execution path):
#     run-target detonates ONE specific repo file the off-VM agent chose, under
#     the SAME sinkhole + observer + non-root runner as the RUN phase. It is the
#     fixed-grammar tool the agent's detonator.py relays into (audit C1/C2): the
#     agent never gets a free-form/root shell. Containment is RE-ASSERTED before
#     every detonation; uid-0 traffic bypasses the DNAT sink, so the target runs
#     as the unprivileged `runner` — running it as root would be an egress leak.
#     CR_TRAP_IP=10.200.0.x sudo run-harness.sh run-target <runtime> <repo-rel-path>
#       runtime  : one of node | python3 | sh  (fixed allowlist)
#       path     : a repo-relative file UNDER $WORK (no .., no absolute, no symlink)
set -uo pipefail   # NOTE: not -e; we WANT to continue past a failing build/run.

RUNNER_USER="runner"
WORK="/home/${RUNNER_USER}/target"
OBS="/opt/cr/observe.py"
FLIP="/opt/cr/sinkhole-flip.sh"
PLAN="/tmp/cr-plan.env"
BUILD_OUT="/tmp/cr-build.json"
RUN_OUT="/tmp/cr-run.json"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-240}"
RUN_TIMEOUT="${RUN_TIMEOUT:-60}"
# Build-phase allowlist proxy (registries only), provided by the orchestrator.
CR_PROXY="${CR_PROXY:-}"
# Run-phase sinkhole trap private IP, provided by the orchestrator.
CR_TRAP_IP="${CR_TRAP_IP:-}"

log() { echo "[harness] $*" >&2; }

# Dispatch: if $1 is a subcommand, run split-phase; else single-shot legacy.
SUBCMD="${1:-}"
case "$SUBCMD" in
  prepare|build|run|merge|run-target) ;;   # split-phase + agentic detonation
  *)
    # legacy single-shot: $1=tarball $2=out — run all phases locked, then merge.
    TARBALL="${1:?usage: run-harness.sh <target.tar.gz> <out.json>}"
    OUT="${2:?usage: run-harness.sh <target.tar.gz> <out.json>}"
    bash "$0" prepare "$TARBALL"
    bash "$0" build
    bash "$0" run
    bash "$0" merge "$OUT"
    exit 0
    ;;
esac

# ============================ PREPARE ======================================
if [ "$SUBCMD" = "prepare" ]; then
TARBALL="${2:?usage: run-harness.sh prepare <target.tar.gz>}"

# --- ensure unprivileged runner user exists, with a clean home -------------
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$RUNNER_USER"
fi
rm -rf "$WORK"
mkdir -p "$WORK"

# --- unpack target ----------------------------------------------------------
log "unpacking target into $WORK"
tar -xzf "$TARBALL" -C "$WORK" --strip-components=1 2>/dev/null \
  || tar -xzf "$TARBALL" -C "$WORK" 2>/dev/null \
  || { log "FAILED to unpack tarball"; }
chown -R "$RUNNER_USER":"$RUNNER_USER" "/home/${RUNNER_USER}"

# --- detect project type ----------------------------------------------------
PTYPE="unknown"
ENTRY=""
INSTALL_CMD=""
RUN_CMD=""
if [ -f "$WORK/package.json" ]; then
  PTYPE="node"
  # install runs lifecycle scripts (preinstall/postinstall) — exactly the
  # install-time-execution surface we must observe.
  INSTALL_CMD="npm install --no-audit --no-fund"
  # prefer a start script, else the "main" file, else index.js
  if grep -q '"start"' "$WORK/package.json" 2>/dev/null; then
    RUN_CMD="timeout 30 npm start"
  else
    # Read package.json.main with jq (reads the file as DATA, never as code) so
    # a malicious "main" value cannot inject into a shell/JS evaluation. Strip
    # any shell-dangerous characters from the resulting filename defensively.
    MAIN=$(jq -r '.main // "index.js"' "$WORK/package.json" 2>/dev/null || echo index.js)
    MAIN=$(printf '%s' "$MAIN" | tr -cd 'A-Za-z0-9._/-')
    [ -n "$MAIN" ] || MAIN="index.js"
    [ -f "$WORK/$MAIN" ] && RUN_CMD="node $(printf '%q' "$MAIN")" || RUN_CMD="true"
  fi
elif [ -f "$WORK/requirements.txt" ] || [ -f "$WORK/setup.py" ] || [ -f "$WORK/pyproject.toml" ]; then
  PTYPE="python"
  if [ -f "$WORK/requirements.txt" ]; then
    INSTALL_CMD="pip3 install --no-input -r requirements.txt"
  elif [ -f "$WORK/setup.py" ]; then
    INSTALL_CMD="pip3 install --no-input ."   # runs setup.py — install-time surface
  else
    INSTALL_CMD="pip3 install --no-input ."
  fi
  if [ -f "$WORK/main.py" ]; then RUN_CMD="python3 main.py"
  elif [ -f "$WORK/app.py" ]; then RUN_CMD="python3 app.py"
  else RUN_CMD="true"; fi
elif [ -f "$WORK/Makefile" ]; then
  PTYPE="make"
  INSTALL_CMD="make"
  RUN_CMD="true"
else
  PTYPE="unknown"
  INSTALL_CMD="true"
  RUN_CMD="true"
fi
log "detected project type: $PTYPE"
log "install: $INSTALL_CMD"
log "run:     $RUN_CMD"

# persist the plan so build/run sub-invocations reuse the same detection
{
  echo "PTYPE=$(printf '%q' "$PTYPE")"
  echo "INSTALL_CMD=$(printf '%q' "$INSTALL_CMD")"
  echo "RUN_CMD=$(printf '%q' "$RUN_CMD")"
} > "$PLAN"
chown -R "$RUNNER_USER":"$RUNNER_USER" "/home/${RUNNER_USER}"
log "prepare complete; plan at $PLAN"
exit 0
fi

# ============================ BUILD ========================================
if [ "$SUBCMD" = "build" ]; then
[ -f "$PLAN" ] || { log "no plan; run prepare first"; exit 2; }
# shellcheck disable=SC1090
source "$PLAN"
log "=== BUILD phase (registry-allowlist proxy; observing) ==="

# Point the package managers at the trap's allowlist proxy so they can fetch
# declared deps from registries ONLY. The detonation VM still has NO direct
# internet egress (deny-1000) and NO route to anything but the trap subnet;
# the proxy is the sole build-phase path out and it refuses non-registry hosts.
# A malicious preinstall/postinstall that tries to reach a non-registry host
# through the proxy is REFUSED by squid and recorded.
PROXY_ENV=""
if [ -n "$CR_PROXY" ]; then
  log "build proxy: $CR_PROXY (registries only)"
  PROXY_ENV="http_proxy=$CR_PROXY https_proxy=$CR_PROXY HTTP_PROXY=$CR_PROXY HTTPS_PROXY=$CR_PROXY \
npm_config_proxy=$CR_PROXY npm_config_https_proxy=$CR_PROXY \
PIP_PROXY=$CR_PROXY no_proxy=127.0.0.1,localhost"
else
  log "no build proxy provided; build runs with no egress (deps requiring network will fail)"
fi

sudo -u "$RUNNER_USER" -H env $PROXY_ENV python3 "$OBS" \
  --out "$BUILD_OUT" --phase build --timeout "$BUILD_TIMEOUT" --cpu-seconds 200 \
  --workdir "$WORK" -- bash -lc "$INSTALL_CMD" >/dev/null 2>&1 || true
log "build phase complete -> $BUILD_OUT"
exit 0
fi

# ============================ RUN ==========================================
if [ "$SUBCMD" = "run" ]; then
[ -f "$PLAN" ] || { log "no plan; run prepare first"; exit 2; }
# shellcheck disable=SC1090
source "$PLAN"

# FLIP to the full sinkhole BEFORE any run-phase untrusted code executes:
# DNS -> trap, iptables DNAT all outbound -> trap. This is containment layer 2
# (the VPC deny-1000 firewall is layer 1, the fail-closed backstop). The flip
# script asserts containment and ABORTS if the DNAT/resolv.conf are not in place.
if [ -n "$CR_TRAP_IP" ] && [ -x "$FLIP" ]; then
  log "=== flipping to SINKHOLE (DNS+DNAT -> trap $CR_TRAP_IP) ==="
  bash "$FLIP" run "$CR_TRAP_IP" || { log "FATAL: sinkhole flip/assert failed — refusing to run"; exit 3; }
else
  log "WARNING: no trap IP or flip script; run proceeds with egress lockdown only (no sinkhole capture)"
fi

log "=== RUN phase (SINKHOLE active; observing) ==="
sudo -u "$RUNNER_USER" -H python3 "$OBS" \
  --out "$RUN_OUT" --phase run --timeout "$RUN_TIMEOUT" --cpu-seconds 50 \
  --workdir "$WORK" -- bash -lc "$RUN_CMD" >/dev/null 2>&1 || true
log "run phase complete -> $RUN_OUT"
exit 0
fi

# ====================== RUN-TARGET (agentic detonation) ====================
# Detonate ONE agent-chosen repo file under the sinkhole + observer, as the
# non-root `runner`. This is the fixed-grammar execution path the off-VM agent's
# detonator.py relays into (audit C1/C2). The agent NEVER gets a free-form or
# root shell: runtime is allowlisted, the path is validated to live under $WORK
# (no traversal, no absolute, no symlink escape), and containment is re-asserted
# before the target runs. uid-0 traffic bypasses the DNAT sink, so the target is
# launched as `runner` — running it as root would be an egress leak (audit C1).
if [ "$SUBCMD" = "run-target" ]; then
RT_RUNTIME="${2:-}"
RT_PATH="${3:-}"
[ -n "$RT_RUNTIME" ] && [ -n "$RT_PATH" ] \
  || { log "usage: run-harness.sh run-target <node|python3|sh> <repo-relative-path>"; exit 2; }

# --- 1. fixed runtime grammar (allowlist) -----------------------------------
case "$RT_RUNTIME" in
  node|python3|sh) ;;
  *) log "FATAL: invalid runtime '$RT_RUNTIME' (allowed: node, python3, sh)"; exit 3 ;;
esac

# --- 2. path validation: must be a real file UNDER $WORK --------------------
# Reject absolute paths, parent-dir traversal, and anything that resolves
# outside $WORK (a symlink escape). We compare REALPATHs so a symlink that
# points out of the repo is caught. Untrusted repo bytes never reach a shell.
case "$RT_PATH" in
  /*)  log "FATAL: target path must be repo-relative, not absolute: '$RT_PATH'"; exit 3 ;;
  *..*) log "FATAL: target path must not contain '..': '$RT_PATH'"; exit 3 ;;
esac
WORK_REAL="$(realpath -m "$WORK" 2>/dev/null || echo "$WORK")"
TARGET_ABS="$WORK/$RT_PATH"
TARGET_REAL="$(realpath -m "$TARGET_ABS" 2>/dev/null || echo "$TARGET_ABS")"
case "$TARGET_REAL" in
  "$WORK_REAL"/*) ;;   # good: strictly under the work dir
  *) log "FATAL: target escapes the work dir: '$RT_PATH' -> '$TARGET_REAL'"; exit 3 ;;
esac
# Refuse a symlink itself (could point outside even if realpath -m didn't flag),
# and require the resolved file to actually exist as a regular file.
if [ -L "$TARGET_ABS" ]; then
  log "FATAL: target is a symlink (refused): '$RT_PATH'"; exit 3
fi
[ -f "$TARGET_REAL" ] || { log "FATAL: target is not a regular file: '$RT_PATH'"; exit 3; }

# --- 3. re-assert containment FIRST — refuse if the sink is not in place -----
# NEVER run a target without a passing containment assert. If the VM was already
# flipped to the sinkhole, `assert` re-verifies it; if not, `run` applies+asserts.
# Either way a non-zero return aborts BEFORE any untrusted code executes (exit 3).
if [ -x "$FLIP" ]; then
  if bash "$FLIP" assert "$CR_TRAP_IP" 2>/dev/null; then
    log "containment re-asserted (already flipped to sinkhole)."
  elif [ -n "$CR_TRAP_IP" ]; then
    log "not yet flipped; applying sinkhole + asserting (trap $CR_TRAP_IP)"
    bash "$FLIP" run "$CR_TRAP_IP" \
      || { log "FATAL: sinkhole flip/assert failed — refusing to detonate"; exit 3; }
  else
    log "FATAL: containment not in place and no CR_TRAP_IP to flip — refusing to detonate"; exit 3
  fi
else
  log "FATAL: sinkhole-flip script missing — refusing to detonate without containment"; exit 3
fi

# --- 4. detonate as the NON-ROOT runner, under the observer ------------------
# A per-target observation JSON so concurrent/sequential detonations never clash.
RT_N="${CR_RUN_N:-$$}"
RT_OUT="/tmp/cr-run-${RT_N}.json"
log "=== DETONATE (run-target): $RT_RUNTIME $RT_PATH as runner, sinkhole active ==="
sudo -u "$RUNNER_USER" -H python3 "$OBS" \
  --out "$RT_OUT" --phase run --timeout "$RUN_TIMEOUT" --cpu-seconds 50 \
  --workdir "$WORK" -- "$RT_RUNTIME" "$TARGET_REAL" >/dev/null 2>&1 || true
log "run-target complete -> $RT_OUT"
# Print the path of the per-target observation JSON (the agent collects this).
echo "$RT_OUT"
exit 0
fi

# ============================ MERGE ========================================
if [ "$SUBCMD" = "merge" ]; then
OUT="${2:?usage: run-harness.sh merge <out.json>}"
[ -f "$PLAN" ] || { log "no plan; run prepare first"; exit 2; }
# shellcheck disable=SC1090
source "$PLAN"
log "merging phase reports -> $OUT"
python3 - "$BUILD_OUT" "$RUN_OUT" "$OUT" "$PTYPE" "$INSTALL_CMD" "$RUN_CMD" <<'PY'
import json, sys
build_p, run_p, out_p, ptype, install_cmd, run_cmd = sys.argv[1:7]
def load(p):
    try:
        with open(p) as f: return json.load(f)
    except Exception as e:
        return {"error": f"missing or unreadable: {e}"}
build = load(build_p)
run = load(run_p)

def obs(d): return d.get("observations", {}) if isinstance(d, dict) else {}
b, r = obs(build), obs(run)

def merge_list(k):
    return (b.get(k, []) or []) + (r.get(k, []) or [])

merged = {
    "schema": "claude-rabbit/behavior-report@1",
    "project_type": ptype,
    "install_command": install_cmd,
    "run_command": run_cmd,
    "build_phase": build,
    "run_phase": run,
    "build_exit_code": build.get("exit_code"),
    "run_exit_code": run.get("exit_code"),
    # auto-build success = install completed (rc 0, not timeout) for a known type
    "auto_build_succeeded": bool(
        ptype != "unknown"
        and build.get("exit_code") == 0
        and not build.get("timed_out")
    ),
    "ran_without_crash": bool(
        run.get("exit_code") in (0, None) and not run.get("timed_out")
    ),
    "aggregate_observations": {
        "network_attempts": merge_list("network_attempts"),
        "network_attempt_count": b.get("network_attempt_count", 0) + r.get("network_attempt_count", 0),
        "internet_attempt_count": b.get("internet_attempt_count", 0) + r.get("internet_attempt_count", 0),
        "network_blocked_count": b.get("network_blocked_count", 0) + r.get("network_blocked_count", 0),
        "outbound_internet_attempted": bool(b.get("outbound_internet_attempted") or r.get("outbound_internet_attempted")),
        # phase split: outbound during the RUN phase (after install) is a strong
        # malicious signal; outbound during BUILD is often just dependency fetch.
        "build_internet_attempt_count": b.get("internet_attempt_count", 0),
        "run_internet_attempt_count": r.get("internet_attempt_count", 0),
        "run_outbound_attempted": bool(r.get("outbound_internet_attempted")),
        # Sinkholed (intercepted-and-redirected-to-trap) egress attempts. RUN-
        # phase sinkholed traffic is the captured attack (true intent on trap).
        "sinkholed_attempt_count": b.get("sinkholed_attempt_count", 0) + r.get("sinkholed_attempt_count", 0),
        "run_sinkholed_attempt_count": r.get("sinkholed_attempt_count", 0),
        "egress_intercepted_or_blocked": bool(b.get("egress_intercepted_or_blocked") or r.get("egress_intercepted_or_blocked")),
        "egress_blocked_confirmed": bool(b.get("egress_blocked_confirmed") or r.get("egress_blocked_confirmed")),
        "exfil_blocked_app_signal": bool(b.get("exfil_blocked_app_signal") or r.get("exfil_blocked_app_signal")),
        "credential_reads": merge_list("credential_reads"),
        "credential_read_count": b.get("credential_read_count", 0) + r.get("credential_read_count", 0),
        "credential_read_succeeded": b.get("credential_read_succeeded", 0) + r.get("credential_read_succeeded", 0),
        "high_value_cred_read_count": b.get("high_value_cred_read_count", 0) + r.get("high_value_cred_read_count", 0),
        "high_value_cred_read_succeeded": b.get("high_value_cred_read_succeeded", 0) + r.get("high_value_cred_read_succeeded", 0),
        "exec_count": b.get("exec_count", 0) + r.get("exec_count", 0),
        "suspicious_binaries": sorted(set(b.get("suspicious_binaries", []) + r.get("suspicious_binaries", []))),
        "files_dropped_count": b.get("files_dropped_count", 0) + r.get("files_dropped_count", 0),
        "files_dropped": merge_list("files_dropped"),
        # Sustained CPU in the RUN phase is the mining signal; brief CPU during
        # the BUILD/install phase (npm/pip resolving deps) is expected and not
        # flagged. We require the run phase to both pin a core AND last long
        # enough to look like sustained work, not a quick startup spike.
        "run_cpu_cores_busy": r.get("cpu_cores_busy", 0) or 0,
        "run_elapsed_seconds": run.get("elapsed_seconds", 0) or 0,
        "high_cpu": bool(
            (r.get("cpu_cores_busy", 0) or 0) >= 0.85
            and (run.get("elapsed_seconds", 0) or 0) >= 10
        ),
        "max_cpu_cores_busy": max(b.get("cpu_cores_busy", 0) or 0, r.get("cpu_cores_busy", 0) or 0),
        "max_cpu_busy_fraction": max(b.get("cpu_busy_fraction", 0) or 0, r.get("cpu_busy_fraction", 0) or 0),
    },
}
with open(out_p, "w") as f:
    json.dump(merged, f, indent=2)
print(json.dumps(merged, indent=2))
PY

log "harness complete; report at $OUT"
exit 0
fi
