#!/usr/bin/env bash
# entrypoint.sh — the Cloud Run Job execution's startup logic. Runs as the
# container's command (its whole lifetime IS one scan: no persistent host, no
# per-scan image build, no Kata/Firecracker microVM layer — the Cloud Run
# container boundary itself is the isolation).
#
# Replaces orchestrate-microvm.sh's per-scan sequence, adapted for this
# substrate:
#   0) validate required env
#   1) register this container's source IP with the gateway (BEFORE any other
#      network activity, so all subsequent traffic attributes to this scan)
#   2) fetch + trust the gateway's forged-TLS CA (BEFORE cloning/running
#      anything untrusted)
#   3) clone the pinned repo at the exact commit SHA into /repo
#   4) kick off the 3-agent OpenCode exploration pass CONCURRENTLY with...
#   5) ...detonate.py (adapted: no resolv.conf rewrite; everything else intact)
#   6) read back the gateway's one-shot forensics capture, reconstruct it as
#      the jsonl assemble-forensics.py expects, run assemble-forensics.py
#      UNCHANGED (+ the agentic findings if produced) to build the final record
#   7) POST the forensic record to attach-forensics with the runner-key header
#   8) exit 0 on full success; on partial failure, still attempt 6-7 with
#      whatever data exists (an honest partial report beats none), but the
#      failure is ALWAYS visible in stderr and NEVER reported as a clean run
#
# Required env (the Job execution is invoked with these):
#   CR_OWNER            github owner segment
#   CR_REPO             github repo segment
#   CR_COMMIT_SHA       the pinned commit sha to detonate
#   CR_SCAN_ID          opaque per-execution id (used for gateway attribution)
#   CR_SUPABASE_URL     e.g. https://<ref>.supabase.co
#   CR_DEEP_RUNNER_KEY  shared secret for attach-forensics (Secret Manager env var)
#
# Optional env (all have sane defaults for a real deployment):
#   CR_GATEWAY_HOST         default cr-harness.cr.internal (falls back to the
#                           raw IP if the private DNS zone is not resolvable)
#   CR_GATEWAY_IP           default 10.200.0.10
#   CR_GATEWAY_PORT         default 8090
#   CR_SUPABASE_ANON_KEY    the publishable key, required by the Functions
#                           gateway in front of attach-forensics (same
#                           double-auth pattern run-deep-queue.sh already uses:
#                           anon key opens the gateway, x-runner-key authorizes
#                           the function itself)
#   CR_BUILD_TIMEOUT_S / CR_RUN_TIMEOUT_S  forwarded to detonate.py
#   CR_AGENT_TIME_BUDGET_S / CR_AGENT_TOKEN_BUDGET / CR_AGENT_MAX_TARGETS
#   CR_GCP_PROJECT / CR_GCP_LOCATION       for the OpenCode/Vertex fallback auth
#   GOOGLE_SERVICE_ACCOUNT_JSON            same Vertex SA JSON the rest of the
#                           app already uses (docs/INFRASTRUCTURE.md §6/§7) —
#                           written to a local file + exported as
#                           GOOGLE_APPLICATION_CREDENTIALS so both the OpenCode
#                           google-vertex provider and the vertex_client.py
#                           fallback authenticate the SAME way, no new mechanism.
set -uo pipefail

log() { echo "[entrypoint] $*" >&2; }
die() { echo "[entrypoint] ERROR: $*" >&2; exit 1; }

# ── 0) fail fast + loud on missing required env — this runs fully unattended ──
: "${CR_OWNER:?CR_OWNER is required}"
: "${CR_REPO:?CR_REPO is required}"
: "${CR_COMMIT_SHA:?CR_COMMIT_SHA is required}"
: "${CR_SCAN_ID:?CR_SCAN_ID is required}"
: "${CR_SUPABASE_URL:?CR_SUPABASE_URL is required}"
: "${CR_DEEP_RUNNER_KEY:?CR_DEEP_RUNNER_KEY is required}"

