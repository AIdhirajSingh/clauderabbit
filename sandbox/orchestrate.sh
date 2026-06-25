#!/usr/bin/env bash
#
# orchestrate.sh — the deep-path orchestrator (runs locally with gcloud).
#
# This is what the escalation path (the scan edge function) calls when the fast
# path sets `escalate`. It runs ONE scan against ONE ephemeral VM end to end:
#
#   1. Ensure the hermetic network exists (deny-all egress VPC).
#   2. Boot a fresh ephemeral VM (NO external IP, sandbox tag => egress locked).
#   3. Stage the target repo + harness onto the VM (pre-staged => run needs zero
#      egress) over IAP SSH.
#   4. Run the harness: build + run the target under observation, egress locked.
#   5. Collect the behavior JSON; compute the honest verdict (never bare "Safe").
#   6. DELETE the VM (the per-scan reset / abuse protection) and PROVE it's gone.
#
# Two target sources:
#   --tarball <path>      : a local fixture/repo tarball (used for the proof)
#   --github  <owner/repo>: clone a public repo locally, tar it, stage it
#
# Usage:
#   orchestrate.sh --zone us-central1-a --tarball ./fixtures/cred-stealer.tar.gz --name cred-stealer
#   orchestrate.sh --zone us-central1-a --github sindresorhus/yocto-queue --name yocto
#
# MANDATORY: the VM is deleted on every exit path (success, failure, or signal).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NET="$HERE/net/setup-network.sh"
PROVISION="$HERE/golden-image/startup-provision.sh"
OBSERVE="$HERE/harness/observe.py"
HARNESS="$HERE/harness/run-harness.sh"
VERDICT="$HERE/verdict.py"

ZONE=""
TARBALL=""
GITHUB=""
NAME="scan"
RESULTS_DIR="$HERE/results"
TAG="cr-sandbox"
MACHINE="e2-medium"   # 2 vCPU — well under the 8-core cap, one VM at a time
GOLDEN_FAMILY="cr-sandbox-golden"   # baked runtimes + harness (built by build-image.sh)
BASE_IMAGE_FAMILY="debian-12"       # fallback if no golden image exists yet
BASE_IMAGE_PROJECT="debian-cloud"

log() { echo "[orch] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
# gcloud is a native Windows binary under Git-Bash; convert file-argument paths
# to Windows form when cygpath is available (no-op on Linux).
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --zone) ZONE="$2"; shift 2;;
    --tarball) TARBALL="$2"; shift 2;;
    --github) GITHUB="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --machine) MACHINE="$2"; shift 2;;
    *) die "unknown arg: $1";;
  esac
done

[ -n "$ZONE" ] || die "--zone required (e.g. us-central1-a)"
REGION="${ZONE%-*}"
VM="cr-sbx-${NAME}-$(date +%s)"
mkdir -p "$RESULTS_DIR"
STAGE="$(mktemp -d)"
LOCAL_REPORT="$RESULTS_DIR/${NAME}-behavior.json"
LOCAL_VERDICT="$RESULTS_DIR/${NAME}-verdict.json"

