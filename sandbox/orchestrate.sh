#!/usr/bin/env bash
#
# orchestrate.sh — the deep-path orchestrator for the MONITORED-SINKHOLE engine.
#
# Runs ONE scan end to end against an ephemeral detonation VM, with a controlled
# build phase (registry-allowlist proxy) and a monitored-sinkhole run phase
# (DNS + iptables DNAT to a controlled trap), then off-VM payload analysis and a
# forensic record. The detonation philosophy: let the code do what it would do,
# watch ALL of it, but NEVER let a single real packet reach a real destination.
#
# Pipeline:
#   1. Ensure the hermetic network (deny-1000 egress + pri-800 subnet allow +
#      trap ingress).
#   2. Boot the TRAP host (external IP, NOT cr-sandbox-tagged): dnsmasq sinkhole
#      DNS, catch-all sink, registry-allowlist build proxy, tcpdump pcap, and
#      containment hardening (ip_forward=0, FORWARD DROP, no MASQUERADE).
#   3. Boot the DETONATION VM (NO external IP, --no-service-account --no-scopes,
#      cr-sandbox-tagged => deny-egress). It can reach ONLY the trap (subnet).
#   4. Stage harness + observer + sinkhole-flip + target.
#   5. BUILD: install deps via the trap proxy (registries only) under observation.
#   6. Prove containment: a control probe to a real host must NOT reach it.
#   7. RUN: flip to the sinkhole (DNS+DNAT -> trap), run target under observation.
#   8. Collect the in-VM behavior report + the trap capture (external monitor).
#   9. DELETE the detonation VM (per-scan reset), keeping the trap (holds capture).
#  10. Isolated analysis (separate disposable env): decode payloads, GeoIP intended
#      IPs, Gemini intent summary.
#  11. Emit the forensic JSON; compute the honest verdict; persist (optional).
#  12. DELETE the trap. End with NO VMs.
#
# BULLETPROOF CLEANUP (the prior run orphaned a VM when the process died):
#   - Every VM is booted with --max-run-duration + --instance-termination-action
#     =DELETE: a SERVER-SIDE dead-man's switch that deletes the VM even if THIS
#     process is SIGKILL'd (bash traps do not run on SIGKILL).
#   - A name is recorded to a persistent file BEFORE create, so an interrupted
#     create still leaves a name to reconcile.
#   - A trap on EXIT INT TERM deletes every recorded VM and verifies it is gone.
#   - A final prefix sweep deletes any cr-sbx-/cr-trap-/cr-analysis- stragglers.
#
# Usage:
#   orchestrate.sh --zone us-central1-a --tarball ./fixtures/exfil-c2.tar.gz --name exfil
#   orchestrate.sh --zone us-central1-a --github sindresorhus/yocto-queue --name yocto
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NET="$HERE/net/setup-network.sh"
TRAP_HOST="$HERE/net/trap-host.sh"
PROVISION="$HERE/golden-image/startup-provision.sh"
OBSERVE="$HERE/harness/observe.py"
HARNESS="$HERE/harness/run-harness.sh"
SINKD="$HERE/harness/sinkd.py"
FLIP="$HERE/harness/sinkhole-flip.sh"
FORENSICS="$HERE/harness/forensics.py"
VERDICT="$HERE/verdict.py"
RUN_ANALYSIS="$HERE/analysis/run-analysis.sh"
# Phase 2 — agentic sandbox brain (runs OFF-VM on the controller). Opt-in via
# CR_AGENTIC=1 so the deterministic pipeline is the default; the agent layer sits
# on top and feeds the SAME deterministic verdict (it narrates, never scores).
KNOWLEDGE_GRAPH="$HERE/agent/knowledge_graph.py"
AGENT_LOOP="$HERE/agent/agent_loop.py"
CR_AGENTIC="${CR_AGENTIC:-0}"