# Same safe-segment / sha charset the rest of the app already enforces
# (app/api/deep/route.ts SEGMENT_RE / SHA_RE, supabase/functions/attach-forensics
# isSegment). This runs with NO human reviewing the invoking command, so
# owner/repo/sha are validated BEFORE they touch any shell command, git
# argument, or URL — never string-interpolated unchecked.
SEGMENT_RE='^[A-Za-z0-9._-]{1,100}$'
SHA_RE='^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'
[[ "$CR_OWNER" =~ $SEGMENT_RE ]] || die "CR_OWNER fails safe-segment charset: ${CR_OWNER@Q}"
[[ "$CR_REPO"  =~ $SEGMENT_RE ]] || die "CR_REPO fails safe-segment charset: ${CR_REPO@Q}"
[[ "$CR_COMMIT_SHA" =~ $SHA_RE ]] || die "CR_COMMIT_SHA fails safe-sha charset: ${CR_COMMIT_SHA@Q}"
# reject bare "." / ".." (the charset alone permits them) — defense in depth so
# a segment can never resolve to a traversal.
case "$CR_OWNER" in ""|"."|"..") die "CR_OWNER must not be empty, '.' or '..'";; esac
case "$CR_REPO"  in ""|"."|"..") die "CR_REPO must not be empty, '.' or '..'";; esac
# CR_SCAN_ID is opaque but still flows into gateway URLs/paths — constrain it
# to a conservative safe grammar rather than trust it structurally.
SCAN_ID_RE='^[A-Za-z0-9._-]{1,200}$'
[[ "$CR_SCAN_ID" =~ $SCAN_ID_RE ]] || die "CR_SCAN_ID fails safe charset: ${CR_SCAN_ID@Q}"

GATEWAY_IP="${CR_GATEWAY_IP:-10.200.0.10}"
GATEWAY_PORT="${CR_GATEWAY_PORT:-8090}"
GATEWAY_HOST="${CR_GATEWAY_HOST:-cr-harness.cr.internal}"
# Prefer the private-zone hostname (matches what forge_addon.py's telemetry
# recognition already expects — cr-harness.cr.internal — and what detonate.py
# posts phase markers / observations to); fall back to the raw IP if the zone
# doesn't resolve in this environment. Resolved ONCE up front so every gateway
# call below uses a consistent, known-good base URL.
if getent hosts "$GATEWAY_HOST" >/dev/null 2>&1 || python3 -c "import socket,sys; socket.getaddrinfo(sys.argv[1],8090)" "$GATEWAY_HOST" >/dev/null 2>&1; then
  GATEWAY_BASE="http://${GATEWAY_HOST}:${GATEWAY_PORT}"
else
  log "WARNING: ${GATEWAY_HOST} did not resolve — falling back to the raw gateway IP ${GATEWAY_IP}"
  GATEWAY_BASE="http://${GATEWAY_IP}:${GATEWAY_PORT}"
fi
log "gateway base: ${GATEWAY_BASE} (register/ca-cert/forensics API, port ${GATEWAY_PORT}, not intercepted)"

# Control-plane auth for the gateway's /register + /forensics (security review,
# criticals #2/#3). The firewall proves only "from the Cloud Run subnet", which
# CANNOT tell this trusted harness apart from the untrusted repo running in the
# same container. This shared key does. It is held ONLY by the harness (this
# process) and is SCRUBBED from the untrusted build/run environment by detonate.py,
# so the detonated code can neither re-open its own egress passthrough via /register
# nor blank its own evidence via /forensics. Sent only when configured; the gateway
# enforces it when its own CR_FORGE_CONTROL_KEY is set (rollout-safe until then).
FORGE_KEY_HEADER=()
if [ -n "${CR_FORGE_CONTROL_KEY:-}" ]; then
  FORGE_KEY_HEADER=(-H "x-forge-key: ${CR_FORGE_CONTROL_KEY}")
fi

WORK="/tmp/cr-scan"
REPO_DIR="/repo"
mkdir -p "$WORK"
rm -rf "$REPO_DIR"; mkdir -p "$REPO_DIR"

# Track whether we made it far enough to be worth an honest partial report at
# the end. Never overclaim: OVERALL_OK only ever narrows the truth we send,
# it never inflates it — see the honesty handling in step 8 below.
OVERALL_OK=1
FAIL_NOTES=()
note_failure() { OVERALL_OK=0; FAIL_NOTES+=("$1"); log "FAILURE: $1"; }

