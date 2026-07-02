#!/usr/bin/env bash
# create-pool.sh — stand up the ON-DEMAND detonation compute pool: a regional-agnostic
# zonal Managed Instance Group (MIG) of nested-virt N2 hosts booted from the golden image
# (bake-golden-image.sh), with a STANDBY POOL in scale-out mode so the group activates a
# warm-ish standby first (resume/start) before creating a fresh host.
#
# WHY a MIG + standby pool (per the compute-provisioning research):
#   - One host has a hard 4-vCPU ceiling -> at most 2 concurrent detonations. Scaling the
#     COMPUTE layer (N hosts) is the only way to "hundreds of concurrent isolated runs".
#   - A standby pool (GA: docs/INFRASTRUCTURE.md 8b) keeps a few members STOPPED (billed for
#     disk only, not vCPU) so activating capacity is a fast `instances start`, not a
#     create-from-scratch. In scale-out mode the MIG resumes suspended, then starts stopped,
#     then creates fresh — cheapest-fastest first.
#
# COST DISCIPLINE (real small billing account):
#   - target-size defaults to 1 always-running host (matches the old single warm host).
#   - stopped-size defaults to 2 warm standbys (disk-only cost).
#   - NO suspended standbys by default: suspend keeps RAM in paid storage and (measured) is
#     NOT reliably faster than stopped for this nested-virt shape (see benchmark-pool.sh).
#   - Each member inherits the golden image's cr-idle-shutdown watchdog + a max-run-duration
#     STOP backstop via the template, so an activated host that goes idle powers ITSELF off
#     back into the stopped standby pool — the MIG's autohealing/standby replenish keeps the
#     stopped-size target, so idle capacity is reclaimed exactly like the single host was.
#
# NESTED VIRT: --enable-nested-virtualization on the template (N2 supports it; the golden
# image was built on n2-standard-4). PREEMPTIBLE/SPOT is NOT used (quota=0 on this account).
#
# Idempotent: (re)creates the template from the golden family's newest image and (re)creates
# or updates the MIG to the configured sizes. Safe to re-run.
#
# Usage:
#   bash sandbox/microvm/create-pool.sh                    # create/update pool (default sizes)
#   CR_POOL_TARGET=1 CR_POOL_STOPPED=2 bash ...            # explicit sizes
#   bash sandbox/microvm/create-pool.sh --recreate-template # force a fresh template
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PROJECT="${CR_GCP_PROJECT:-gen-lang-client-0062239756}"
ZONE="${CR_POOL_ZONE:-${CR_SANDBOX_ZONE:-us-east1-b}}"
MACHINE="${CR_HOST_MACHINE:-n2-standard-4}"
SA="${CR_HOST_SA:-clauderabbit-vertex@${PROJECT}.iam.gserviceaccount.com}"
IMG_FAMILY="${CR_GOLDEN_FAMILY:-cr-detonation-golden}"
TEMPLATE="${CR_POOL_TEMPLATE:-cr-detonation-tmpl}"
MIG="${CR_POOL_MIG:-cr-detonation-pool}"
BASE_NAME="${CR_POOL_BASENAME:-cr-det}"        # members named cr-det-xxxx
# Conservative default fleet: 1 always-running + 2 stopped standbys. Do NOT balloon this on a
# real billing account; raise via env when load justifies it.
TARGET="${CR_POOL_TARGET:-1}"
STOPPED="${CR_POOL_STOPPED:-2}"
SUSPENDED="${CR_POOL_SUSPENDED:-0}"
STANDBY_INITIAL_DELAY="${CR_POOL_STANDBY_DELAY:-120}"  # let a fresh member finish first boot before it's standby-eligible

log(){ echo "[pool] $*" >&2; }
die(){ echo "[pool] ERROR: $*" >&2; exit 1; }
g(){ gcloud --project "$PROJECT" "$@"; }

