#!/usr/bin/env bash
#
# persist-forensics.sh — persist a forensic JSON onto a report row via the
# service-role `attach_forensics` RPC.
#
# This is the server-side persistence path. It NEVER hardcodes a key: it reads
# the Supabase secret key from the environment (CR_SUPABASE_SECRET_KEY) and the
# project URL from CR_SUPABASE_URL. In production the sandbox orchestration runs
# where the secret key already lives (the edge-function / server context per
# docs/INFRASTRUCTURE.md §7); locally you may export it transiently for a manual
# persist. The key is never written to disk or the repo.
#
# Usage:
#   CR_SUPABASE_URL=https://<ref>.supabase.co \
#   CR_SUPABASE_SECRET_KEY=sb_secret_... \
#   persist-forensics.sh <owner> <repo> <commit_sha> <forensics.json>
set -uo pipefail

OWNER="${1:?owner}"; REPO="${2:?repo}"; SHA="${3:?commit_sha}"; FJSON="${4:?forensics.json}"
URL="${CR_SUPABASE_URL:-}"
KEY="${CR_SUPABASE_SECRET_KEY:-}"

log() { echo "[persist] $*" >&2; }

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  log "CR_SUPABASE_URL / CR_SUPABASE_SECRET_KEY not set — SKIPPING DB persist."
  log "Forensic JSON remains at: $FJSON (server context persists it in production)."
  exit 0
fi
[ -f "$FJSON" ] || { log "forensics file not found: $FJSON"; exit 1; }

# Build the RPC body: { p_owner_login, p_repo_name, p_commit_sha, p_forensics }
BODY="$(python3 - "$OWNER" "$REPO" "$SHA" "$FJSON" <<'PY'
import json, sys
owner, repo, sha, fjson = sys.argv[1:5]
with open(fjson) as f:
    forensics = json.load(f)
print(json.dumps({
    "p_owner_login": owner,
    "p_repo_name": repo,
    "p_commit_sha": sha,
    "p_forensics": forensics,
}))
PY
)"

log "calling attach_forensics RPC for $OWNER/$REPO @ $SHA"
HTTP=$(curl -s -o /tmp/cr-persist-resp.json -w '%{http_code}' \
  -X POST "$URL/rest/v1/rpc/attach_forensics" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>/dev/null || echo "000")

if [ "$HTTP" = "200" ] || [ "$HTTP" = "204" ]; then
  log "forensics persisted (HTTP $HTTP)."
else
  log "WARNING: persist returned HTTP $HTTP; response:"
  cat /tmp/cr-persist-resp.json >&2 2>/dev/null || true
fi