# ── real, granular progress reporting (the processing-timeline feature) ──────
# Best-effort, fire-and-forget: a stage-reporting hiccup must never affect the
# actual detonation — same "observability only, never load-bearing" contract
# as the enqueue/position/status ops this reuses (deep-queue edge function,
# runner-key-gated). CR_SUPABASE_URL is Supabase's exact project ref, a
# VERIFIED passthrough on the gateway (CONTROL_PLANE_RE in forge_addon.py), so
# this genuinely reaches the function in real time, not forged/blocked.
report_stage() {
  local stage="$1" detail="${2:-}"
  local body
  body="$(python3 -c '
import json, sys
print(json.dumps({"op": "set_stage", "token": sys.argv[1], "stage": sys.argv[2], "detail": sys.argv[3]}))
' "$CR_SCAN_ID" "$stage" "$detail" 2>/dev/null)" || return 0
  local hdrs=(-H "Content-Type: application/json" -H "x-runner-key: ${CR_DEEP_RUNNER_KEY}")
  if [ -n "${CR_SUPABASE_ANON_KEY:-}" ]; then
    hdrs+=(-H "apikey: ${CR_SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${CR_SUPABASE_ANON_KEY}")
  fi
  curl -fsS -m 10 -X POST "${CR_SUPABASE_URL%/}/functions/v1/deep-queue" \
    "${hdrs[@]}" --data-binary "$body" >/dev/null 2>&1 || true
}
report_stage "container_start" "entrypoint running, validating env"

# ── 1) register this container's source IP with the gateway, FIRST ───────────
log "registering scan_id=${CR_SCAN_ID} with the gateway (must happen before any other egress)"
REGISTER_BODY="{\"scan_id\":\"${CR_SCAN_ID}\"}"
if ! curl -fsS -m 15 -X POST "${GATEWAY_BASE}/register" \
      -H "Content-Type: application/json" "${FORGE_KEY_HEADER[@]}" --data-binary "$REGISTER_BODY" >/tmp/cr-register.log 2>&1; then
  # Registration failing means the gateway cannot attribute ANY subsequent
  # traffic from this container to this scan — forensics will come back empty
  # even if the run itself is fine. This is a hard stop: an ungated detonation
  # with no possible forensic attribution is worse than not running at all
  # (silently producing a "clean" report with no real evidence backing it would
  # violate the never-bare-Safe rail).
  die "gateway /register failed (see /tmp/cr-register.log): $(cat /tmp/cr-register.log 2>/dev/null)"
fi
log "registered with gateway"

# ── 1b) point DNS at the gateway BEFORE anything else resolves a name ─────────
# RESTORES a property route-forcing alone does not give you: a genuinely
# non-existent/sinkholed C2 domain fails DNS resolution locally before any
# connection is even attempted, so a condition-gated sample goes silently
# DORMANT — confirmed on a real deployed run (a beacon to a non-resolving
# example domain never appeared in the gateway's capture at all). The gateway
# now runs dnsmasq: real registries/control-plane/source hosts still resolve
# to their REAL IPs (forwarded), everything else resolves to the gateway
# itself, so a condition-gated sample's connection attempt actually happens
# and the forced route + forge can intercept it. Set this early enough to
# cover the clone below too, not just detonate.py.
if ! printf 'nameserver %s\noptions timeout:2 attempts:2\n' "${GATEWAY_IP}" > /etc/resolv.conf 2>/tmp/cr-resolv.log; then
  note_failure "could not write /etc/resolv.conf (see /tmp/cr-resolv.log); DNS stays on the container default, so a non-existent/sinkholed C2 domain may go undetected this run"
fi

# ── 2) fetch + trust the gateway's forged-TLS CA BEFORE running anything untrusted ──
log "fetching gateway CA cert"
CA_DEST=/usr/local/share/ca-certificates/cr-gateway-ca.crt
if curl -fsS -m 15 "${GATEWAY_BASE}/ca-cert" -o "$CA_DEST" 2>/tmp/cr-cacert.log && [ -s "$CA_DEST" ]; then
  if command -v update-ca-certificates >/dev/null 2>&1; then
    update-ca-certificates >/tmp/cr-update-ca.log 2>&1 || log "WARNING: update-ca-certificates reported an issue (see /tmp/cr-update-ca.log); continuing — a non-pinning client may still fail the forged TLS handshake"
  else
    note_failure "update-ca-certificates not available; gateway CA fetched but not installed into the trust store"
  fi
else
  # Mirror the OLD Dockerfile's env var names exactly — detonate.py, npm, and
  # pip already read these, so even if the SYSTEM trust store update above
  # failed/degraded, pointing these at the same file gives every child process
  # one more chance to trust the forged certs.
  note_failure "gateway /ca-cert fetch failed (see /tmp/cr-cacert.log); TLS-pinning-averse clients may not trust the gateway's forged certs this run"
fi
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export PIP_DISABLE_PIP_VERSION_CHECK=1