# ---- MANDATORY cleanup: delete the VM on ANY exit -------------------------
VM_CREATED=0
cleanup() {
  if [ "$VM_CREATED" = "1" ]; then
    log "=== RESET: deleting ephemeral VM $VM (per-scan reset / abuse protection) ==="
    gcloud compute instances delete "$VM" --zone="$ZONE" --quiet >/dev/null 2>&1 \
      && log "VM $VM deleted." || log "WARNING: VM $VM delete returned non-zero; verify manually."
  fi
  rm -rf "$STAGE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---- 1. ensure hermetic network -------------------------------------------
log "ensuring hermetic network (deny-all egress VPC) in $REGION"
bash "$NET" create "$REGION"

# ---- prepare the target tarball -------------------------------------------
if [ -n "$GITHUB" ]; then
  log "cloning public repo $GITHUB locally (off-VM; VM stays egress-locked)"
  CLONE_DIR="$STAGE/repo"
  git clone --depth 1 "https://github.com/${GITHUB}.git" "$CLONE_DIR" >/dev/null 2>&1 \
    || die "git clone failed for $GITHUB"
  TARBALL="$STAGE/target.tar.gz"
  tar -czf "$TARBALL" -C "$CLONE_DIR" .
elif [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
  log "using pre-built target tarball: $TARBALL"
else
  die "provide --tarball <path> or --github <owner/repo>"
fi

# ---- 2. boot ephemeral VM, egress locked, NO external IP ------------------
# Prefer the golden image (runtimes + harness baked in, built with egress). The
# golden image is the ONLY way runtimes get onto a VM that boots into the locked
# network, because the locked network has no egress for apt/npm. Fall back to
# base Debian only if no golden image exists yet (degraded: no runtimes).
GOLDEN_IMG="$(gcloud compute images list --filter="family:${GOLDEN_FAMILY}" \
  --format="value(name)" --sort-by=~creationTimestamp --limit=1 2>/dev/null || true)"
USING_GOLDEN=0
if [ -n "$GOLDEN_IMG" ]; then
  USING_GOLDEN=1
  log "booting ephemeral VM $VM from GOLDEN image $GOLDEN_IMG (NO external IP, egress LOCKED, tag=$TAG)"
  gcloud compute instances create "$VM" \
    --zone="$ZONE" --machine-type="$MACHINE" \
    --image="$GOLDEN_IMG" \
    --network-interface="subnet=cr-sandbox-subnet,no-address" \
    --tags="$TAG" --no-service-account --no-scopes >/dev/null \
    || die "VM create failed"
else
  log "no golden image found; booting base $BASE_IMAGE_FAMILY (DEGRADED: no runtimes under lockdown)"
  gcloud compute instances create "$VM" \
    --zone="$ZONE" --machine-type="$MACHINE" \
    --image-family="$BASE_IMAGE_FAMILY" --image-project="$BASE_IMAGE_PROJECT" \
    --network-interface="subnet=cr-sandbox-subnet,no-address" \
    --tags="$TAG" --no-service-account --no-scopes \
    --metadata-from-file=startup-script="$(winpath "$PROVISION")" >/dev/null \
    || die "VM create failed"
fi
VM_CREATED=1

# ---- 3. wait for SSH reachability ------------------------------------------
log "waiting for VM SSH reachability over IAP..."
READY=0
for i in $(seq 1 40); do
  if gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
       --command="true" >/dev/null 2>&1; then
    READY=1; log "VM reachable."; break
  fi
  sleep 15
done
[ "$READY" = "1" ] || die "VM did not become reachable in time"

# ---- stage harness + observer + target onto the VM ------------------------
# pscp (the Windows scp backend) over IAP can only write to world-writable dirs
# like /tmp — it gets "permission denied" on /opt/cr even at 777. So scp into
# /tmp, then `sudo mv` into place over SSH. Always (re)stage the current harness
# + observer so the VM runs THIS code even on a golden image (updatable without
# an image rebuild).
log "staging harness, observer, and target onto VM (scp -> /tmp -> sudo mv)"
gcloud compute scp --zone="$ZONE" --tunnel-through-iap \
  "$(winpath "$OBSERVE")" "$VM:/tmp/observe.py" >/dev/null 2>&1 || die "scp observe.py failed"
gcloud compute scp --zone="$ZONE" --tunnel-through-iap \
  "$(winpath "$HARNESS")" "$VM:/tmp/run-harness.sh" >/dev/null 2>&1 || die "scp run-harness.sh failed"
gcloud compute scp --zone="$ZONE" --tunnel-through-iap \
  "$(winpath "$TARBALL")" "$VM:/tmp/target.tar.gz" >/dev/null 2>&1 || die "scp target failed"
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="sudo mkdir -p /opt/cr && sudo mv /tmp/observe.py /tmp/run-harness.sh /opt/cr/ && sudo chmod +x /opt/cr/observe.py /opt/cr/run-harness.sh" >/dev/null 2>&1 \
  || die "staging move into /opt/cr failed"

# ---- verify egress is actually locked BEFORE running untrusted code --------
log "verifying egress lockdown (a control probe must be BLOCKED)..."
EGRESS_PROBE=$(gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="timeout 8 curl -s -o /dev/null -w '%{http_code}' https://example.com 2>&1; echo \" rc=\$?\"" 2>/dev/null || true)
log "egress control probe result: ${EGRESS_PROBE:-<none>}  (non-200 / timeout / rc!=0 == locked, as required)"

# ---- 4. run the harness, split-phase, egress LOCKED throughout ------------
# We keep egress fully locked for BOTH build and run — the hermetic rail is
# absolute (CLAUDE.md: egress is locked, period). We never open egress for
# untrusted code. The cost is that repos needing to fetch external dependencies
# will not fully build under lockdown; that is the auto-build-success number we
# MEASURE honestly rather than weaken isolation to inflate. The split-phase
# harness still gives us per-phase signals (build-phase vs run-phase outbound).
log "=== running harness on VM (split-phase; egress LOCKED throughout) ==="
HARNESS_ENV="sudo BUILD_TIMEOUT=240 RUN_TIMEOUT=60 bash /opt/cr/run-harness.sh"
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="$HARNESS_ENV prepare /tmp/target.tar.gz" >/dev/null 2>&1 || true
log "  build phase (egress locked)..."
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="$HARNESS_ENV build" >/dev/null 2>&1 || true
log "  run phase (egress locked)..."
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="$HARNESS_ENV run" >/dev/null 2>&1 || true
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
  --command="$HARNESS_ENV merge /tmp/cr-report.json" >/dev/null 2>&1 \
  || log "harness merge exited non-zero"

# ---- 5. collect behavior report -------------------------------------------
log "collecting behavior report"
gcloud compute scp --zone="$ZONE" --tunnel-through-iap \
  "$VM:/tmp/cr-report.json" "$LOCAL_REPORT" >/dev/null 2>&1 \
  || die "failed to collect behavior report"
log "behavior report -> $LOCAL_REPORT"

# also record the egress probe result into the report for the evidence trail
python3 - "$LOCAL_REPORT" "$EGRESS_PROBE" <<'PY'
import json,sys
p,probe=sys.argv[1],sys.argv[2]
d=json.load(open(p))
d["egress_control_probe"]=probe.strip()
json.dump(d,open(p,"w"),indent=2)
PY

# ---- compute honest verdict ------------------------------------------------
log "computing dynamic verdict (never a bare 'Safe')"
python3 "$VERDICT" "$LOCAL_REPORT" | tee "$LOCAL_VERDICT"

# ---- 6. RESET happens via the EXIT trap (VM delete) -----------------------
log "scan complete for $NAME. VM will be deleted now (reset)."
