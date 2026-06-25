#!/usr/bin/env bash
#
# startup-provision.sh — provisions a fresh Debian VM into the Claude Rabbit
# sandbox "golden" state: common runtimes + the agent harness, NO credentials.
#
# Used two ways:
#   (a) as the boot startup-script of an ephemeral VM (the ephemeral VM IS the
#       per-scan reset), or
#   (b) baked into a reusable custom image by build-image.sh (production path).
#
# It deliberately installs ONLY runtimes/tools and the harness. It plants NO
# real credentials — the box is hermetic by construction. The observer plants
# decoy canaries at scan time, not here.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { echo "[provision] $*"; }

log "apt update + base tooling"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git build-essential \
  python3 python3-pip python3-venv \
  strace conntrack jq tar gzip procps coreutils >/dev/null

# Node LTS via NodeSource (Node 20 LTS).
if ! command -v node >/dev/null 2>&1; then
  log "installing Node.js LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
  apt-get install -y nodejs >/dev/null 2>&1 || true
fi

log "installed runtime versions:"
node --version 2>/dev/null || log "node: MISSING"
python3 --version 2>/dev/null || log "python3: MISSING"
git --version 2>/dev/null || log "git: MISSING"

# Place the harness + observer where run-harness.sh expects them.
mkdir -p /opt/cr
# When booted with startup-script, observe.py + run-harness.sh are delivered via
# instance metadata (cr-observe / cr-harness) — pull them out if present.
if command -v curl >/dev/null 2>&1; then
  MD="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
  curl -fsH "Metadata-Flavor: Google" "$MD/cr-observe" -o /opt/cr/observe.py 2>/dev/null \
    && log "observe.py delivered via metadata" || log "observe.py not in metadata (scp path)"
  curl -fsH "Metadata-Flavor: Google" "$MD/cr-harness" -o /opt/cr/run-harness.sh 2>/dev/null \
    && log "run-harness.sh delivered via metadata" || log "run-harness.sh not in metadata (scp path)"
fi
chmod +x /opt/cr/*.sh /opt/cr/*.py 2>/dev/null || true

# Mark provisioning complete so the orchestrator can poll readiness.
echo "ready $(date -u +%FT%TZ)" > /opt/cr/PROVISION_DONE
log "golden state ready (no credentials present)"
