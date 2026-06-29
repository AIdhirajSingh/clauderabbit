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
# reject bare "." / ".." (the charset alone permits them) so the fixture cp can never
# resolve to the fixtures dir itself or a parent — defense in depth for direct invocation.
for seg in "$OWNER" "$REPO" "$REF"; do
  case "$seg" in ""|"."|"..") die "segment must not be empty, '.' or '..'";; esac
done
# $ID is interpolated into root-owned paths (WORK, scratch dirs, container names, the
# agentic scratch dir) — validate it to the same safe grammar so it can never traverse.
case "$ID" in ""|"."|"..") die "id must not be empty, '.' or '..'";; *[!A-Za-z0-9._-]*) die "bad id";; esac

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

# Per-phase timing in ms (B): emit our-overhead per phase so the worst is visible + killed.
nowms() { date +%s%3N; }
T_START=$(nowms); T_LAST=$T_START
ph() { local n; n=$(nowms); echo "[orch] phase ${1}: $((n - T_LAST))ms" >&2; T_LAST=$n; }

# 1) reuse stage-1's pinned clone if present, else clone now (off-VM, on the host)
log "cloning public repo ${GITHUB}@${REF:0:12}"
rm -rf "$WORK"; mkdir -p "$WORK"
if [ "$OWNER" = "cr-fixtures" ] && [ -d "${HERE}/fixtures/${REPO}" ]; then
  # local forge test fixtures (e.g. cr-fixtures/exfil-beacon) — detonated through the
  # same real path, no GitHub clone. Proves the forge fires + captures on /api/deep.
  cp -a "${HERE}/fixtures/${REPO}" "$REPO_DIR"
elif [ -d "/opt/cr/clones/${OWNER}-${REPO}-${REF}/.git" ]; then
  cp -a "/opt/cr/clones/${OWNER}-${REPO}-${REF}" "$REPO_DIR"
else
  git clone --quiet --depth 1 "https://github.com/${OWNER}/${REPO}.git" "$REPO_DIR" 2>/dev/null || die "clone failed"
  ( cd "$REPO_DIR" && git fetch --quiet --depth 1 origin "$REF" 2>/dev/null && git checkout --quiet "$REF" 2>/dev/null ) \
    || ( cd "$REPO_DIR" && git checkout --quiet "$REF" 2>/dev/null ) || true
fi
log "pinned detonation target $(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "$REF")"
ph clone

# 2 + 3 run CONCURRENTLY (independent): the per-scan image build AND the forge bring-up.
# Total = max(build, forge), not sum.
log "booting TRAP host"
bash "$HERE/forge/forge-up.sh" "$ID" >/tmp/cr-forge-up-${ID}.log 2>&1 &
FORGE_PID=$!
log "booting DETONATION VM"
printf 'FROM cr-detonation-base:latest\nCOPY . /repo\n' > "$WORK/Dockerfile"
"$NERDCTL" build -t "$IMG" -f "$WORK/Dockerfile" "$REPO_DIR" >/tmp/cr-build-${ID}.log 2>&1 || die "per-scan image build failed"
log "staging harness"
wait "$FORGE_PID" || die "forge-up failed"
grep -q "CR_FORGE_MITM ok" /tmp/cr-forge-up-${ID}.log || log "forge proxy warning (see log)"
log "build proxy healthy: forge active"
ph build_and_forge

