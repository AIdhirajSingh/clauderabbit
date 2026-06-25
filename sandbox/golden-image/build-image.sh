#!/usr/bin/env bash
#
# build-image.sh — PRODUCTION path: bake a reusable golden image.
#
# Boots a builder VM, runs startup-provision.sh to install runtimes + harness,
# waits for completion, then captures a custom image `cr-sandbox-golden-<ts>`
# and DELETES the builder VM. The image is then used by orchestrate.sh as the
# boot source for ephemeral per-scan VMs (faster boot, no per-scan apt install).
#
# For the live PROOF we use the ephemeral-VM-with-startup-script path instead
# (orchestrate.sh --provision-inline), since that exercises the exact same
# isolation + reset and avoids leaving a builder VM around. This script is the
# documented production path and is safe to run when an image is wanted.
#
# Usage: build-image.sh <zone>   (e.g. us-central1-a)
set -euo pipefail

ZONE="${1:?usage: build-image.sh <zone, e.g. us-central1-a>}"
REGION="${ZONE%-*}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SANDBOX_ROOT="$(cd "$HERE/.." && pwd)"
BUILDER="cr-golden-builder-$(date +%s)"
IMAGE="cr-sandbox-golden-$(date +%Y%m%d-%H%M%S)"
MACHINE="e2-small"   # smallest viable; image build is light
BASE_IMAGE_FAMILY="debian-12"
BASE_IMAGE_PROJECT="debian-cloud"

log() { echo "[build-image] $*" >&2; }
# gcloud is a native Windows binary under Git-Bash; it needs Windows-style paths
# for file arguments. Convert if cygpath is available, else pass through (Linux).
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
cleanup() {
  log "deleting builder VM $BUILDER (mandatory cleanup)"
  gcloud compute instances delete "$BUILDER" --zone="$ZONE" --quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Builder boots on the DEFAULT network WITH an external IP so provisioning has
# full egress (apt, NodeSource, pip). This is the only phase that needs egress;
# the resulting image is then booted into the locked network for actual scans.
log "booting builder VM $BUILDER ($MACHINE, $BASE_IMAGE_FAMILY) in $ZONE (egress OPEN for provisioning)"
gcloud compute instances create "$BUILDER" \
  --zone="$ZONE" \
  --machine-type="$MACHINE" \
  --image-family="$BASE_IMAGE_FAMILY" \
  --image-project="$BASE_IMAGE_PROJECT" \
  --metadata-from-file=startup-script="$(winpath "$HERE/startup-provision.sh")",cr-observe="$(winpath "$SANDBOX_ROOT/harness/observe.py")",cr-harness="$(winpath "$SANDBOX_ROOT/harness/run-harness.sh")" \
  --no-service-account --no-scopes >/dev/null

log "waiting for provisioning to complete (PROVISION_DONE marker)..."
DONE=0
for i in $(seq 1 50); do
  if gcloud compute ssh "$BUILDER" --zone="$ZONE" \
       --command="test -f /opt/cr/PROVISION_DONE && node --version && python3 -c 'import shutil,sys; sys.exit(0 if shutil.which(\"strace\") else 1)'" >/dev/null 2>&1; then
    log "provisioning complete (node + strace present)"
    DONE=1
    break
  fi
  sleep 15
done
[ "$DONE" = "1" ] || { log "ERROR: provisioning did not complete in time"; exit 1; }

log "stopping builder for image capture"
gcloud compute instances stop "$BUILDER" --zone="$ZONE" --quiet >/dev/null

log "creating image $IMAGE"
gcloud compute images create "$IMAGE" \
  --source-disk="$BUILDER" \
  --source-disk-zone="$ZONE" \
  --family="cr-sandbox-golden" >/dev/null

log "golden image ready: $IMAGE (family cr-sandbox-golden)"
echo "$IMAGE"
# builder VM deleted by trap on exit.
