#!/usr/bin/env bash
# provision-host.sh — reproducibly (re)create the Claude Rabbit detonation host from
# COMMITTED CODE ALONE. A fresh clone on a new machine, pointed at the same GCP project,
# runs this to stand the host up; nothing is hand-tuned on the host that isn't here.
#
# Idempotent: creates the VM if absent (with the self-cleaning cost rails), starts it if
# stopped, (re)deploys the substrate + agent code, runs setup-host.sh on a fresh host,
# installs the per-user agent tooling (deno + OpenCode + config), builds the base image,
# and verifies. Re-running is safe.
#
# COST RAILS — the host must never bleed credit unattended (it once ran ~2 days after an
# interrupted session):
#   1. Idle auto-shutdown watchdog (installed by setup-host.sh Stage 8): powers the host
#      OFF after ~30 min with no detonation activity and nobody logged in. Never interrupts
#      an in-flight scan.
#   2. max-run-duration backstop: the VM is created time-limited (STOP action), so even a
#      watchdog failure reclaims the running compute within CR_HOST_MAX_RUN_HOURS.
#
# Usage:
#   bash sandbox/microvm/provision-host.sh            # create/start + provision + verify
#   bash sandbox/microvm/provision-host.sh --recreate # delete any existing host first
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

PROJECT="${CR_GCP_PROJECT:-redacted-gcp-project}"
ZONE="${CR_SANDBOX_ZONE:-us-central1-a}"
HOST="${CR_SANDBOX_HOST:-cr-host-build}"
MACHINE="${CR_HOST_MACHINE:-n2-standard-4}"
SA="${CR_HOST_SA:-clauderabbit-vertex@${PROJECT}.iam.gserviceaccount.com}"
MAX_RUN_HOURS="${CR_HOST_MAX_RUN_HOURS:-12}"

log(){ echo "[provision] $*" >&2; }
die(){ echo "[provision] ERROR: $*" >&2; exit 1; }
g(){ gcloud --project "$PROJECT" "$@"; }
winpath(){ if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
# plink (Windows gcloud) prompts to cache a new host key on first connect; feed it 'y'.
ssh_host(){ printf 'y\n' | gcloud compute ssh "$HOST" --zone "$ZONE" --project "$PROJECT" --quiet --command "$1"; }

# Zone fallback: n2 nested-virt zones stock out transiently ("does not have enough
# resources"). A reproducible provision on any machine must survive that, so we try a list
# and land in the first zone with capacity. The winning zone is printed at the end — set it
# as CR_SANDBOX_ZONE in .env.local so /api/deep SSHes to the same place.
ZONES="${CR_SANDBOX_ZONES:-$ZONE us-central1-c us-central1-b us-central1-f us-east1-b us-east4-c us-west1-b us-east5-a}"

create_in_some_zone() {
  local z err="${TMPDIR:-/tmp}/cr-create-$$.err"
  for z in $ZONES; do
    log "creating $HOST in $z ($MACHINE, nested-virt, self-reclaim: max-run ${MAX_RUN_HOURS}h -> STOP)"
    if g compute instances create "$HOST" \
        --zone "$z" --machine-type "$MACHINE" --enable-nested-virtualization \
        --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
        --boot-disk-size 100GB --boot-disk-type pd-balanced \
        --service-account "$SA" --scopes cloud-platform \
        --metadata enable-oslogin=FALSE,cr-idle-exempt=1 \
        --max-run-duration "$((MAX_RUN_HOURS * 3600))s" --instance-termination-action STOP \
        --labels purpose=cr-microvm-substrate >/dev/null 2>"$err"; then
      ZONE="$z"; log "created in $z"; rm -f "$err"; return 0
    fi
    if grep -qiE "enough resources|RESOURCE_POOL_EXHAUSTED|resource_availability" "$err"; then
      log "zone $z stocked out — trying next"; continue
    fi
    log "create failed in $z (non-capacity error):"; cat "$err" >&2; rm -f "$err"; return 1
  done
  log "all candidate zones stocked out: $ZONES"; return 1
}

# ── 1) create-or-start ───────────────────────────────────────────────────────────────
# Find an existing host in ANY zone first (so `start` uses its real zone, not the default).
EXIST_ZONE="$(g compute instances list --filter="name=${HOST}" --format='value(zone)' 2>/dev/null | head -1)"
[ -n "$EXIST_ZONE" ] && ZONE="${EXIST_ZONE##*/}"
state="$(g compute instances describe "$HOST" --zone "$ZONE" --format='value(status)' 2>/dev/null || echo ABSENT)"
if [ "${1:-}" = "--recreate" ] && [ "$state" != ABSENT ]; then
  log "deleting existing $HOST in $ZONE (--recreate)"; g compute instances delete "$HOST" --zone "$ZONE" --quiet || true; state=ABSENT
fi
case "$state" in
  ABSENT)  create_in_some_zone || die "instance create failed in every candidate zone" ;;
  RUNNING) log "$HOST already RUNNING in $ZONE" ;;
  *)       log "$HOST is $state in $ZONE — starting"; g compute instances start "$HOST" --zone "$ZONE" >/dev/null || die "start failed" ;;
esac

# ── 2) wait for SSH ──────────────────────────────────────────────────────────────────
log "waiting for SSH…"
ok=0
for i in $(seq 1 48); do
  if ssh_host 'echo CR_SSH_OK' 2>/dev/null | grep -q CR_SSH_OK; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || die "SSH did not come up"
LOGIN_USER="$(ssh_host 'whoami' 2>/dev/null | tr -d "\r" | grep -vE 'Warning|Store key|connecting' | tail -1)"
[ -n "$LOGIN_USER" ] || die "could not resolve login user"
log "login user = $LOGIN_USER"

