#!/usr/bin/env bash
#
# run-deep-queue.sh — the deep-sandbox RUNNER (the wiring that turns an
# escalation into a REAL detonation, BUG-3).
#
# The scan edge function escalates a repo by writing its report with deep=true
# and forensics_json=NULL — that row IS the pending-deep queue. This runner, on a
# trusted controller (gcloud + Vertex ADC; the GCP sandbox host), drains that
# queue: for each pending repo it runs the proven `orchestrate.sh` engine
# (provision VM -> clone -> build -> RUN under the sinkhole -> capture real
# forensic evidence -> tear the VM down), then POSTs the forensic record to the
# `attach-forensics` edge function, which writes it onto the report row via the
# service-role `attach_forensics` RPC. The report then becomes a REAL "Sandbox
# run" (forensics present => _ranSandbox true => legitimate runtime claims) and
# the board's geo map + deep-run count rise off genuine evidence.
#
# It never holds the Supabase service key: persistence goes through the edge
# function (which has the key) and is authorized by CR_DEEP_RUNNER_KEY.
#
# Modes:
#   run-deep-queue.sh --zone us-central1-a --all [--limit N]
#   run-deep-queue.sh --zone us-central1-a --repo owner/repo [--sha SHA]
#   run-deep-queue.sh --zone us-central1-a --fixture path.tar.gz --as owner/repo --sha SHA
#
# Env:
#   CR_SUPABASE_URL            (default: https://mjvlczaytkhvsolnhhkz.supabase.co)
#   CR_SUPABASE_ANON_KEY       (default: the public publishable key)
#   CR_DEEP_RUNNER_KEY         (required to persist; matches the edge secret)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ORCH="$HERE/orchestrate.sh"

SB_URL="${CR_SUPABASE_URL:-https://mjvlczaytkhvsolnhhkz.supabase.co}"
ANON="${CR_SUPABASE_ANON_KEY:-sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B}"
RUNNER_KEY="${CR_DEEP_RUNNER_KEY:-}"

ZONE=""
MODE=""
REPO=""
SHA=""
FIXTURE=""
AS_REPO=""
LIMIT=5
AGENTIC="${CR_AGENTIC:-1}"   # the moat brain on by default for real escalations

log() { echo "[deep-runner] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --zone) ZONE="$2"; shift 2;;
    --all) MODE="all"; shift;;
    --repo) MODE="repo"; REPO="$2"; shift 2;;
    --sha) SHA="$2"; shift 2;;
    --fixture) MODE="fixture"; FIXTURE="$2"; shift 2;;
    --as) AS_REPO="$2"; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    *) die "unknown arg: $1";;
  esac
done

[ -n "$ZONE" ] || die "--zone required (e.g. us-central1-a)"
[ -f "$ORCH" ] || die "orchestrate.sh not found at $ORCH"

# A safe slug for the run name (orchestrate names VMs cr-sbx-<name>-<ts>).
slugify() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '-' | tr 'A-Z' 'a-z' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//' | cut -c1-30; }

# Persist a forensic record to its report via the attach-forensics edge function.
# Returns 0 on success. Never echoes the runner key.
persist() {
  local owner="$1" repo="$2" sha="$3" fjson="$4"
  if [ -z "$RUNNER_KEY" ]; then
    log "CR_DEEP_RUNNER_KEY not set — forensics captured at $fjson but NOT persisted (set the key + the edge secret to persist)."
    return 0
  fi
  [ -f "$fjson" ] || { log "no forensics file to persist: $fjson"; return 1; }
  local body
  body="$(python3 - "$owner" "$repo" "$sha" "$fjson" <<'PY'
import json, sys
owner, repo, sha, fjson = sys.argv[1:5]
with open(fjson) as f:
    forensics = json.load(f)
print(json.dumps({"owner": owner, "repo": repo, "sha": sha, "forensics": forensics}))
PY
)"
  # Per-invocation temp file so concurrent persists never race on a shared path.
  local resp code
  resp="$(mktemp 2>/dev/null || echo "/tmp/cr-attach-resp.$$.json")"
  code="$(curl -s -o "$resp" -w '%{http_code}' \
    -X POST "$SB_URL/functions/v1/attach-forensics" \
    -H "apikey: $ANON" \
    -H "Authorization: Bearer $ANON" \
    -H "x-runner-key: $RUNNER_KEY" \
    -H "Content-Type: application/json" \
    --data-binary "$body" 2>/dev/null || echo "000")"
  if [ "$code" = "200" ]; then
    log "persisted forensics for $owner/$repo (HTTP 200): $(cat "$resp" 2>/dev/null)"
    rm -f "$resp" 2>/dev/null || true
    return 0
  fi
  log "WARNING: persist for $owner/$repo returned HTTP $code: $(cat "$resp" 2>/dev/null)"
  rm -f "$resp" 2>/dev/null || true
  return 1
}

