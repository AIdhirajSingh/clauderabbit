#!/usr/bin/env bash
# forge-up.sh — bring up the deceptive forging egress in a per-run network namespace,
# in front of the detonation's ONLY network path. Run as root on the host.
#
# The netns has NO route to the real internet. Inside it:
#   - a dummy iface `forge0` holds the forge/gateway IP (169.254.0.1).
#   - dnsmasq answers EVERY name with 169.254.0.1, so all destinations resolve to us.
#   - iptables REDIRECT (nat OUTPUT for in-netns processes, nat PREROUTING for the
#     microVM tap) sends every TCP flow to mitmproxy:8080 (transparent --showhost),
#     which forges a success per forge_addon.py and captures the conversation.
# Registry hosts pass through untouched + logged via mitmproxy --ignore-hosts.
# NO real packet leaves except the allowlisted registry flows (real NAT, logged).
set -uo pipefail
NS="${1:-cr-run}"
GW=169.254.0.1
FORGE_PORT=8080
CAP_DIR=/var/log/cr-forge
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
ADDON="$HERE/forge_addon.py"
MITM="${CR_MITM:-/root/.local/bin/mitmdump}"
REGISTRIES='(^|\.)(registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|crates\.io|static\.crates\.io|deb\.debian\.org|archive\.ubuntu\.com|security\.ubuntu\.com)$'
mkdir -p "$CAP_DIR" "/etc/netns/$NS"
CAP="$CAP_DIR/${NS}-capture.jsonl"; : > "$CAP"

# 1) per-run netns + a dummy iface holding the forge gateway IP
ip netns add "$NS" 2>/dev/null || true
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip link add forge0 type dummy 2>/dev/null || true
ip netns exec "$NS" ip addr add "${GW}/24" dev forge0 2>/dev/null || true
ip netns exec "$NS" ip link set forge0 up
# the netns's resolver IS the forge
echo "nameserver ${GW}" > "/etc/netns/$NS/resolv.conf"

# 2) dnsmasq: answer EVERY query with the forge IP
cat > "/tmp/${NS}-dnsmasq.conf" <<EOF
no-resolv
no-hosts
address=/#/${GW}
listen-address=${GW}
bind-interfaces
port=53
EOF
ip netns exec "$NS" dnsmasq --conf-file="/tmp/${NS}-dnsmasq.conf" --pid-file="/run/${NS}-dnsmasq.pid" 2>/dev/null || true

# 3) REDIRECT all guest TCP to mitmproxy (except flows already aimed at the forge port).
for CHAIN in OUTPUT PREROUTING; do
  ip netns exec "$NS" iptables -t nat -A "$CHAIN" -p tcp --dport ${FORGE_PORT} -j RETURN 2>/dev/null || true
  ip netns exec "$NS" iptables -t nat -A "$CHAIN" -p tcp -m multiport --dports 80,443 \
    -j REDIRECT --to-ports ${FORGE_PORT} 2>/dev/null || true
  # catch-all for any other TCP port (non-standard C2 ports)
  ip netns exec "$NS" iptables -t nat -A "$CHAIN" -p tcp -j REDIRECT --to-ports ${FORGE_PORT} 2>/dev/null || true
done

# 4) mitmproxy (transparent) loading the forge addon; registries pass through
ip netns exec "$NS" env CR_FORGE_CAPTURE="$CAP" \
  "$MITM" --mode transparent --showhost \
    --listen-host 0.0.0.0 --listen-port ${FORGE_PORT} \
    --set block_global=false --set termlog_verbosity=warn \
    --set upstream_cert=false --set connection_strategy=lazy \
    --ignore-hosts "$REGISTRIES" \
    -s "$ADDON" >"/tmp/${NS}-mitm.log" 2>&1 &
echo $! > "/run/${NS}-mitm.pid"
# wait for mitmproxy to bind
for i in $(seq 1 40); do ip netns exec "$NS" ss -ltn 2>/dev/null | grep -q ":${FORGE_PORT}" && break; sleep 0.25; done
echo "CR_FORGE_UP ns=${NS} gw=${GW} capture=${CAP} mitm_pid=$(cat /run/${NS}-mitm.pid)"
if grep -qiE 'error|traceback' "/tmp/${NS}-mitm.log"; then echo "CR_FORGE_MITM_WARN"; tail -3 "/tmp/${NS}-mitm.log"; else echo "CR_FORGE_MITM ok"; fi