ZONE=""
TARBALL=""
GITHUB=""
NAME="scan"
RESULTS_DIR="$HERE/results"
TAG="cr-sandbox"
TRAP_TAG="cr-trap"
MACHINE="e2-small"          # 2 vCPU; trap(2)+detonation(2)=4, under the 8-core cap
GOLDEN_FAMILY="cr-sandbox-golden"
BASE_IMAGE_FAMILY="debian-12"
BASE_IMAGE_PROJECT="debian-cloud"
MAX_RUN="30m"               # server-side dead-man's switch TTL
SUBNET_CIDR="10.200.0.0/24"

log() { echo "[orch] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --zone) ZONE="$2"; shift 2;;
    --tarball) TARBALL="$2"; shift 2;;
    --github) GITHUB="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --machine) MACHINE="$2"; shift 2;;
    *) die "unknown arg: $1";;
  esac
done

[ -n "$ZONE" ] || die "--zone required (e.g. us-central1-a)"
REGION="${ZONE%-*}"
TS="$(date +%s)"
DET_VM="cr-sbx-${NAME}-${TS}"
TRAP_VM="cr-trap-${NAME}-${TS}"
mkdir -p "$RESULTS_DIR"
STAGE="$(mktemp -d)"
VM_LEDGER="$RESULTS_DIR/.vm-ledger-${NAME}-${TS}"   # persistent record of created VM names
: > "$VM_LEDGER"
LOCAL_REPORT="$RESULTS_DIR/${NAME}-behavior.json"
LOCAL_CAPTURE="$RESULTS_DIR/${NAME}-capture.jsonl"
LOCAL_ANALYSIS="$RESULTS_DIR/${NAME}-analysis.json"
LOCAL_VERDICT="$RESULTS_DIR/${NAME}-verdict.json"
LOCAL_FORENSICS="$RESULTS_DIR/${NAME}-forensics.json"

# ---- BULLETPROOF cleanup: delete EVERY VM we created, on ANY exit -----------
record_vm() { echo "$1" >> "$VM_LEDGER"; }   # call BEFORE create when possible

verify_gone() {
  local vm="$1"
  for _ in $(seq 1 6); do
    gcloud compute instances describe "$vm" --zone="$ZONE" >/dev/null 2>&1 || return 0
    sleep 5
  done
  return 1
}

cleanup() {
  log "=== RESET: deleting ALL ephemeral VMs (per-scan reset / abuse protection) ==="
  # Delete every VM recorded in the ledger (covers interrupted creates too).
  if [ -f "$VM_LEDGER" ]; then
    while read -r vm; do
      [ -n "$vm" ] || continue
      log "deleting $vm"
      gcloud compute instances delete "$vm" --zone="$ZONE" --quiet >/dev/null 2>&1 || true
      verify_gone "$vm" && log "  $vm gone." || log "  WARNING: $vm may linger — sweep will retry."
    done < "$VM_LEDGER"
  fi
  # Belt-and-suspenders: sweep ANY straggler with our prefixes in this zone.
  local stragglers
  stragglers="$(gcloud compute instances list \
    --filter="zone:( $ZONE ) AND (name~'^cr-sbx-' OR name~'^cr-trap-' OR name~'^cr-analysis-')" \
    --format="value(name)" 2>/dev/null || true)"
  for vm in $stragglers; do
    log "sweep deleting straggler $vm"
    gcloud compute instances delete "$vm" --zone="$ZONE" --quiet >/dev/null 2>&1 || true
  done
  rm -rf "$STAGE" 2>/dev/null || true
  log "cleanup complete."
}
trap cleanup EXIT INT TERM

