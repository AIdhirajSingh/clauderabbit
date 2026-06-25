#!/usr/bin/env bash
#
# run-analysis.sh — run the captured-payload analysis in a SEPARATE, DISPOSABLE,
# isolated environment. Captured payloads are potentially hostile, so they are
# NEVER analyzed in the detonation VM and NEVER in anything persistent. Only
# INERT captured bytes (the trap's capture.jsonl) move into this env; never live
# execution.
#
# Two modes:
#   vm    : boot a distinct ephemeral analysis VM, copy ONLY the inert capture +
#           behavior JSON onto it, run analyze-payload.py, copy the result back,
#           and DELETE the VM (mandatory). Production path.
#   local : run analyze-payload.py in a throwaway temp dir on the orchestrator
#           host (which is itself off the detonation VM and has ADC for the
#           Vertex/Gemini call), then delete the temp dir. Used for the proof —
#           it keeps the live core count down (no 3rd VM) while still being a
#           separate, disposable, isolated environment from the detonation VM.
#           Inert bytes only; nothing is executed.
#
# Usage:
#   run-analysis.sh local <capture.jsonl> <behavior.json> <out-analysis.json> [--no-ai]
#   run-analysis.sh vm    <zone> <capture.jsonl> <behavior.json> <out-analysis.json>
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ANALYZE="$HERE/analyze-payload.py"
PROJECT="redacted-gcp-project"

log() { echo "[analysis] $*" >&2; }
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

mode="${1:-}"; shift || true

if [ "$mode" = "local" ]; then
  CAPTURE="${1:?capture.jsonl}"; BEHAVIOR="${2:?behavior.json}"; OUT="${3:?out.json}"; shift 3 || true
  EXTRA="${1:-}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT INT TERM
  cp "$CAPTURE" "$TMP/capture.jsonl" 2>/dev/null || : > "$TMP/capture.jsonl"
  cp "$BEHAVIOR" "$TMP/behavior.json" 2>/dev/null || echo '{}' > "$TMP/behavior.json"
  log "running isolated analysis locally in disposable dir $TMP"
  python3 "$ANALYZE" --capture "$TMP/capture.jsonl" --behavior "$TMP/behavior.json" \
    --project "$PROJECT" --out "$OUT" $EXTRA \
    || { log "analysis returned non-zero"; echo '{"schema":"claude-rabbit/payload-analysis@1","error":"analysis failed"}' > "$OUT"; }
  log "analysis written -> $OUT (disposable dir will be deleted)"
  exit 0
fi

if [ "$mode" = "vm" ]; then
  ZONE="${1:?zone}"; CAPTURE="${2:?capture.jsonl}"; BEHAVIOR="${3:?behavior.json}"; OUT="${4:?out.json}"
  VM="cr-analysis-$(date +%s)"
  # Bulletproof cleanup: server-side max-run-duration DELETE (survives SIGKILL)
  # PLUS a local trap delete. See orchestrate.sh for the same discipline.
  cleanup() {
    log "deleting disposable analysis VM $VM (mandatory)"
    gcloud compute instances delete "$VM" --zone="$ZONE" --quiet >/dev/null 2>&1 || true
  }
  trap cleanup EXIT INT TERM
  log "booting disposable analysis VM $VM (separate from detonation; inert bytes only)"
  # NOTE: the analysis VM needs ADC for the Vertex call, so it boots WITH the
  # default service account scope cloud-platform. It NEVER runs untrusted code —
  # only analyze-payload.py over inert captured bytes — so this is safe. It is
  # NOT tagged cr-sandbox (it is not a detonation VM).
  gcloud compute instances create "$VM" \
    --zone="$ZONE" --machine-type="e2-small" \
    --image-family="debian-12" --image-project="debian-cloud" \
    --scopes="cloud-platform" \
    --max-run-duration=20m --instance-termination-action=DELETE >/dev/null \
    || { log "analysis VM create failed; emitting empty analysis"; echo '{"schema":"claude-rabbit/payload-analysis@1","error":"analysis VM create failed"}' > "$OUT"; exit 0; }

  for i in $(seq 1 30); do
    gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --command="true" >/dev/null 2>&1 && break
    sleep 10
  done
  gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
    --command="sudo apt-get update -y >/dev/null 2>&1; sudo apt-get install -y python3 python3-pip >/dev/null 2>&1; pip3 install --break-system-packages --quiet google-auth requests >/dev/null 2>&1 || pip3 install --quiet google-auth requests >/dev/null 2>&1 || true" >/dev/null 2>&1 || true
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap "$(winpath "$ANALYZE")" "$VM:/tmp/analyze-payload.py" >/dev/null 2>&1 || true
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap "$(winpath "$CAPTURE")" "$VM:/tmp/capture.jsonl" >/dev/null 2>&1 || true
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap "$(winpath "$BEHAVIOR")" "$VM:/tmp/behavior.json" >/dev/null 2>&1 || true
  gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap \
    --command="python3 /tmp/analyze-payload.py --capture /tmp/capture.jsonl --behavior /tmp/behavior.json --project $PROJECT --out /tmp/analysis.json" >/dev/null 2>&1 || true
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap "$VM:/tmp/analysis.json" "$OUT" >/dev/null 2>&1 \
    || echo '{"schema":"claude-rabbit/payload-analysis@1","error":"analysis VM produced no output"}' > "$OUT"
  log "analysis written -> $OUT (VM will be deleted)"
  exit 0
fi

echo "usage: $0 {local <capture> <behavior> <out> [--no-ai] | vm <zone> <capture> <behavior> <out>}" >&2
exit 2
