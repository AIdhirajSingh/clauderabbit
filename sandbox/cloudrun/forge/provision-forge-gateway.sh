#!/usr/bin/env bash
# provision-forge-gateway.sh — stand up cr-forge-gateway, the always-on NVA that
# replaces the per-run netns forge for the Cloud Run detonation architecture.
#
# WHY THIS VM EXISTS (see docs/INFRASTRUCTURE.md and the Unit 4 migration): Cloud Run
# Gen2 containers get no CAP_NET_ADMIN — confirmed against current GCP docs, no netns/
# veth/iptables possible inside the container, on any generation. So instead of a
# per-run forge inside the guest's own network path, EVERY Cloud Run detonation
# execution's Direct VPC Egress traffic is forced (via the cr-detonation-force-nva
# route, tag cr-sandbox, in cr-sandbox-vpc) to arrive at THIS VM regardless of
# destination. This script makes the VM actually behave like the old forge netns did:
# mitmproxy in transparent mode + an iptables PREROUTING REDIRECT delivers every
# arriving flow to forge_addon.py, which decides real-registry/control-plane
# passthrough vs deceptive forgery, exactly as it did on the single host — the
# Forge class itself is UNCHANGED (see forge_addon.py's own header for why).
#
# Idempotent: safe to re-run after a reboot or a code update (systemd units are
# (re)written and restarted, not appended-to).
#
# Run as root on cr-forge-gateway (us-central1-a, internal IP 10.200.0.10, tag
# cr-trap, --can-ip-forward — see the gcloud commands in docs/INFRASTRUCTURE.md §8c).
#
# CONTROL-PLANE AUTH (security review, criticals #2/#3): the /register and /forensics
# endpoints must be authenticated so the UNTRUSTED detonated repo (same subnet IP as the
# harness) cannot re-open its own egress passthrough or blank its own forensic evidence.
# Set CR_FORGE_CONTROL_KEY in THIS script's environment to the SAME secret the cr-detonation
# Cloud Run Job receives (a Secret-Manager-backed env var — see docs/INFRASTRUCTURE.md).
# It is baked into the forensics API's systemd unit below. Until it is set on BOTH sides,
# forensics_api.py warns and allows (rollout-safe) — the hole is only truly closed once the
# key is present on the gateway AND the harness.
set -euo pipefail

# The shared forge control key (empty until provisioning sets it; see the note above).
: "${CR_FORGE_CONTROL_KEY:=}"

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CAP_DIR=/var/log/cr-forge
MITM_PORT=8080
API_PORT=8090
mkdir -p "$CAP_DIR" /opt/cr/forge

echo "== Stage 1: base packages =="
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 python3-pip python3-venv iptables curl ca-certificates dnsmasq >/dev/null

echo "== Stage 1b: DNS — answer-all-except-allowlist (RESTORES the old per-run design's
     containment property that route-forcing alone does NOT give you: a genuinely
     non-existent/sinkholed C2 domain fails DNS resolution INSIDE the container before
     any connection is ever attempted, so the malware never even tries to reach the
     network — nothing for the forced route to intercept, and the sample goes silently
     dormant. Confirmed on a real deployed run: a beacon to a non-resolving example
     domain never appeared in the capture at all. Every other domain (real registries,
     control-plane, source hosts, and any REAL but malicious C2) still resolves via
     real DNS and is contained by the forced route + verified-IP passthrough exactly as
     before — this ONLY changes the outcome for domains that don't exist in real DNS,
     making them resolve to THIS gateway instead of failing closed on the DORMANT side) =="