# Transient IAP tunnel hiccups (especially on rapid back-to-back scp/ssh) are
# common; retry a few times before giving up so the pipeline is robust.
retry() {
  local n="$1"; shift
  local i=1
  while true; do
    "$@" && return 0
    [ "$i" -ge "$n" ] && return 1
    sleep $(( i * 4 )); i=$(( i + 1 ))
  done
}
ssh_det() { gcloud compute ssh "$DET_VM" --zone="$ZONE" --tunnel-through-iap --command="$1" 2>/dev/null; }
ssh_trap() { gcloud compute ssh "$TRAP_VM" --zone="$ZONE" --tunnel-through-iap --command="$1" 2>/dev/null; }
scp_to() { # scp_to <vm> <local> <remote>
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap "$(winpath "$2")" "$1:$3" >/dev/null 2>&1
}
scp_from() { # scp_from <vm> <remote> <local>
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap "$1:$2" "$3" >/dev/null 2>&1
}

# ---- 1. ensure hermetic network (with sinkhole rules) ----------------------
log "ensuring hermetic network + sinkhole rules in $REGION"
bash "$NET" create "$REGION" || die "network setup failed"

# ---- prepare the target tarball --------------------------------------------
# CLONE_DIR is the OFF-VM clone the agentic brain explores (read-only). It is
# always populated below so the agent has a local tree to graph + read, whether
# the input was --github or --tarball.
CLONE_DIR="$STAGE/repo"
if [ -n "$GITHUB" ]; then
  log "cloning public repo $GITHUB locally (off-VM)"
  git clone --depth 1 "https://github.com/${GITHUB}.git" "$CLONE_DIR" >/dev/null 2>&1 \
    || die "git clone failed for $GITHUB"
  TARBALL="$STAGE/target.tar.gz"
  tar -czf "$TARBALL" -C "$CLONE_DIR" .
