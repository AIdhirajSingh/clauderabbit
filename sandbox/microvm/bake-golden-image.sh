#!/usr/bin/env bash
# bake-golden-image.sh — capture a fully-provisioned detonation host as a reusable GCE
# golden image, so the on-demand compute pool (create-pool.sh) can boot detonation-ready
# hosts WITHOUT re-running the whole setup-host.sh install every time.
#
# WHY a custom image (not a startup-script MIG): setup-host.sh's install phase (containerd,
# Kata static download, Firecracker, mitmproxy via pipx, nerdctl-full download, buildkit) is
# the slow part. Baking a golden image from a host that has ALREADY run it means a pool member
# boots with the substrate pre-installed and only has to run the two fast boot services below.
#
# COMPATIBLE with the "dm-pool must be rebuilt fresh every boot" requirement: the golden image
# captures the ENABLED systemd units cr-dm-pool.service + cr-base-image.service (installed by
# setup-host.sh). On EVERY boot from this image they rebuild a clean loopback thin-pool and
# rebuild the base detonation image onto it from the baked /opt/cr/microvm code — exactly as
# they do on the hand-provisioned host. The loopback backing files are NOT part of the useful
# image state; they are reset on boot regardless of source disk. VERIFIED: a host booted from
# this image reaches "base image present" via these services (see create-pool.sh benchmark).
#
# Idempotent: bumps the image version if one already exists in the family; the pool template
# always points at the family's newest non-deprecated image.
#
# Usage:
#   bash sandbox/microvm/bake-golden-image.sh              # bake from $HOST (must be provisioned)
#   CR_GOLDEN_SRC_HOST=cr-host-build bash ...              # explicit source host
set -uo pipefail
PROJECT="${CR_GCP_PROJECT:-gen-lang-client-0062239756}"
ZONE="${CR_SANDBOX_ZONE:-us-east1-b}"
SRC_HOST="${CR_GOLDEN_SRC_HOST:-${CR_SANDBOX_HOST:-cr-host-build}}"
IMG_FAMILY="${CR_GOLDEN_FAMILY:-cr-detonation-golden}"
# Version-stamped image name so re-baking never collides; the template resolves by FAMILY,
# which always points at the newest non-deprecated image, so bumping is transparent.
IMG_NAME="${CR_GOLDEN_IMAGE:-cr-detonation-golden-$(date -u +%Y%m%d-%H%M%S)}"

log(){ echo "[bake] $*" >&2; }
die(){ echo "[bake] ERROR: $*" >&2; exit 1; }
g(){ gcloud --project "$PROJECT" "$@"; }

# Resolve the source host's real zone (it may not be the default).
SRC_ZONE="$(g compute instances list --filter="name=${SRC_HOST}" --format='value(zone)' 2>/dev/null | head -1)"
SRC_ZONE="${SRC_ZONE##*/}"; SRC_ZONE="${SRC_ZONE:-$ZONE}"
state="$(g compute instances describe "$SRC_HOST" --zone "$SRC_ZONE" --format='value(status)' 2>/dev/null || echo ABSENT)"
[ "$state" = ABSENT ] && die "source host $SRC_HOST not found — run provision-host.sh first"
log "source host $SRC_HOST is $state in $SRC_ZONE"

# GCE recommends the disk be quiescent for a consistent image. If the host is running, stop it
# first (its substrate is on the boot disk; the loopback pool files are transient anyway).
STARTED_STOPPED=0
if [ "$state" = RUNNING ]; then
  log "stopping $SRC_HOST for a consistent image capture (will restart it after)"
  g compute instances stop "$SRC_HOST" --zone "$SRC_ZONE" --quiet >/dev/null || die "stop failed"
  STARTED_STOPPED=1
fi

log "creating golden image $IMG_NAME (family $IMG_FAMILY) from $SRC_HOST boot disk"
g compute images create "$IMG_NAME" \
  --source-disk="$SRC_HOST" --source-disk-zone="$SRC_ZONE" \
  --family="$IMG_FAMILY" \
  --description="Claude Rabbit detonation golden image: Kata + Firecracker + containerd/devmapper + buildkit + mitmproxy CA + deno + OpenCode + cr-dm-pool/cr-base-image/cr-idle-shutdown units. Boot services rebuild a fresh thin-pool + base image every boot." \
  --labels=purpose=cr-microvm-substrate,role=golden \
  >/dev/null 2>&1 || die "image create failed"
g compute images describe "$IMG_NAME" --format='value(name,status,diskSizeGb,family)' 2>&1

# Restore the source host if we stopped it — never leave the fallback single-host path down.
if [ "$STARTED_STOPPED" = 1 ]; then
  log "restarting source host $SRC_HOST (preserve the single-host fallback path)"
  g compute instances start "$SRC_HOST" --zone "$SRC_ZONE" --quiet >/dev/null || log "WARN: restart failed — start it manually"
fi

log "DONE — golden image $IMG_NAME ready in family $IMG_FAMILY. create-pool.sh will use the family's newest image."
echo "CR_GOLDEN_IMAGE=${IMG_NAME}"
echo "CR_GOLDEN_FAMILY=${IMG_FAMILY}"