# ── Vertex/OpenCode auth: same service-account pattern the rest of the app uses ──
# (docs/INFRASTRUCTURE.md §6/§7: GOOGLE_SERVICE_ACCOUNT_JSON + GCP_PROJECT_ID +
# GCP_LOCATION). google-genai's ADC path (used by both the OpenCode
# google-vertex provider and agent/vertex_client.py's fallback) wants a
# credentials FILE, not a raw JSON string in an env var — so we write it once
# here and point GOOGLE_APPLICATION_CREDENTIALS at it. This is the SAME key
# already stored in Supabase secrets; Cloud Run is expected to receive it as a
# Secret-Manager-backed env var, so we only ever read process env, never fetch
# or hardcode a key ourselves.
GCP_PROJECT="${CR_GCP_PROJECT:-${GCP_PROJECT_ID:-}}"
GCP_LOCATION="${CR_GCP_LOCATION:-global}"
if [ -n "${GOOGLE_SERVICE_ACCOUNT_JSON:-}" ]; then
  SA_KEY_PATH="/tmp/cr-sa-key.json"
  # Written with a mode restricting it to this process's own user — it is a
  # live credential for the run's lifetime, not a file to persist or copy.
  ( umask 177; printf '%s' "$GOOGLE_SERVICE_ACCOUNT_JSON" > "$SA_KEY_PATH" )
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$SA_KEY_PATH" >/dev/null 2>&1; then
    export GOOGLE_APPLICATION_CREDENTIALS="$SA_KEY_PATH"
    log "Vertex service-account credential staged for OpenCode/vertex_client.py fallback (project=${GCP_PROJECT:-<unset>} location=${GCP_LOCATION})"
  else
    note_failure "GOOGLE_SERVICE_ACCOUNT_JSON was present but not valid JSON; agentic pass will run without Vertex auth (degrades to skipped, per its own graceful-degradation contract)"
  fi
else
  log "GOOGLE_SERVICE_ACCOUNT_JSON not set — agentic pass will attempt OpenCode without pre-staged ADC (may still work via other ambient credentials; otherwise degrades gracefully)"
fi
# OpenCode config: same shape provision-host.sh already writes for the retired
# per-host path (google-vertex provider, location=global — the 3.x Gemini line
# serves only on the Vertex GLOBAL endpoint, confirmed in vertex_client.py /
# opencode_client.py comments). Written unconditionally (cheap, idempotent);
# OpenCode simply won't be reachable as a working brain if the project/creds
# are absent, and the pass falls back to vertex_client.py per opencode_client.py's
# OpenCodeUnavailable contract either way.
mkdir -p "$HOME/.config/opencode" 2>/dev/null || mkdir -p /root/.config/opencode
OC_CONFIG_DIR="$HOME/.config/opencode"; [ -d "$OC_CONFIG_DIR" ] || OC_CONFIG_DIR=/root/.config/opencode
cat > "${OC_CONFIG_DIR}/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": { "google-vertex": { "options": { "project": "${GCP_PROJECT}", "location": "${GCP_LOCATION}" } } }
}
JSON

# ── 3) shallow clone the pinned repo at the exact commit ──────────────────────
report_stage "cloning" "${CR_OWNER}/${CR_REPO}@${CR_COMMIT_SHA:0:12}"
log "cloning ${CR_OWNER}/${CR_REPO}@${CR_COMMIT_SHA:0:12}"
if git clone --quiet --depth 1 "https://github.com/${CR_OWNER}/${CR_REPO}.git" "$REPO_DIR" 2>/tmp/cr-clone.log; then
  if ! ( cd "$REPO_DIR" && git fetch --quiet --depth 1 origin "$CR_COMMIT_SHA" 2>>/tmp/cr-clone.log && git checkout --quiet "$CR_COMMIT_SHA" 2>>/tmp/cr-clone.log ); then
    # The default-branch HEAD may already BE the pinned commit (depth-1 clone
    # of the branch that commit is on); try a bare checkout before giving up.
    ( cd "$REPO_DIR" && git checkout --quiet "$CR_COMMIT_SHA" 2>>/tmp/cr-clone.log ) \
      || note_failure "could not pin clone to ${CR_COMMIT_SHA} (see /tmp/cr-clone.log); detonating whatever the shallow clone's default branch HEAD is instead"
  fi
else
  die "git clone of ${CR_OWNER}/${CR_REPO} failed (see /tmp/cr-clone.log): $(tail -5 /tmp/cr-clone.log 2>/dev/null)"
fi
PINNED_SHA="$(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "$CR_COMMIT_SHA")"
log "detonation target pinned at ${PINNED_SHA}"