elif [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
  log "using target tarball: $TARBALL"
  # Unpack a local read-only copy for the agentic brain (no execution).
  mkdir -p "$CLONE_DIR"
  tar -xzf "$TARBALL" -C "$CLONE_DIR" --strip-components=1 2>/dev/null \
    || tar -xzf "$TARBALL" -C "$CLONE_DIR" 2>/dev/null \
    || log "WARNING: could not unpack tarball for off-VM agentic exploration"
else
  die "provide --tarball <path> or --github <owner/repo>"
fi

# ---- 2. boot the TRAP host -------------------------------------------------
# The trap has an EXTERNAL IP (for the build registry proxy + intended-IP
# resolution) and is NOT cr-sandbox-tagged, so it keeps normal egress. Its
# catch-all ports are reachable ONLY intra-VPC (the trap-ingress firewall rule).
log "booting TRAP host $TRAP_VM (external IP, $TRAP_TAG; sinkhole DNS+sink+proxy+pcap)"
record_vm "$TRAP_VM"
gcloud compute instances create "$TRAP_VM" \
  --zone="$ZONE" --machine-type="$MACHINE" \
  --image-family="$BASE_IMAGE_FAMILY" --image-project="$BASE_IMAGE_PROJECT" \
  --network-interface="subnet=cr-sandbox-subnet" \
  --tags="$TRAP_TAG" \
  --max-run-duration="$MAX_RUN" --instance-termination-action=DELETE >/dev/null \
  || die "trap VM create failed"

log "waiting for trap SSH..."
TRAP_READY=0
for i in $(seq 1 40); do
  ssh_trap "true" >/dev/null 2>&1 && { TRAP_READY=1; break; }
  sleep 10
done
[ "$TRAP_READY" = "1" ] || die "trap VM did not become reachable"

# stage sinkd + trap-host onto the trap, then provision it. Both files in ONE
# scp invocation (one IAP tunnel), with retry for transient IAP hiccups.
log "staging sinkd + trap-host onto the trap and provisioning"
scp_trap_files() {
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap \
    "$(winpath "$SINKD")" "$(winpath "$TRAP_HOST")" "$TRAP_VM:/tmp/" >/dev/null 2>&1
}
retry 4 scp_trap_files || die "scp trap files failed (after retries)"
retry 3 ssh_trap "sudo mkdir -p /opt/cr && sudo mv /tmp/sinkd.py /opt/cr/sinkd.py && sudo mv /tmp/trap-host.sh /opt/cr/trap-host.sh && sudo chmod +x /opt/cr/trap-host.sh" \
  || die "trap staging move failed"
ssh_trap "sudo bash /opt/cr/trap-host.sh provision" >/dev/null 2>&1 || log "WARNING: trap provision returned non-zero (will verify)"

# fetch the trap's PRIVATE IP — everything the detonation VM talks to is THIS.
TRAP_IP="$(ssh_trap "cat /opt/cr/TRAP_IP 2>/dev/null" | tr -d '\r\n ')"
[ -n "$TRAP_IP" ] || TRAP_IP="$(gcloud compute instances describe "$TRAP_VM" --zone="$ZONE" --format='value(networkInterfaces[0].networkIP)' 2>/dev/null | tr -d '\r\n ')"
# The TRAP_IP is read from the trap VM and is then interpolated into SSH command
# strings (proxy URL, CR_TRAP_IP env). Validate it is a STRICT subnet IP before
# any use, so a compromised/poisoned TRAP_IP cannot inject shell metacharacters.
[[ "$TRAP_IP" =~ ^10\.200\.[0-9]{1,3}\.[0-9]{1,3}$ ]] \
  || die "trap private IP is not a valid 10.200.x address (refusing to proceed): '${TRAP_IP}'"
log "trap private IP = $TRAP_IP"
# Re-assert trap containment before we detonate anything.
ssh_trap "sudo bash /opt/cr/trap-host.sh assert" >/dev/null 2>&1 || die "TRAP CONTAINMENT ASSERT FAILED — refusing to detonate"
# Gate the build proxy: if squid is not active, the registry-allowlist enforcement
# is silently absent and the BUILD phase would either fail or (worse) appear to
# pass without allowlist control. Assert it is up before we depend on it.
ssh_trap "systemctl is-active squid" 2>/dev/null | grep -qx "active" \
  || die "BUILD PROXY DOWN: squid is not active on the trap — refusing to build without registry-allowlist enforcement"
log "build proxy healthy: squid active on the trap (registry allowlist enforced)"
BUILD_PROXY="http://${TRAP_IP}:3128"

# ---- 3. boot the DETONATION VM (no external IP, no SA/scopes, deny-egress) --
GOLDEN_IMG="$(gcloud compute images list --filter="family:${GOLDEN_FAMILY}" \
  --format="value(name)" --sort-by=~creationTimestamp --limit=1 2>/dev/null || true)"
record_vm "$DET_VM"
if [ -n "$GOLDEN_IMG" ]; then
  log "booting DETONATION VM $DET_VM from golden $GOLDEN_IMG (no external IP, no SA, deny-egress)"
  gcloud compute instances create "$DET_VM" \
    --zone="$ZONE" --machine-type="$MACHINE" \
    --image="$GOLDEN_IMG" \
    --network-interface="subnet=cr-sandbox-subnet,no-address" \
    --tags="$TAG" --no-service-account --no-scopes \
    --max-run-duration="$MAX_RUN" --instance-termination-action=DELETE >/dev/null \
    || die "detonation VM create failed"
else
  log "no golden image; booting base $BASE_IMAGE_FAMILY (DEGRADED) with inline provision"
  gcloud compute instances create "$DET_VM" \
    --zone="$ZONE" --machine-type="$MACHINE" \
    --image-family="$BASE_IMAGE_FAMILY" --image-project="$BASE_IMAGE_PROJECT" \
    --network-interface="subnet=cr-sandbox-subnet,no-address" \
    --tags="$TAG" --no-service-account --no-scopes \
    --max-run-duration="$MAX_RUN" --instance-termination-action=DELETE \
    --metadata-from-file=startup-script="$(winpath "$PROVISION")" >/dev/null \
    || die "detonation VM create failed"
fi

log "waiting for detonation VM SSH over IAP..."
DET_READY=0
for i in $(seq 1 40); do
  ssh_det "true" >/dev/null 2>&1 && { DET_READY=1; break; }
  sleep 15
done
[ "$DET_READY" = "1" ] || die "detonation VM did not become reachable"

# ---- 4. stage harness + observer + flip + target ---------------------------
# All harness files in ONE scp (one IAP tunnel), target in a second, each retried.
log "staging harness, observer, sinkhole-flip, and target onto detonation VM"
scp_det_harness() {
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap \
    "$(winpath "$OBSERVE")" "$(winpath "$HARNESS")" "$(winpath "$FLIP")" "$DET_VM:/tmp/" >/dev/null 2>&1
}
scp_det_target() {
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap "$(winpath "$TARBALL")" "$DET_VM:/tmp/target.tar.gz" >/dev/null 2>&1
}
retry 4 scp_det_harness || die "scp harness files failed (after retries)"
retry 4 scp_det_target  || die "scp target failed (after retries)"
retry 3 ssh_det "sudo mkdir -p /opt/cr && sudo mv /tmp/observe.py /tmp/run-harness.sh /tmp/sinkhole-flip.sh /opt/cr/ && sudo chmod +x /opt/cr/*.py /opt/cr/*.sh" \
  || die "staging move failed"

# ---- 5. BUILD via the registry-allowlist proxy -----------------------------
log "=== BUILD phase (deps via trap proxy $BUILD_PROXY; registries ONLY) ==="
HARNESS_BASE="sudo BUILD_TIMEOUT=300 RUN_TIMEOUT=60 bash /opt/cr/run-harness.sh"
ssh_det "$HARNESS_BASE prepare /tmp/target.tar.gz" >/dev/null 2>&1 || true
ssh_det "sudo CR_PROXY=$BUILD_PROXY BUILD_TIMEOUT=300 bash /opt/cr/run-harness.sh build" >/dev/null 2>&1 || true

# ---- 6. PROVE containment: a control probe to a real host must NOT reach it -
# FAIL-CLOSED gate: if the detonation VM reaches the real internet (HTTP 200 from
# example.com), containment is BROKEN and we MUST NOT proceed to the RUN phase —
# running unknown code while egress is open is the exact failure this engine
# exists to prevent. A timeout / 000 / rc!=0 means the probe was contained
# (blocked or sinkholed), which is the expected, safe case → proceed.
log "containment control probe (must NOT reach the real internet)..."
PROBE=$(ssh_det "timeout 8 curl -s -o /dev/null -w '%{http_code}' --max-time 6 https://example.com 2>&1; echo \" rc=\$?\"" || true)
log "control probe result: ${PROBE:-<none>}  (non-200 / timeout / rc!=0 == contained)"
# Match strictly on a leading 200 so only a genuine real-internet reach aborts;
# the contained case (000/timeout/empty) still proceeds.
if printf '%s' "$PROBE" | grep -qE '^200'; then
  die "CONTAINMENT VIOLATION: pre-RUN control probe reached the real internet (https://example.com returned HTTP 200). Refusing to detonate — aborting before the RUN phase."
fi
log "containment confirmed: control probe did NOT reach the real internet — proceeding to RUN."

# ---- 6b. AGENTIC explore/detonate (Phase 2 — opt-in via CR_AGENTIC=1) -------
# The brain runs OFF-VM here on the controller: it builds the knowledge graph
# over the local clone (no execution), then explores + detonates chosen files
# through the SAME sinkhole via run-harness.sh run-target as the non-root runner
# (its detonator re-asserts containment before each detonation). It NARRATES and
# emits a ScoringDynamicOutcome map; the deterministic verdict stays authoritative.
# Defaults OFF so the proven deterministic pipeline is unchanged.
LOCAL_AGENTIC="$RESULTS_DIR/${NAME}-agentic-findings.json"
if [ "$CR_AGENTIC" = "1" ]; then
  if [ ! -d "$CLONE_DIR" ]; then
    log "WARNING: no off-VM clone available — skipping agentic pass"
  elif ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
    log "WARNING: Vertex ADC unavailable — skipping agentic pass (deterministic RUN proceeds)"
  else
    log "=== AGENTIC pass (explore off-VM clone; detonate via run-target under sinkhole) ==="
    GRAPH_JSON="$RESULTS_DIR/${NAME}-knowledge-graph.json"
    python3 "$KNOWLEDGE_GRAPH" "$CLONE_DIR" --out "$GRAPH_JSON" 2>/dev/null \
      || log "WARNING: knowledge-graph build returned non-zero"
    COMMIT_SHA="$(git -C "$CLONE_DIR" rev-parse HEAD 2>/dev/null || echo "unknown-${TS}")"
    # AI time budget is a FIXED fraction (<=60%) of the VM --max-run-duration cage
    # (audit C4). MAX_RUN is like "30m"; take its minutes, *60*0.5 seconds.
    CAGE_MIN="${MAX_RUN%m}"; case "$CAGE_MIN" in ''|*[!0-9]*) CAGE_MIN=30;; esac
    CAGE_S=$(( CAGE_MIN * 60 ))             # full VM cage in seconds
    AI_BUDGET_S=$(( CAGE_S / 2 ))           # 50% of cage, under the 60% ceiling
    # The loop's ssh_exec uses these to SSH into the sealed detonation VM.
    # --cage-duration-s makes the loop ENFORCE time_budget_s <= 60% of the cage at
    # construction (audit C4 / MED-3); a misconfigured budget aborts the pass.
    CR_DET_VM="$DET_VM" CR_ZONE="$ZONE" \
      python3 "$AGENT_LOOP" \
        --repo-dir "$CLONE_DIR" --graph "$GRAPH_JSON" \
        --commit-sha "$COMMIT_SHA" --name "$NAME" --trap-ip "$TRAP_IP" \
        --results-dir "$RESULTS_DIR" \
        --time-budget-s "$AI_BUDGET_S" --token-budget 200000 \
        --cage-duration-s "$CAGE_S" \
        --project "$(gcloud config get-value project 2>/dev/null)" \
        --location "${CR_VERTEX_LOCATION:-us-central1}" \
        --out "$LOCAL_AGENTIC" > "$RESULTS_DIR/${NAME}-agentic.log" 2>&1 \
      || log "WARNING: agentic pass returned non-zero (see ${NAME}-agentic.log; deterministic RUN still proceeds)"
    [ -f "$LOCAL_AGENTIC" ] && log "agentic findings: $LOCAL_AGENTIC"
  fi