# Run one repo through the engine, then persist. Returns the orchestrate rc.
run_one_github() {
  local owner="$1" repo="$2" sha="$3"
  # The owner/repo come from DB rows (user-influenceable via a scan request).
  # Validate them BEFORE they flow into orchestrate.sh -> git clone / gcloud VM
  # names. orchestrate.sh re-validates (defense in depth); we fail fast here.
  printf '%s' "$owner" | grep -Eq '^[A-Za-z0-9._-]{1,100}$' || { log "skip: invalid owner '$owner'"; return 1; }
  printf '%s' "$repo"  | grep -Eq '^[A-Za-z0-9._-]{1,100}$' || { log "skip: invalid repo '$repo'"; return 1; }
  local name; name="$(slugify "${owner}-${repo}")"
  log "=== DETONATING $owner/$repo (name=$name) ==="
  CR_AGENTIC="$AGENTIC" bash "$ORCH" --zone "$ZONE" --github "${owner}/${repo}" --name "$name"
  local rc=$?
  local fjson="$HERE/results/${name}-forensics.json"
  if [ -f "$fjson" ]; then
    persist "$owner" "$repo" "$sha" "$fjson"
  else
    log "WARNING: no forensic record produced for $owner/$repo (orchestrate rc=$rc) — not persisting."
  fi
  return $rc
}

case "$MODE" in
  repo)
    [ -n "$REPO" ] || die "--repo owner/repo required"
    owner="${REPO%%/*}"; repo="${REPO#*/}"
    [ -n "$owner" ] && [ -n "$repo" ] && [ "$owner" != "$repo" ] || die "bad --repo (want owner/repo): $REPO"
    run_one_github "$owner" "$repo" "${SHA:-unknown}"
    ;;
  fixture)
    [ -f "$FIXTURE" ] || die "--fixture file not found: $FIXTURE"
    [ -n "$AS_REPO" ] || die "--as owner/repo required with --fixture"
    owner="${AS_REPO%%/*}"; repo="${AS_REPO#*/}"
    name="$(slugify "${owner}-${repo}")"
    log "=== DETONATING fixture $FIXTURE as $AS_REPO (name=$name) ==="
    CR_AGENTIC="$AGENTIC" bash "$ORCH" --zone "$ZONE" --tarball "$FIXTURE" --name "$name"
    fjson="$HERE/results/${name}-forensics.json"
    [ -f "$fjson" ] && persist "$owner" "$repo" "${SHA:-unknown}" "$fjson" \
      || log "WARNING: no forensic record for fixture $AS_REPO"
    ;;
  all)
    log "draining the pending-deep queue (reports with deep=true and forensics_json IS NULL)"
    rows="$(curl -s "$SB_URL/rest/v1/reports?deep=eq.true&forensics_json=is.null&select=owner_login,repo_name,commit_sha&order=created_at.asc&limit=$LIMIT" \
      -H "apikey: $ANON" -H "Authorization: Bearer $ANON" 2>/dev/null || echo '[]')"
    n="$(printf '%s' "$rows" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
    log "pending deep runs: $n"
    [ "$n" = "0" ] && { log "nothing to run."; exit 0; }
    # Iterate without a subshell so failures don't abort the loop.
    while IFS=$'\t' read -r owner repo sha; do
      [ -n "$owner" ] || continue
      run_one_github "$owner" "$repo" "${sha:-unknown}" || log "  $owner/$repo run returned non-zero (continuing)"
    done < <(printf '%s' "$rows" | python3 -c 'import json,sys
for r in json.load(sys.stdin):
    print("\t".join([r.get("owner_login",""), r.get("repo_name",""), r.get("commit_sha","")]))')
    ;;
  *)
    die "pick a mode: --all | --repo owner/repo | --fixture path --as owner/repo"
    ;;
esac

log "deep-runner done."