systemctl disable --now systemd-resolved 2>/dev/null || true
rm -f /etc/resolv.conf
echo "nameserver 127.0.0.1" > /etc/resolv.conf
REGDNS="8.8.8.8"
{
  printf 'no-resolv\nno-hosts\nfilter-AAAA\ncache-size=4000\ndns-forward-max=300\naddress=/#/10.200.0.10\n'
  # MUST mirror forge_addon.py's REGISTRY_RE + CONTROL_PLANE_RE + SOURCE_HOST_RE +
  # OWN_VERTEX_RE suffixes exactly — a domain the addon treats as verified-
  # passthrough-eligible that dnsmasq does NOT forward would resolve to this
  # gateway's own IP for BOTH the container's real connection attempt AND the
  # addon's own verification resolve — a degenerate "match" against a private,
  # non-public IP that the addon's _is_public_ip guard then correctly refuses,
  # so the passthrough can never succeed no matter how well the addon-side logic
  # is written. CONFIRMED missing for aiplatform.googleapis.com on a real deployed
  # run: the harness's own Vertex fallback calls got DNS-forged to this gateway's
  # own IP, so even the project-scoped verified-IP check in forge_addon.py could
  # never pass (there was no real IP to verify against) — same failure class the
  # old per-run dnsmasq's comments already warned about for registries.
  for d in npmjs.org yarnpkg.com pypi.org pythonhosted.org crates.io \
           debian.org ubuntu.com nodejs.org supabase.co github.com githubusercontent.com \
           aiplatform.googleapis.com; do
    printf 'server=/%s/%s\n' "$d" "$REGDNS"
  done
  # Listen on BOTH loopback (this VM's own resolver, which /etc/resolv.conf above
  # points at, used by forge_addon.py's own verification resolves) AND the real
  # internal IP (so Cloud Run containers, whose resolv.conf points at THIS
  # gateway, can query it directly across the subnet).
  printf 'listen-address=127.0.0.1,10.200.0.10\nbind-interfaces\nport=53\n'
} > /etc/dnsmasq.conf
systemctl enable --now dnsmasq
sleep 1
systemctl is-active dnsmasq || { echo "CR_FORGE_DNSMASQ_FAIL"; exit 1; }

echo "== Stage 2: mitmproxy (isolated venv — Ubuntu 24.04 blocks system-wide pip) =="
if [ ! -x /opt/cr/forge/venv/bin/mitmdump ]; then
  python3 -m venv /opt/cr/forge/venv
  /opt/cr/forge/venv/bin/pip install -q --upgrade pip
  /opt/cr/forge/venv/bin/pip install -q mitmproxy
fi
MITM=/opt/cr/forge/venv/bin/mitmdump
PY=/opt/cr/forge/venv/bin/python3

echo "== Stage 3: mitmproxy CA (generate non-interactively on first run) =="
if [ ! -f /root/.mitmproxy/mitmproxy-ca-cert.pem ]; then
  timeout 8 "$MITM" --no-server >/dev/null 2>&1 || true
fi
[ -f /root/.mitmproxy/mitmproxy-ca-cert.pem ] && echo "CA present" || { echo "CA MISSING — abort"; exit 1; }

echo "== Stage 4: deploy the addon + forensics API =="
install -m 0644 "$HERE/forge_addon.py" /opt/cr/forge/forge_addon.py
install -m 0644 "$HERE/forensics_api.py" /opt/cr/forge/forensics_api.py

echo "== Stage 5: iptables — REDIRECT everything to mitmproxy, EXCEPT the API port =="
# Idempotent: flush our own chain rules before re-adding (safe re-run after an update).
iptables -t nat -F PREROUTING 2>/dev/null || true
iptables -t nat -A PREROUTING -p tcp --dport "${API_PORT}" -j RETURN
iptables -t nat -A PREROUTING -p tcp --dport "${MITM_PORT}" -j RETURN
iptables -t nat -A PREROUTING -p tcp -j REDIRECT --to-ports "${MITM_PORT}"
# Nothing should transit FORWARD: guest TCP is REDIRECTed to the LOCAL mitmproxy
# (-> INPUT), registry/control-plane passthrough originates HERE via mitmproxy's own
# outbound connection (-> OUTPUT). A packet aimed past this gateway is DROPped, same
# discipline as the old per-run forge netns's FORWARD DROP.
iptables -P FORWARD DROP 2>/dev/null || true
iptables -C FORWARD -j DROP 2>/dev/null || iptables -A FORWARD -j DROP
# Persist across reboot (netfilter-persistent not installed by default on this image;
# a systemd unit reapplies this script's rules at boot instead — see Stage 7).
echo "iptables rules applied"