fi

# ---- 7. RUN under the sinkhole ---------------------------------------------
log "=== RUN phase (SINKHOLE: DNS+DNAT -> trap $TRAP_IP) ==="
ssh_det "sudo CR_TRAP_IP=$TRAP_IP RUN_TIMEOUT=60 bash /opt/cr/run-harness.sh run" >/dev/null 2>&1 || true
ssh_det "$HARNESS_BASE merge /tmp/cr-report.json" >/dev/null 2>&1 || log "harness merge non-zero"

# ---- 8. collect behavior report + trap capture (external monitor) ----------
log "collecting in-VM behavior report"
collect_report() { scp_from "$DET_VM" "/tmp/cr-report.json" "$LOCAL_REPORT"; }
retry 4 collect_report || die "failed to collect behavior report"
log "collecting trap capture (external, tamper-proof network record)"
ssh_trap "sudo cp /var/log/cr-sink/capture.jsonl /tmp/capture.jsonl && sudo chmod a+r /tmp/capture.jsonl" >/dev/null 2>&1 || true
collect_capture() { scp_from "$TRAP_VM" "/tmp/capture.jsonl" "$LOCAL_CAPTURE"; }
retry 4 collect_capture || { log "no trap capture collected"; : > "$LOCAL_CAPTURE"; }
# collect a summary of the pcap existence as external-monitor evidence
ssh_trap "sudo ls -la /var/log/cr-sink/*.pcap* 2>/dev/null | head -5" 2>/dev/null | sed 's/^/[trap-pcap] /' >&2 || true

