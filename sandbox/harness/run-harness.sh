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
#   Split-phase (orchestrator opens registry egress for build, then locks it
#   before the run — distinguishes "fetch declared deps" from "exfiltrate"):
#     sudo run-harness.sh prepare /path/to/target.tar.gz   # unpack + detect
#     sudo run-harness.sh build                            # install phase
#     sudo run-harness.sh run                              # run phase
#     sudo run-harness.sh merge /path/to/out-report.json   # combine
set -uo pipefail   # NOTE: not -e; we WANT to continue past a failing build/run.

RUNNER_USER="runner"
WORK="/home/${RUNNER_USER}/target"
OBS="/opt/cr/observe.py"
PLAN="/tmp/cr-plan.env"
BUILD_OUT="/tmp/cr-build.json"
RUN_OUT="/tmp/cr-run.json"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-240}"
RUN_TIMEOUT="${RUN_TIMEOUT:-60}"

log() { echo "[harness] $*" >&2; }

# Dispatch: if $1 is a subcommand, run split-phase; else single-shot legacy.
SUBCMD="${1:-}"
case "$SUBCMD" in
  prepare|build|run|merge) ;;   # split-phase
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
    MAIN=$(node -e "try{process.stdout.write(require('$WORK/package.json').main||'index.js')}catch(e){process.stdout.write('index.js')}" 2>/dev/null || echo index.js)
    [ -f "$WORK/$MAIN" ] && RUN_CMD="node $MAIN" || RUN_CMD="true"
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
log "=== BUILD phase (egress per orchestrator; observing) ==="
sudo -u "$RUNNER_USER" -H python3 "$OBS" \
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
log "=== RUN phase (egress LOCKED; observing) ==="
sudo -u "$RUNNER_USER" -H python3 "$OBS" \
  --out "$RUN_OUT" --phase run --timeout "$RUN_TIMEOUT" --cpu-seconds 50 \
  --workdir "$WORK" -- bash -lc "$RUN_CMD" >/dev/null 2>&1 || true
log "run phase complete -> $RUN_OUT"
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