RECREATE_TMPL=0
[ "${1:-}" = "--recreate-template" ] && RECREATE_TMPL=1

# ── 1) resolve the newest golden image in the family ─────────────────────────────────
GOLDEN="$(g compute images describe-from-family "$IMG_FAMILY" --format='value(name)' 2>/dev/null)"
[ -n "$GOLDEN" ] || die "no image in family $IMG_FAMILY — run bake-golden-image.sh first"
log "golden image (family $IMG_FAMILY newest) = $GOLDEN"

# ── 2) (re)create the instance template from the golden image ────────────────────────
# The template pins: golden image, nested virt, N2 shape, the vertex SA (metadata-server ADC
# for OpenCode). NO --max-run-duration here: a MIG rejects an instance template that sets
# max-run-duration with any termination action except DELETE ("Only termination action DELETE
# is supported when having max run duration set"), and we do NOT want to DELETE (destroy) a
# warm member's disk.
#
# IDLE RECLAIM IN A MIG — measured, not assumed: the golden image's cr-idle-shutdown watchdog
# poweroffs an idle host. That reclaims the SINGLE host fine, but in a MIG it FIGHTS the group:
# the reconciler keeps targetSize members RUNNING, so a member that self-stops is immediately
# restarted (VERIFIED live: a watchdog poweroff was reversed within ~25s). So on pool members
# we MASK the watchdog (startup-script below) and let the MIG own the lifecycle. Idle reclaim
# is instead: (a) a small warm baseline (targetSize, default 1) sized to real load, and (b)
# app-driven scale-in — /api/deep resizes the MIG up on demand (scale-out-pool activates a
# standby) and back down as scans drain, so surplus running hosts return to the disk-only
# stopped standby pool. The stopped standbys themselves cost only disk, so an idle pool rests
# at (baseline running + N stopped) — genuinely reclaimed, no host runs unattended forever.
# Instance templates are IMMUTABLE, and one in use by a MIG can't be deleted. So we create a
# version-stamped template each run (pinning the current golden image + startup-script) and
# roll the MIG onto it with set-instance-template; the old template is pruned afterward. On a
# no-change re-run we detect the MIG already points at a template pinning the same golden image
# and skip, so re-running is cheap and idempotent.
STARTUP_SCRIPT="$HERE/pool-member-startup.sh"
[ -f "$STARTUP_SCRIPT" ] || die "missing $STARTUP_SCRIPT (masks the idle watchdog on pool members)"
TEMPLATE_VER="${TEMPLATE}-$(date -u +%Y%m%d-%H%M%S)"

current_template_image() {
  # golden image the MIG's current template pins (empty if no MIG / no template yet)
  local t
  t="$(g compute instance-groups managed describe "$MIG" --zone "$ZONE" --format='value(instanceTemplate.basename())' 2>/dev/null)"
  [ -n "$t" ] || return 0
  g compute instance-templates describe "$t" --format='value(properties.disks[0].initializeParams.sourceImage.basename())' 2>/dev/null
}

NEED_NEW_TEMPLATE=1
if [ "$RECREATE_TMPL" != 1 ] && [ "$(current_template_image)" = "$GOLDEN" ]; then
  NEED_NEW_TEMPLATE=0
  TEMPLATE_VER="$(g compute instance-groups managed describe "$MIG" --zone "$ZONE" --format='value(instanceTemplate.basename())' 2>/dev/null)"
  log "MIG already pins golden $GOLDEN via $TEMPLATE_VER — reusing template (pass --recreate-template to force)"
fi

if [ "$NEED_NEW_TEMPLATE" = 1 ]; then
  log "creating instance template $TEMPLATE_VER ($MACHINE, nested-virt, golden $GOLDEN, idle-watchdog masked on boot)"
  g compute instance-templates create "$TEMPLATE_VER" \
    --machine-type "$MACHINE" --enable-nested-virtualization \
    --image "$GOLDEN" \
    --boot-disk-size 100GB --boot-disk-type pd-balanced \
    --service-account "$SA" --scopes cloud-platform \
    --metadata enable-oslogin=FALSE \
    --metadata-from-file startup-script="$STARTUP_SCRIPT" \
    --labels purpose=cr-microvm-substrate,role=pool-member \
    >/dev/null 2>&1 || die "template create failed"