# record the control probe into the behavior report
python3 - "$LOCAL_REPORT" "$PROBE" <<'PY'
import json,sys
p,probe=sys.argv[1],sys.argv[2]
d=json.load(open(p))
d["egress_control_probe"]=probe.strip()
json.dump(d,open(p,"w"),indent=2)
PY

# ---- 9. DELETE the detonation VM NOW (reset) — trap stays to hold capture --
log "=== RESET: deleting detonation VM $DET_VM now (capture already collected) ==="
gcloud compute instances delete "$DET_VM" --zone="$ZONE" --quiet >/dev/null 2>&1 || true
verify_gone "$DET_VM" && log "detonation VM gone." || log "WARNING: detonation VM may linger (sweep will retry)."
# remove it from the ledger so cleanup doesn't re-attempt (harmless if it does)
grep -v "^$DET_VM$" "$VM_LEDGER" > "$VM_LEDGER.tmp" 2>/dev/null && mv "$VM_LEDGER.tmp" "$VM_LEDGER" || true

# ---- 10. isolated, disposable payload analysis -----------------------------
# Inert captured bytes ONLY, in a separate env (local disposable dir here; the
# `vm` mode boots a distinct disposable VM). Resolves intended IPs (intel only),
# GeoIPs them, and asks Gemini (Vertex/ADC) for an intent summary.
log "=== isolated payload analysis (separate disposable env; inert bytes only) ==="
AI_FLAG=""
gcloud auth application-default print-access-token >/dev/null 2>&1 || AI_FLAG="--no-ai"
[ -n "$AI_FLAG" ] && log "ADC unavailable — analysis will skip the AI summary"
bash "$RUN_ANALYSIS" local "$LOCAL_CAPTURE" "$LOCAL_REPORT" "$LOCAL_ANALYSIS" $AI_FLAG || true