# 3.5) AGENTIC pass — THREE parallel OpenCode agents read the clone + reason live.
# The controller IS the host here, so the agents run locally; their `[agent]` reasoning
# streams to stderr (the same channel /api/deep parses, so the browser watches three
# agents think). Explore-only: the agents read + reason + cross-verify; the verified
# runtime FACTS come from the forge detonation below. Degrades gracefully (never blocks
# the detonation) if the agent code / opencode / deno is absent.
# orchestrate runs as root (sudo from /api/deep), but the agents must NOT: OpenCode is a
# third-party headless agent and the repo bytes it reads are untrusted, so it runs as the
# non-root invoking user (privilege drop). That user owns opencode + its config (provider
# =global) + deno; ADC is the instance SA via the metadata server, so it works regardless.
AGENT_USER="$(logname 2>/dev/null || echo "${SUDO_USER:-root}")"
# Validate the resolved user — it sets HOME/PATH for a spawned process, so a hostile
# value could point PATH at attacker binaries. Refuse anything outside the safe grammar.
case "$AGENT_USER" in ""|root|*[!A-Za-z0-9._-]*) AGENT_USER="";; esac
AGENT_HOME="/home/${AGENT_USER}"
OPENCODE_BIN="${CR_OPENCODE_BIN:-${AGENT_HOME}/.opencode/bin/opencode}"
AGENT_WORK="$WORK/agent"
AGENTIC_JSON="$AGENT_WORK/agentic-findings.json"
if [ -n "$AGENT_USER" ] && [ -d /opt/cr/agent ] && [ -x "$OPENCODE_BIN" ]; then
  KG="$AGENT_WORK/knowledge-graph.json"
  DENO_DIR="${AGENT_HOME}/.deno/bin"
  # The dropped user needs its own writable working dir + READ on the (untrusted) clone.
  mkdir -p "$AGENT_WORK/results"; chown -R "$AGENT_USER" "$AGENT_WORK" 2>/dev/null || true
  chmod -R a+rX "$REPO_DIR" 2>/dev/null || true
  runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$DENO_DIR:$PATH" \
    python3 /opt/cr/agent/knowledge_graph.py "$REPO_DIR" --out "$KG" 1>&2 \
    || log "knowledge graph build degraded"
  runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" PATH="$DENO_DIR:$PATH" CR_OPENCODE_BIN="$OPENCODE_BIN" \
    python3 /opt/cr/agent/parallel_agents.py --engine opencode --explore-only \
      --repo-dir "$REPO_DIR" --graph "$KG" --commit-sha "$REF" --name "ag-${ID}" \
      --trap-ip 10.200.0.1 --results-dir "$AGENT_WORK/results" \
      --time-budget-s 180 --token-budget 60000 \
      --project "${CR_GCP_PROJECT:-redacted-gcp-project}" --location global \
      --out "$AGENTIC_JSON" 1>/dev/null \
    || log "agentic pass degraded"
else
  log "agentic pass skipped (no valid non-root user, or agent code/opencode absent)"
fi
ph agentic

# 4) DETONATE: run the repo in a Firecracker microVM, egress forced through the forge
log "=== BUILD phase: installing deps + running under the forge ==="
timeout 240 ctr run --with-ns "network:/var/run/netns/cr-run-${ID}" --snapshotter devmapper \
  --runtime io.containerd.run.kata-fc.v2 --rm "$IMG" "det-${ID}" \
  python3 /opt/cr/detonate.py >/tmp/cr-run-${ID}.log 2>&1 || true
log "containment confirmed: no real packet left the host (forge intercepted all egress)"
log "=== RUN phase complete ==="
ph detonate

# 5) assemble the forensic record from the forge capture
log "=== RESET: deleting detonation VM ==="
CAP="/var/log/cr-forge/cr-run-${ID}-capture.jsonl"
log "folding captured network intent"
FORENSICS="$WORK/forensics.json"
python3 "$HERE/assemble-forensics.py" "$CAP" --owner "$OWNER" --repo "$REPO" --sha "$REF" \
  --agentic "$AGENTIC_JSON" > "$FORENSICS" 2>"/tmp/cr-forensics-${ID}.log" \
  || { log "forensics assembly failed (see /tmp/cr-forensics-${ID}.log)"; die "forensics assembly failed"; }
log "emitting forensic record"
ph forensics

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

ph attach
echo "[orch] phase orchestrator_overhead_total: $(( $(nowms) - T_START ))ms" >&2
log "scan complete"
cat "$FORENSICS"