fi
TEMPLATE="$TEMPLATE_VER"

# ── 3) create or update the MIG ──────────────────────────────────────────────────────
mig_exists(){ g compute instance-groups managed describe "$MIG" --zone "$ZONE" >/dev/null 2>&1; }
if ! mig_exists; then
  log "creating MIG $MIG in $ZONE: target=$TARGET stopped-standby=$STOPPED suspended-standby=$SUSPENDED"
  g compute instance-groups managed create "$MIG" \
    --zone "$ZONE" --template "$TEMPLATE" --base-instance-name "$BASE_NAME" \
    --size "$TARGET" \
    >/dev/null 2>&1 || die "MIG create failed"
elif [ "$NEED_NEW_TEMPLATE" = 1 ]; then
  log "MIG $MIG exists — rolling onto new template $TEMPLATE"
  g compute instance-groups managed set-instance-template "$MIG" --zone "$ZONE" --template "$TEMPLATE" >/dev/null 2>&1 || log "WARN: set-instance-template failed"
  # Apply the new template to existing members (so the watchdog-mask startup-script takes hold).
  # substitute (recreate) — proactive, one at a time, so we never take all capacity down at once.
  g compute instance-groups managed rolling-action start-update "$MIG" --zone "$ZONE" \
    --version template="$TEMPLATE" --max-surge 1 --max-unavailable 0 >/dev/null 2>&1 || log "WARN: rolling-update start failed"
  g compute instance-groups managed resize "$MIG" --zone "$ZONE" --size "$TARGET" >/dev/null 2>&1 || log "WARN: resize failed"
else
  log "MIG $MIG exists, template unchanged — ensuring size=$TARGET"
  g compute instance-groups managed resize "$MIG" --zone "$ZONE" --size "$TARGET" >/dev/null 2>&1 || log "WARN: resize failed"
fi

# Standby pool in scale-out-pool mode: on a resize-up the MIG resumes/starts a standby member
# first (cheapest-fastest), then replenishes the standby pool. stopped-size is disk-only cost.
log "configuring standby pool: mode=scale-out-pool stopped=$STOPPED suspended=$SUSPENDED delay=${STANDBY_INITIAL_DELAY}s"
g compute instance-groups managed update "$MIG" --zone "$ZONE" \
  --standby-policy-mode=scale-out-pool \
  --standby-policy-initial-delay="$STANDBY_INITIAL_DELAY" \
  --stopped-size="$STOPPED" --suspended-size="$SUSPENDED" \
  >/dev/null 2>&1 || die "standby-policy update failed"

# Prune superseded pool templates (immutable + accumulate otherwise). Keep the one in use.
for t in $(g compute instance-templates list --filter="name~^${CR_POOL_TEMPLATE:-cr-detonation-tmpl}-" --format='value(name)' 2>/dev/null); do
  [ "$t" = "$TEMPLATE" ] && continue
  g compute instance-templates delete "$t" --quiet >/dev/null 2>&1 && log "pruned old template $t" || true
done

# ── 4) report ────────────────────────────────────────────────────────────────────────
log "pool state:"
g compute instance-groups managed describe "$MIG" --zone "$ZONE" \
  --format='value(name,targetSize,standbyPolicy.mode,targetStoppedSize,targetSuspendedSize)' 2>&1
echo "CR_POOL_MIG=${MIG}"
echo "CR_POOL_ZONE=${ZONE}"
echo "CR_POOL_TEMPLATE=${TEMPLATE}"
log "DONE — set CR_POOL_MIG + CR_POOL_ZONE in .env.local so /api/deep dispatches to the pool."