# ---- 11. fold network intent into the report, compute verdict, emit forensics
log "folding captured network intent into the report and computing verdict"
python3 - "$LOCAL_REPORT" "$LOCAL_CAPTURE" "$LOCAL_ANALYSIS" <<'PY'
import json,sys
report_p, cap_p, an_p = sys.argv[1:4]
report=json.load(open(report_p))
intents=[]
try:
    for line in open(cap_p):
        line=line.strip()
        if not line: continue
        c=json.loads(line)
        if c.get("event")=="sinkd_start": continue
        host=c.get("intended_host") or c.get("sni") or c.get("http_host_header")
        if not host and not c.get("dest_port"): continue
        intents.append({"intended_host":host,"sni":c.get("sni"),
            "dest_port":c.get("dest_port"),"http_path":c.get("http_path"),
            "would_be_payload_b64":c.get("payload_b64")})
except FileNotFoundError:
    pass
try:
    analysis=json.load(open(an_p))
except Exception:
    analysis={}
report["network_intent"]={"attempts":intents,"attempt_count":len(intents),
    "intended_destinations":analysis.get("destinations",[]),
    "geolocations":analysis.get("geolocations",[])}
json.dump(report,open(report_p,"w"),indent=2)
PY

log "computing dynamic verdict (never a bare 'Safe')"
python3 "$VERDICT" "$LOCAL_REPORT" | tee "$LOCAL_VERDICT" >/dev/null

log "emitting forensic record"
python3 "$FORENSICS" --behavior "$LOCAL_REPORT" --capture "$LOCAL_CAPTURE" \
  --analysis "$LOCAL_ANALYSIS" --verdict "$LOCAL_VERDICT" \
  --target "$NAME" --out "$LOCAL_FORENSICS" | tail -40

log "results: behavior=$LOCAL_REPORT capture=$LOCAL_CAPTURE analysis=$LOCAL_ANALYSIS verdict=$LOCAL_VERDICT forensics=$LOCAL_FORENSICS"

# ---- 12. trap deleted by the EXIT trap (and detonation already gone) -------
log "scan complete for $NAME. Trap VM will be deleted now (reset)."