echo "== Stage 6: systemd units =="
cat > /etc/systemd/system/cr-forge-mitm.service <<EOF
[Unit]
Description=Claude Rabbit deceptive-egress forge (mitmproxy)
After=network-online.target
Wants=network-online.target

[Service]
Environment=CR_FORGE_CAPTURE=${CAP_DIR}/capture.jsonl
ExecStart=${MITM} --mode transparent --showhost \\
  --listen-host 0.0.0.0 --listen-port ${MITM_PORT} \\
  --set block_global=false --set termlog_verbosity=warn \\
  --set upstream_cert=false --set connection_strategy=lazy \\
  -s /opt/cr/forge/forge_addon.py
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/cr-forge-api.service <<EOF
[Unit]
Description=Claude Rabbit forge gateway forensics/registration API
After=network-online.target
Wants=network-online.target

[Service]
Environment=CR_FORGE_CAPTURE=${CAP_DIR}/capture.jsonl
Environment=CR_FORENSICS_PORT=${API_PORT}
Environment=CR_FORGE_CONTROL_KEY=${CR_FORGE_CONTROL_KEY:-}
ExecStart=${PY} /opt/cr/forge/forensics_api.py
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF

echo "== Stage 7: reapply iptables at boot (this VM's disk is not reimaged between
     scans the way a per-run netns was torn down — the RULES are what's reproducible
     from committed code, the FORENSICS DATA is what's time-bounded, see
     forensics_api.py's cleanup loop) =="
cat > /etc/systemd/system/cr-forge-iptables.service <<EOF
[Unit]
Description=Reapply Claude Rabbit forge iptables rules
Before=cr-forge-mitm.service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'iptables -t nat -F PREROUTING 2>/dev/null || true; iptables -t nat -A PREROUTING -p tcp --dport ${API_PORT} -j RETURN; iptables -t nat -A PREROUTING -p tcp --dport ${MITM_PORT} -j RETURN; iptables -t nat -A PREROUTING -p tcp -j REDIRECT --to-ports ${MITM_PORT}; iptables -P FORWARD DROP 2>/dev/null || true; iptables -C FORWARD -j DROP 2>/dev/null || iptables -A FORWARD -j DROP'
RemainAfterExit=true

[Install]
WantedBy=multi-user.target
EOF

# SECURITY REVIEW FINDING (lower severity, fixed): unlike the old per-run netns
# (torn down + rebuilt every scan), this gateway is a long-lived VM — the boot-
# time reapply above gives no protection against a manual debugging session
# (e.g. an operator running `iptables -F` to troubleshoot) silently leaving
# containment down until the next reboot, with no automated detection. Re-run
# the SAME reapply on a short timer continuously, not just at boot, so any such
# drift self-heals within minutes rather than persisting indefinitely.
cat > /etc/systemd/system/cr-forge-iptables.timer <<'EOF'
[Unit]
Description=Periodically reassert Claude Rabbit forge iptables rules

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now cr-forge-iptables.service
systemctl enable --now cr-forge-iptables.timer
systemctl enable --now cr-forge-api.service
systemctl enable --now cr-forge-mitm.service
sleep 2

echo "== Verify =="
systemctl is-active cr-forge-iptables.service cr-forge-iptables.timer cr-forge-api.service cr-forge-mitm.service
ss -ltn | grep -E ":${MITM_PORT}|:${API_PORT}" || { echo "CR_FORGE_GATEWAY_FAIL: ports not listening"; exit 1; }
curl -fsS "http://127.0.0.1:${API_PORT}/healthz" || { echo "CR_FORENSICS_API_FAIL"; exit 1; }
echo "CR_FORGE_GATEWAY_UP mitm=${MITM_PORT} api=${API_PORT} ca=/root/.mitmproxy/mitmproxy-ca-cert.pem"