# ── 4+5) agentic exploration pass CONCURRENT with detonation ──────────────────
# Mirrors orchestrate-microvm.sh Phase 3.5: launch the 3-agent OpenCode pass in
# the BACKGROUND so it overlaps detonate.py below (independent resources — the
# agents read the local clone; detonate.py builds+runs it) — wall-clock is
# max(agentic, detonation), not the sum.
AGENT_WORK="$WORK/agent"
AGENTIC_JSON="$AGENT_WORK/agentic-findings.json"
mkdir -p "$AGENT_WORK/results"
KG="$AGENT_WORK/knowledge-graph.json"

AGENT_TIME_BUDGET_S="${CR_AGENT_TIME_BUDGET_S:-90}"
AGENT_TOKEN_BUDGET="${CR_AGENT_TOKEN_BUDGET:-40000}"
AGENT_MAX_TARGETS="${CR_AGENT_MAX_TARGETS:-6}"

(
  set -uo pipefail
  export PYTHONPATH="/opt/cr/agent:${PYTHONPATH:-}"
  if python3 /opt/cr/agent/knowledge_graph.py "$REPO_DIR" --out "$KG" 1>&2; then
    # --trap-ip: a REQUIRED argument of parallel_agents.py inherited from the
    # old microVM architecture, where it was the per-run forge bridge IP
    # (10.200.0.1) that a REAL per-target detonate() relay would embed in a
    # `CR_TRAP_IP=<ip> sudo bash run-harness.sh run-target ...` SSH command
    # (see agent/detonator.py build_detonate_command). In THIS architecture we
    # invoke parallel_agents.py with --explore-only, which replaces ssh_exec
    # with `explore_only_relay` (a pure no-op returning an empty valid
    # observation — see parallel_agents.py's explore_only_relay) — so
    # build_detonate_command / trap_ip is NEVER actually reached; the value is
    # plumbed through but structurally inert for this call shape. detonator.py
    # still validates it against TRAP_IP_RE (^10\.200\.\d{1,3}\.\d{1,3}$)
    # defensively even when unused, so we pass the new gateway's real address
    # (10.200.0.10) rather than a stale/fictitious one — it satisfies the
    # grammar and, if this code path is ever changed later to a real per-target
    # relay against the new gateway, it would already point somewhere correct
    # instead of somewhere meaningless.
    python3 /opt/cr/agent/parallel_agents.py --engine opencode --explore-only \
      --repo-dir "$REPO_DIR" --graph "$KG" --commit-sha "$CR_COMMIT_SHA" \
      --name "ag-${CR_SCAN_ID}" --trap-ip "$GATEWAY_IP" \
      --results-dir "$AGENT_WORK/results" \
      --time-budget-s "$AGENT_TIME_BUDGET_S" --token-budget "$AGENT_TOKEN_BUDGET" \
      --max-targets "$AGENT_MAX_TARGETS" \
      --project "${GCP_PROJECT}" --location "${GCP_LOCATION}" \
      --out "$AGENTIC_JSON" 1>/dev/null 2>&2 \
      || echo "[entrypoint] agentic pass degraded (parallel_agents.py exited non-zero)" >&2
  else
    echo "[entrypoint] agentic pass skipped (knowledge graph build failed)" >&2
  fi
) &
AGENTIC_PID=$!
log "agentic exploration pass launched in background (pid ${AGENTIC_PID}), running concurrently with detonation"
report_stage "agents_exploring" "3 agents (install-time, runtime, payload) reading the code in parallel"

# ── 5) detonate.py — the adapted in-container harness ──────────────────────────
report_stage "installing" "installing dependencies with the repo's own package manager"
log "=== BUILD+RUN phase: installing deps + executing under strace, egress forced through the gateway route ==="
export CR_REPO_DIR="$REPO_DIR"
export CR_TELEMETRY_HOST="$GATEWAY_HOST"
export CR_GATEWAY_IP="$GATEWAY_IP"
export CR_BUILD_TIMEOUT="${CR_BUILD_TIMEOUT_S:-240}"
export CR_RUN_TIMEOUT="${CR_RUN_TIMEOUT_S:-25}"
export CR_OBSERVATION_PATH="$WORK/observation.json"
if ! python3 /opt/cr/detonate.py; then
  note_failure "detonate.py exited non-zero"
fi
log "=== detonation complete ==="

