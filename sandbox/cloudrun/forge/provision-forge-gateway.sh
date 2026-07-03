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
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CAP_DIR=/var/log/cr-forge
MITM_PORT=8080
API_PORT=8090
mkdir -p "$CAP_DIR" /opt/cr/forge

echo "== Stage 1: base packages =="
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 python3-pip python3-venv iptables curl ca-certificates >/dev/null

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

systemctl daemon-reload
systemctl enable --now cr-forge-iptables.service
systemctl enable --now cr-forge-api.service
systemctl enable --now cr-forge-mitm.service
sleep 2

echo "== Verify =="
systemctl is-active cr-forge-iptables.service cr-forge-api.service cr-forge-mitm.service
ss -ltn | grep -E ":${MITM_PORT}|:${API_PORT}" || { echo "CR_FORGE_GATEWAY_FAIL: ports not listening"; exit 1; }
curl -fsS "http://127.0.0.1:${API_PORT}/healthz" || { echo "CR_FORENSICS_API_FAIL"; exit 1; }
echo "CR_FORGE_GATEWAY_UP mitm=${MITM_PORT} api=${API_PORT} ca=/root/.mitmproxy/mitmproxy-ca-cert.pem"
