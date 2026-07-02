#!/usr/bin/env bash
# benchmark-pool.sh — measure REAL wall-clock time to reach "detonation-ready" for the three
# ways the on-demand pool can bring capacity online, so create-pool.sh's standby choice is
# grounded in measured numbers, not the vendor's "several times faster" hand-wave.
#
# "Detonation-ready" = the exact state orchestrate-microvm.sh needs before it can detonate:
#   SSH up  &&  /dev/kvm present  &&  containerd active  &&  cr-detonation-base image PRESENT
# (the last one is the long pole — cr-base-image.service rebuilds it onto the fresh boot pool).
#
# Measures, on a throwaway instance booted from the golden image:
#   (a) COLD create-from-template  — fresh instance -> ready
#   (b) START from STOPPED         — stop it, then start -> ready
#   (c) RESUME from SUSPENDED      — suspend it, then resume -> ready (may be UNSUPPORTED on
#                                    nested-virt; we discover that by trying, not by assuming)
# Deletes the throwaway instance at the end (cost discipline). Prints CR_BENCH_* result lines.
#
# Usage: bash sandbox/microvm/benchmark-pool.sh
set -uo pipefail
PROJECT="${CR_GCP_PROJECT:-gen-lang-client-0062239756}"
ZONE="${CR_POOL_ZONE:-${CR_SANDBOX_ZONE:-us-east1-b}}"
MACHINE="${CR_HOST_MACHINE:-n2-standard-4}"
SA="${CR_HOST_SA:-clauderabbit-vertex@${PROJECT}.iam.gserviceaccount.com}"
IMG_FAMILY="${CR_GOLDEN_FAMILY:-cr-detonation-golden}"
INST="${CR_BENCH_INST:-cr-bench-$(date -u +%H%M%S)}"

log(){ echo "[bench] $*" >&2; }
g(){ gcloud --project "$PROJECT" "$@"; }
ssh_ready(){ printf 'y\n' | g compute ssh "$INST" --zone "$ZONE" --quiet --command "$1" 2>/dev/null | tr -d '\r'; }

# Poll until fully detonation-ready; echoes seconds waited (from the caller's T0).
wait_ready(){
  local t0="$1" i out
  for i in $(seq 1 90); do
    out="$(ssh_ready '
      [ -e /dev/kvm ] || exit 1
      systemctl is-active --quiet containerd || exit 1
      sudo /usr/local/bin/nerdctl images cr-detonation-base --format "{{.Repository}}" 2>/dev/null | grep -q cr-detonation-base || exit 1
      echo CR_READY' 2>/dev/null)"
    if echo "$out" | grep -q CR_READY; then echo $(( $(date +%s) - t0 )); return 0; fi
    sleep 3
  done
  echo -1; return 1
}

cleanup(){ log "deleting benchmark instance $INST"; g compute instances delete "$INST" --zone "$ZONE" --quiet >/dev/null 2>&1 || true; }
trap cleanup EXIT

GOLDEN="$(g compute images describe-from-family "$IMG_FAMILY" --format='value(name)' 2>/dev/null)"
[ -n "$GOLDEN" ] || { log "no golden image in family $IMG_FAMILY"; exit 1; }
log "benchmark instance $INST in $ZONE from golden $GOLDEN"

# ── (a) COLD create-from-template/image ──────────────────────────────────────────────
log "=== (a) COLD create-from-image ==="
T0=$(date +%s)
g compute instances create "$INST" \
  --zone "$ZONE" --machine-type "$MACHINE" --enable-nested-virtualization \
  --image "$GOLDEN" --boot-disk-size 100GB --boot-disk-type pd-balanced \
  --service-account "$SA" --scopes cloud-platform --metadata enable-oslogin=FALSE \
  --labels purpose=cr-bench >/dev/null 2>&1 || { log "create failed"; exit 1; }
COLD="$(wait_ready "$T0")"
echo "CR_BENCH_COLD_CREATE_READY_S=$COLD"

# ── (b) START from STOPPED ───────────────────────────────────────────────────────────
log "=== (b) STOP then START ==="
g compute instances stop "$INST" --zone "$ZONE" --quiet >/dev/null 2>&1 || log "stop failed"
T0=$(date +%s)
g compute instances start "$INST" --zone "$ZONE" --quiet >/dev/null 2>&1 || log "start failed"
STARTS="$(wait_ready "$T0")"
echo "CR_BENCH_START_FROM_STOPPED_READY_S=$STARTS"

# ── (c) RESUME from SUSPENDED (may be unsupported on nested virt — discover it) ───────
log "=== (c) SUSPEND then RESUME ==="
SUSPEND_ERR="$(g compute instances suspend "$INST" --zone "$ZONE" --quiet 2>&1 || true)"
if echo "$SUSPEND_ERR" | grep -qiE 'error|not supported|cannot|invalid'; then
  echo "CR_BENCH_SUSPEND_SUPPORTED=no"
  echo "CR_BENCH_SUSPEND_ERR=$(echo "$SUSPEND_ERR" | tr '\n' ' ' | head -c 300)"
else
  # confirm it actually reached SUSPENDED
  for i in $(seq 1 40); do
    st="$(g compute instances describe "$INST" --zone "$ZONE" --format='value(status)' 2>/dev/null)"
    [ "$st" = SUSPENDED ] && break; sleep 3
  done
  if [ "${st:-}" = SUSPENDED ]; then
    echo "CR_BENCH_SUSPEND_SUPPORTED=yes"
    T0=$(date +%s)
    g compute instances resume "$INST" --zone "$ZONE" --quiet >/dev/null 2>&1 || log "resume failed"
    RESUME="$(wait_ready "$T0")"
    echo "CR_BENCH_RESUME_FROM_SUSPENDED_READY_S=$RESUME"
  else
    echo "CR_BENCH_SUSPEND_SUPPORTED=partial status=${st:-unknown}"
  fi
fi

log "=== benchmark complete (instance will be deleted by trap) ==="