# Join the agentic pass (usually already finished; this just guarantees the
# findings file is complete before we read it).
wait "$AGENTIC_PID" 2>/dev/null || log "agentic pass wait returned non-zero (already logged above)"

# ── 6) read the gateway's one-shot forensics capture, reconstruct jsonl, assemble ──
log "reading back gateway forensics capture (one-shot; scan_id=${CR_SCAN_ID})"
CAPTURE_JSONL="$WORK/capture.jsonl"
if RAW="$(curl -fsS -m 30 "${FORGE_KEY_HEADER[@]}" "${GATEWAY_BASE}/forensics?scan_id=${CR_SCAN_ID}" 2>/tmp/cr-forensics-fetch.log)"; then
  # The gateway returns {"scan_id":..., "records":[ {...}, {...} ]} — one JSON
  # object per captured network event. assemble-forensics.py expects a
  # NEWLINE-DELIMITED JSON file (one object per line), matching the OLD
  # microVM forge's on-disk capture format — reconstruct that shape exactly,
  # never touching assemble-forensics.py's own parsing logic.
  #
  # ONE NORMALIZATION IS REQUIRED here (not a change to assemble-forensics.py
  # itself): the Cloud Run gateway's forge_addon.py tags the harness's own
  # telemetry (the detonate.py phase-marker beacon + observation POST to
  # cr-harness.cr.internal) with kind "harness_telemetry", distinctly from a
  # generic "http_request" — a deliberate improvement over the old single-run
  # forge, which never needed to disambiguate because it only ever served one
  # run at a time. assemble-forensics.py's `load()` (UNCHANGED, per the task's
  # own instruction) only recognizes kind == "http_request" for BOTH the
  # phase-marker beacon and the observation payload; it silently drops
  # anything else via `if kind != "http_request": continue`. Since we must not
  # edit assemble-forensics.py, the fix belongs here: rewrite
  # "harness_telemetry" back to "http_request" while reconstructing the jsonl,
  # so the existing, unchanged matching logic still finds these lines by host
  # (TELEMETRY_HOST) + path, exactly as it did against the old microVM forge's
  # capture format.
  if ! printf '%s' "$RAW" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception as e:
    print(f"[entrypoint] forensics response was not valid JSON: {e}", file=sys.stderr)
    sys.exit(1)
records = data.get("records", []) if isinstance(data, dict) else []
n = 0
with open(sys.argv[1], "w", encoding="utf-8") as f:
    for rec in records:
        if not isinstance(rec, dict):
            continue
        if rec.get("kind") == "harness_telemetry":
            rec = {**rec, "kind": "http_request"}
        f.write(json.dumps(rec) + "\n")
        n += 1
print(f"[entrypoint] reconstructed {n} capture record(s)", file=sys.stderr)
' "$CAPTURE_JSONL" 2>&1 | tee -a /tmp/cr-forensics-fetch.log >&2; then
    note_failure "could not parse the gateway's /forensics response into jsonl (see /tmp/cr-forensics-fetch.log)"
    : > "$CAPTURE_JSONL"
  fi
else
  note_failure "gateway /forensics fetch failed (see /tmp/cr-forensics-fetch.log): $(cat /tmp/cr-forensics-fetch.log 2>/dev/null)"
  : > "$CAPTURE_JSONL"  # empty capture — assemble-forensics.py handles this (no captured egress, not a crash)
fi

# Fold this container's own local observation (build/run success, credential
# reads, exec/connect counts) into the capture stream as one MORE jsonl line,
# shaped exactly like the old guest's telemetry POST that forge_addon.py
# captured and assemble-forensics.py already knows how to find (kind
# "http_request", host == TELEMETRY_HOST, path "/cr-telemetry", body_b64 =
# the observation JSON). detonate.py already best-effort POSTs this same body
# to the gateway itself (so it MAY already be present in $RAW above); we also
# inject it directly here from the authoritative local file so the run is not
# at the mercy of that POST landing before the one-shot forensics read.
if [ -s "$CR_OBSERVATION_PATH" ]; then
  python3 -c '
import base64, json, sys, time
obs_path, out_path, telemetry_host = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(obs_path, "r", encoding="utf-8") as f:
        obs_raw = f.read()
    json.loads(obs_raw)  # validate it is real JSON before we wrap it
except Exception as e:
    print(f"[entrypoint] local observation file unreadable/invalid, skipping fold-in: {e}", file=sys.stderr)
    sys.exit(0)