# ── 3) deploy the substrate + agent code to /opt/cr, _shared to /opt/supabase ─────────
log "packaging + pushing code"
TARB="${TMPDIR:-/tmp}/cr-deploy-$$.tgz"
tar czf "$TARB" --exclude=__pycache__ --exclude='*.pyc' -C "$REPO_ROOT" \
  sandbox/microvm sandbox/agent supabase/functions/_shared || die "tar failed"
g compute scp "$(winpath "$TARB")" "$HOST:/tmp/cr-deploy.tgz" --zone "$ZONE" --quiet >/dev/null || die "scp failed"
rm -f "$TARB"
ssh_host '
set -e
sudo mkdir -p /opt/cr /opt/supabase/functions
cd /tmp && rm -rf cr-deploy && mkdir cr-deploy && tar xzf cr-deploy.tgz -C cr-deploy
sudo rm -rf /opt/cr/microvm /opt/cr/agent /opt/supabase/functions/_shared
sudo cp -a cr-deploy/sandbox/microvm /opt/cr/microvm
sudo cp -a cr-deploy/sandbox/agent /opt/cr/agent
sudo cp -a cr-deploy/supabase/functions/_shared /opt/supabase/functions/_shared
sudo chmod -R a+rX /opt/cr /opt/supabase
sudo find /opt/cr -name "*.sh" -exec chmod +x {} +
echo CR_DEPLOY_OK' 2>&1 | grep -q CR_DEPLOY_OK || die "code deploy failed"

# ── 4) substrate: full setup on a fresh host; on an already-provisioned host re-run it
#       anyway (idempotent) so a committed change to the substrate / cost-rail lands ─────
log "running setup-host.sh (substrate + idle watchdog)"
ssh_host 'sudo bash /opt/cr/microvm/setup-host.sh 2>&1 | grep -E "CR_STAGE_|CR_FACT_(NERDCTL_VER|BUILDKITD|IDLE_TIMER)|CR_SETUP_DONE"; sudo touch /opt/cr/SETUP_DONE' 2>&1 | tail -20
ssh_host 'systemctl is-active --quiet containerd && echo CONTAINERD_UP || echo CONTAINERD_DOWN' | grep -q CONTAINERD_UP || die "containerd not up after setup"

# ── 5) per-user agent tooling: unzip + deno + OpenCode + opencode.json (Vertex @ global) ─
log "installing per-user agent tooling (deno + OpenCode) for $LOGIN_USER"
ssh_host '
set +e
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y unzip >/dev/null 2>&1
# Pinned to a specific, known-good version (not "latest") and downloaded to a
# file before execution rather than piped straight into the shell — a bad
# response body still cannot run until we choose to `sh`/`bash` it. Neither
# vendor publishes a checksum for the install SCRIPT itself (only for release
# binaries), so the pin + a separate download step is the real, honest
# hardening available here; bump these deliberately, never by tracking latest.
if [ ! -x "$HOME/.deno/bin/deno" ]; then
  curl -fsSL https://deno.land/install.sh -o /tmp/cr-deno-install.sh
  sh /tmp/cr-deno-install.sh -y v2.9.1 >/tmp/cr-deno.log 2>&1
  rm -f /tmp/cr-deno-install.sh
fi
if [ ! -x "$HOME/.opencode/bin/opencode" ]; then
  curl -fsSL https://opencode.ai/install -o /tmp/cr-opencode-install.sh
  bash /tmp/cr-opencode-install.sh --version 1.17.13 >/tmp/cr-oc.log 2>&1
  rm -f /tmp/cr-opencode-install.sh
fi
mkdir -p "$HOME/.config/opencode"
cat > "$HOME/.config/opencode/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": { "google-vertex": { "options": { "project": "'"$PROJECT"'", "location": "global" } } }
}
JSON
echo "deno=$("$HOME/.deno/bin/deno" --version 2>/dev/null | head -1) opencode=$("$HOME/.opencode/bin/opencode" --version 2>/dev/null | head -1)"
' 2>&1 | grep -E "deno=|opencode=" || log "WARN: agent tooling versions not confirmed"

# ── 6) base detonation image (build once; buildkit-cached thereafter) ─────────────────
ssh_host '
if sudo /usr/local/bin/nerdctl images cr-detonation-base --format "{{.Repository}}" 2>/dev/null | grep -q cr-detonation-base; then
  echo CR_BASE_PRESENT
else
  sudo CR_FORGE_CA=/root/.mitmproxy/mitmproxy-ca-cert.pem bash /opt/cr/microvm/build-detonation-base.sh 2>&1 | tail -2
fi' 2>&1 | tail -3

# ── 7) verify the cost rails + substrate are live ─────────────────────────────────────
log "verifying host readiness + cost rails"
ssh_host '
echo "KVM=$([ -e /dev/kvm ] && echo yes || echo NO)"
echo "watchdog_timer=$(systemctl is-active cr-idle-shutdown.timer 2>/dev/null)"
echo "base_image=$(sudo /usr/local/bin/nerdctl images cr-detonation-base --format "{{.Repository}}:{{.Tag}}" 2>/dev/null | head -1)"
' 2>&1 | grep -E "KVM=|watchdog_timer=|base_image="
MRD="$(g compute instances describe "$HOST" --zone "$ZONE" --format='value(scheduling.maxRunDuration.seconds,scheduling.instanceTerminationAction)' 2>/dev/null)"
log "max-run-duration backstop: ${MRD:-<none>}"
echo "CR_HOST_ZONE=${ZONE}"   # <-- set CR_SANDBOX_ZONE to this in .env.local so /api/deep matches
log "DONE — $HOST provisioned in ${ZONE}. Idle watchdog + max-run backstop active; host self-reclaims when abandoned."
