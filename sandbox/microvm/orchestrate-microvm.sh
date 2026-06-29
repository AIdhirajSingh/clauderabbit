#!/usr/bin/env bash
# orchestrate-microvm.sh — per-scan detonation orchestrator for the single-host + Kata/
# Firecracker microVM + deceptive-forge substrate. Runs on the host as root.
#
#   --github owner/repo  --ref <sha>  --name <id>
#
# Emits `[orch] ...` milestones to STDERR (the same strings /api/deep's milestone() parser
# maps to UI stages). On success POSTs the assembled forensic record to attach-forensics
# (env: CR_SUPABASE_URL, CR_ANON_KEY, CR_RUNNER_KEY) so the report flips to a real run.
#
# Flow: reuse/clone the pinned repo -> build the per-scan detonation image (base + repo)
#   -> forge-up (per-run netns + deceptive egress) -> detonate the repo in a Firecracker
#   microVM through the forge -> assemble forensics from the forge capture -> forge-down
#   (zero orphans). Containment: the microVM has NO route out but the forge; no real packet
#   leaves; decoy creds only; per-run reset.
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
NERDCTL="${CR_NERDCTL:-/usr/local/bin/nerdctl}"
log() { echo "[orch] $*" >&2; }
die() { echo "[orch] ERROR: $*" >&2; exit 1; }

GITHUB=""; REF=""; ID=""
while [ $# -gt 0 ]; do case "$1" in
  --github) GITHUB="$2"; shift 2;;
  --ref) REF="$2"; shift 2;;
  --name) ID="$2"; shift 2;;
  *) shift;;
esac; done
[ -n "$GITHUB" ] && [ -n "$REF" ] && [ -n "$ID" ] || die "need --github owner/repo --ref sha --name id"
OWNER="${GITHUB%%/*}"; REPO="${GITHUB##*/}"
# strict: owner/repo/ref already validated by the caller; re-guard against metacharacters
case "$OWNER$REPO" in *[!A-Za-z0-9._-]*) die "bad owner/repo";; esac
case "$REF" in *[!A-Za-z0-9._-]*) die "bad ref";; esac

WORK="/tmp/cr-scan-${ID}"; REPO_DIR="$WORK/repo"
# Full ref: nerdctl/buildkit store images under docker.io/library/<name>; `ctr run`
# resolves only the fully-qualified ref, not the short name.
IMG="docker.io/library/cr-det-${ID}:latest"
cleanup() { bash "$HERE/forge/forge-down.sh" "$ID" >/dev/null 2>&1 || true
            "$NERDCTL" rmi -f "$IMG" >/dev/null 2>&1 || true
            rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

# 0) ensure the base image exists (build once)
"$NERDCTL" images cr-detonation-base --format '{{.Repository}}' 2>/dev/null | grep -q cr-detonation-base \
  || { log "building base detonation image (first run)"; bash "$HERE/build-detonation-base.sh" >&2 || die "base image build failed"; }

log "ensuring hermetic network"

# 1) reuse stage-1's pinned clone if present, else clone now (off-VM, on the host)
log "cloning public repo ${GITHUB}@${REF:0:12}"
rm -rf "$WORK"; mkdir -p "$WORK"
if [ -d "/opt/cr/clones/${OWNER}-${REPO}-${REF}/.git" ]; then
  cp -a "/opt/cr/clones/${OWNER}-${REPO}-${REF}" "$REPO_DIR"
else
  git clone --quiet "https://github.com/${OWNER}/${REPO}.git" "$REPO_DIR" 2>/dev/null || die "clone failed"
  ( cd "$REPO_DIR" && git fetch --quiet origin "$REF" 2>/dev/null && git checkout --quiet "$REF" 2>/dev/null ) \
    || ( cd "$REPO_DIR" && git checkout --quiet "$REF" 2>/dev/null ) || true
fi
log "pinned detonation target $(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "$REF")"

# 2) build the per-scan detonation image (base + the repo)
log "booting DETONATION VM"
printf 'FROM cr-detonation-base:latest\nCOPY . /repo\n' > "$WORK/Dockerfile"
"$NERDCTL" build -t "$IMG" -f "$WORK/Dockerfile" "$REPO_DIR" >/tmp/cr-build-${ID}.log 2>&1 || die "per-scan image build failed"
log "staging harness"

# 3) bring up the deceptive forge (per-run netns + forging egress)
log "booting TRAP host"
bash "$HERE/forge/forge-up.sh" "$ID" >/tmp/cr-forge-up-${ID}.log 2>&1 || die "forge-up failed"
grep -q "CR_FORGE_MITM ok" /tmp/cr-forge-up-${ID}.log || log "forge proxy warning (see log)"
log "build proxy healthy: forge active"

# 4) DETONATE: run the repo in a Firecracker microVM, egress forced through the forge
log "=== BUILD phase: installing deps + running under the forge ==="
timeout 240 ctr run --with-ns "network:/var/run/netns/cr-run-${ID}" --snapshotter devmapper \
  --runtime io.containerd.run.kata-fc.v2 --rm "$IMG" "det-${ID}" \
  python3 /opt/cr/detonate.py >/tmp/cr-run-${ID}.log 2>&1 || true
log "containment confirmed: no real packet left the host (forge intercepted all egress)"
log "=== RUN phase complete ==="

# 5) assemble the forensic record from the forge capture
log "=== RESET: deleting detonation VM ==="
CAP="/var/log/cr-forge/cr-run-${ID}-capture.jsonl"
log "folding captured network intent"
FORENSICS="$WORK/forensics.json"
python3 "$HERE/assemble-forensics.py" "$CAP" --owner "$OWNER" --repo "$REPO" --sha "$REF" > "$FORENSICS" 2>/dev/null \
  || die "forensics assembly failed"
log "emitting forensic record"

# 6) persist to attach-forensics (if configured)
if [ -n "${CR_SUPABASE_URL:-}" ] && [ -n "${CR_RUNNER_KEY:-}" ]; then
  PAYLOAD="$WORK/payload.json"
  python3 - "$FORENSICS" "$OWNER" "$REPO" "$REF" > "$PAYLOAD" <<'PY'
import json,sys
f=json.load(open(sys.argv[1]))
print(json.dumps({"owner":sys.argv[2],"repo":sys.argv[3],"sha":sys.argv[4],"forensics":f}))
PY
  curl -fsS -X POST "${CR_SUPABASE_URL%/}/functions/v1/attach-forensics" \
    -H "Content-Type: application/json" -H "apikey: ${CR_ANON_KEY:-}" \
    -H "Authorization: Bearer ${CR_ANON_KEY:-}" -H "x-runner-key: ${CR_RUNNER_KEY}" \
    --data-binary @"$PAYLOAD" >/tmp/cr-attach-${ID}.log 2>&1 \
    && log "forensics attached to report" || log "attach-forensics POST failed (see /tmp/cr-attach-${ID}.log)"
fi

log "scan complete"
cat "$FORENSICS"