line = {
    "kind": "http_request",
    "host": telemetry_host,
    "path": "/cr-telemetry",
    "method": "POST",
    "body_b64": base64.b64encode(obs_raw.encode("utf-8")).decode("ascii"),
    "body_len": len(obs_raw),
    "t": time.time(),
}
with open(out_path, "a", encoding="utf-8") as f:
    f.write(json.dumps(line) + "\n")
print("[entrypoint] folded local observation into the capture stream", file=sys.stderr)
' "$CR_OBSERVATION_PATH" "$CAPTURE_JSONL" "$GATEWAY_HOST" 2>&1 | tee -a /tmp/cr-forensics-fetch.log >&2
else
  note_failure "no local observation file at ${CR_OBSERVATION_PATH} — detonate.py may have crashed before writing it; the forensic record's what_it_ran/in_vm_behavior sections will be empty, which assemble-forensics.py already renders as an honest 'did not build/run' outcome, never a false clean"
fi

report_stage "assembling_forensics" "reconstructing the capture into the forensic record"
log "assembling forensic record (assemble-forensics.py, UNCHANGED script/schema)"
FORENSICS_JSON="$WORK/forensics.json"
AGENTIC_ARG=()
[ -s "$AGENTIC_JSON" ] && AGENTIC_ARG=(--agentic "$AGENTIC_JSON")
if ! python3 /opt/cr/assemble-forensics.py "$CAPTURE_JSONL" --owner "$CR_OWNER" --repo "$CR_REPO" --sha "$CR_COMMIT_SHA" \
      "${AGENTIC_ARG[@]}" > "$FORENSICS_JSON" 2>/tmp/cr-assemble.log; then
  # Even assembly failing is not the end: attach-forensics needs SOMETHING
  # that looksLikeForensicRecord (schema string OR a load-bearing section) to
  # persist anything at all. Emit a minimal, honestly-degraded record rather
  # than silently produce nothing — this keeps the "never overclaim a clean
  # result" rail intact: a report that says "the sandbox run did not complete"
  # is truthful; a report with no run data (falling through in lib/scan.ts to
  # whatever the fast-path already said) is a worse outcome for a repo that
  # WAS actually escalated to the sandbox.
  note_failure "assemble-forensics.py failed (see /tmp/cr-assemble.log); writing a minimal degraded record instead of nothing"
  python3 - "$CR_OWNER" "$CR_REPO" "$CR_COMMIT_SHA" > "$FORENSICS_JSON" <<'PY'
import json, sys
owner, repo, sha = sys.argv[1:4]
print(json.dumps({
    "schema": "claude-rabbit/forensic-record/microvm-1",
    "generated_at": "",
    "target": f"{owner}/{repo}",
    "what_it_ran": {"project_type": None, "auto_build_succeeded": False, "ran_without_crash": False},
    "network_intent": {"attempts": [], "attempt_count": 0, "intended_destinations": [], "geolocations": []},
    "in_vm_behavior": {"high_value_credential_reads": 0, "high_value_credential_reads_succeeded": 0,
                        "credential_reads_detail": [], "suspicious_binaries": [], "files_dropped_count": 0,
                        "files_dropped": [], "high_cpu": False, "run_cpu_cores_busy": 0, "process_exec_count": 0},
    "payload_analysis": {"decoded_payloads": [], "ai_intent_summary": None, "ai_model": None, "ai_analysis_error": None},
    "containment": {"external_monitor_saw_egress": False, "in_vm_saw_egress": False,
                     "no_real_packet_reached_destination": False, "non_tcp_egress_contained": None,
                     "containment_notes": "Forensics assembly failed for this run; containment could not be positively confirmed or refuted from this record alone.",
                     "egress_control_probe": "not-confirmed"},
    "verdict": {"dynamic_score": 1, "score_color": "red", "one_word": "Dangerous",
                "headline": "", "code_behavior_findings": [], "captured_network_intent": [],
                "egress_intercepted_count": 0, "attack_egress_intercepted": False,
                "supply_chain_egress": [], "not_verified": ["sandbox run did not produce a complete forensic record"]},
    "honesty": {"possibly_dormant_unverified": True,
                "notes": ["The sandbox run did not complete cleanly; this is a degraded/partial record, not a clean bill of health."]},
    "agentic": {},
}))
PY
fi
log "forensic record ready at ${FORENSICS_JSON}"

# ── 7) POST the forensic record to attach-forensics ────────────────────────────
report_stage "persisting" "attaching forensics to the report row"
log "attaching forensics to the report (attach-forensics)"
PAYLOAD="$WORK/payload.json"
python3 - "$FORENSICS_JSON" "$CR_OWNER" "$CR_REPO" "$CR_COMMIT_SHA" > "$PAYLOAD" <<'PY'
import json, sys
forensics_path, owner, repo, sha = sys.argv[1:5]
with open(forensics_path, encoding="utf-8") as f:
    forensics = json.load(f)
print(json.dumps({"owner": owner, "repo": repo, "sha": sha, "forensics": forensics}))
PY

ATTACH_HEADERS=(-H "Content-Type: application/json" -H "x-runner-key: ${CR_DEEP_RUNNER_KEY}")
if [ -n "${CR_SUPABASE_ANON_KEY:-}" ]; then
  # The Supabase Functions gateway in front of attach-forensics requires a
  # valid apikey/JWT before the function body ever runs (same double-auth
  # pattern sandbox/run-deep-queue.sh and app/api/deep/route.ts already use):
  # anon/publishable key opens the gateway, x-runner-key authorizes the
  # function itself. Without it, a missing anon header means the gateway
  # itself 401s before our runner key is ever checked.
  ATTACH_HEADERS+=(-H "apikey: ${CR_SUPABASE_ANON_KEY}" -H "Authorization: Bearer ${CR_SUPABASE_ANON_KEY}")
fi

ATTACH_OK=0
# --retry: a real deployed run hit a one-off "Failed sending HTTP POST
# request" against this exact endpoint (a transient send-phase failure, not
# reproducible from a separate real GCE VM issuing the same POST through the
# same gateway/route at various payload sizes — so not a size or containment-
# logic issue) — this is exactly the class of transient network hiccup a
# real outbound POST should tolerate. --retry-all-errors covers a failed SEND
# too (plain --retry only retries on a set of response codes / connect
# failures), and --http1.1 sidesteps any HTTP/2 negotiation edge case between
# this container's curl and mitmproxy's raw ignore_connection relay.
#
# Deliberately NOT using -f here: on a non-2xx response -f discards the
# response BODY entirely, which is exactly the diagnostic info needed when
# this fails (the real error reason from the gateway/function) — status is
# checked explicitly via -w instead, and the body is always logged.
ATTACH_HTTP_CODE=$(curl -sS -m 30 --http1.1 --retry 3 --retry-all-errors --retry-delay 2 \
     -o /tmp/cr-attach-body.log -w "%{http_code}" \
     -X POST "${CR_SUPABASE_URL%/}/functions/v1/attach-forensics" \
     "${ATTACH_HEADERS[@]}" --data-binary @"$PAYLOAD" 2>/tmp/cr-attach.log)
CURL_RC=$?
{
  echo "curl_exit=${CURL_RC} http_code=${ATTACH_HTTP_CODE}"
  echo "--- response body ---"
  cat /tmp/cr-attach-body.log 2>/dev/null
} >> /tmp/cr-attach.log
if [ "$CURL_RC" -eq 0 ] && [ "$ATTACH_HTTP_CODE" -ge 200 ] && [ "$ATTACH_HTTP_CODE" -lt 300 ]; then
  ATTACH_OK=1
  log "forensics attached to report: $(cat /tmp/cr-attach-body.log)"
else
  note_failure "attach-forensics POST failed after retries (see /tmp/cr-attach.log): $(cat /tmp/cr-attach.log 2>/dev/null)"
fi

# ── 8) exit status — never silently swallow a failure, never overclaim success ──
if [ ${#FAIL_NOTES[@]} -gt 0 ]; then
  log "run completed with ${#FAIL_NOTES[@]} recorded failure(s):"
  for n in "${FAIL_NOTES[@]}"; do log "  - $n"; done
fi
if [ "$ATTACH_OK" != 1 ]; then
  # The one outcome that must NEVER look like success: we could not tell the
  # app anything at all about this run. Exit non-zero so the Job execution is
  # marked failed and is visible to whatever retries/alerts on Job failures —
  # a silent green exit here is exactly the "confident wrong Safe" failure
  # mode this product exists to prevent, just one layer removed (a report that
  # never got attached reads to the user as "still on the fast-path verdict",
  # which is honest, but the OPERATOR must still see this run failed).
  die "forensics could not be attached to the report; exiting non-zero so this Job execution is marked failed"
fi
if [ "$OVERALL_OK" != 1 ]; then
  log "completed with partial degradation (forensics WERE attached; see the failure notes above) — exiting 0 since the report itself is honest about what was/wasn't verified"
fi
log "scan complete"
exit 0
