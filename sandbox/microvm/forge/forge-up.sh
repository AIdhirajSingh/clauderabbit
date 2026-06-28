#!/usr/bin/env bash
# forge-up.sh — bring up the deceptive forging egress for ONE detonation run. Run as root.
#
# PROVEN topology (a real microVM detonation captured through this): two network
# namespaces joined by a cross-netns veth, because Kata-FC enumerates the container
# netns and accepts ONLY a clean veth eth0 (it makes the tap itself via tcfilter):
#
#   forge netns  cr-forge-<id>:  forgebr(169.254.0.1) + dnsmasq(answer-all) + mitmproxy
#                                (transparent forge) + REDIRECT all TCP -> mitmproxy;
#                                holds crpeer (the veth peer) on the bridge.
#   run   netns  cr-run-<id>:    ONLY eth0 (169.254.0.2, veth, peer=crpeer), default route
#                                via the forge. Kata-FC tcfilter turns eth0 into the
#                                microVM's tap. The detonation runs here:
#                                  ctr run --with-ns "network:/var/run/netns/cr-run-<id>" ...
#
# The microVM has NO route to the real internet; every name resolves to the forge, every
# TCP flow is forged + captured. Registry hosts pass through (real NAT, logged). The guest
# resolv.conf is set by the detonation harness (Kata does not propagate it through FC).
set -uo pipefail
ID="${1:-default}"
FNS="cr-forge-${ID}"; RNS="cr-run-${ID}"
GW=169.254.0.1; GUEST="${GUEST_IP:-169.254.0.2}"; PORT=8080
CAP_DIR=/var/log/cr-forge
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
ADDON="$HERE/forge_addon.py"
MITM="${CR_MITM:-/root/.local/bin/mitmdump}"
REGISTRIES='(^|\.)(registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|crates\.io|static\.crates\.io|deb\.debian\.org|archive\.ubuntu\.com|security\.ubuntu\.com)$'
mkdir -p "$CAP_DIR"
CAP="$CAP_DIR/${RNS}-capture.jsonl"; : > "$CAP"

# 1) forge netns + bridge
ip netns add "$FNS" 2>/dev/null || true
ip netns exec "$FNS" ip link set lo up
ip netns exec "$FNS" ip link add forgebr type bridge 2>/dev/null || true
ip netns exec "$FNS" ip addr add "${GW}/24" dev forgebr 2>/dev/null || true
ip netns exec "$FNS" ip link set forgebr up

# 2) run netns with ONLY eth0 (veth), peer crpeer in the forge netns on the bridge
ip netns add "$RNS" 2>/dev/null || true
ip netns exec "$RNS" ip link set lo up
ip link add eth0 netns "$RNS" type veth peer name crpeer netns "$FNS" 2>/dev/null || true
ip netns exec "$FNS" ip link set crpeer master forgebr
ip netns exec "$FNS" ip link set crpeer up
ip netns exec "$RNS" ip addr add "${GUEST}/24" dev eth0 2>/dev/null || true
ip netns exec "$RNS" ip link set eth0 up
ip netns exec "$RNS" ip route add default via "${GW}" 2>/dev/null || true

# 3) dnsmasq: answer EVERY query with the forge IP
cat > "/tmp/${FNS}-dnsmasq.conf" <<EOF
no-resolv
no-hosts
address=/#/${GW}
listen-address=${GW}
bind-interfaces
port=53
EOF
ip netns exec "$FNS" dnsmasq --conf-file="/tmp/${FNS}-dnsmasq.conf" --pid-file="/run/${FNS}-dnsmasq.pid" 2>/dev/null || true

# 4) REDIRECT all guest TCP arriving on the bridge -> mitmproxy (except the forge port)
ip netns exec "$FNS" iptables -t nat -A PREROUTING -p tcp --dport ${PORT} -j RETURN
ip netns exec "$FNS" iptables -t nat -A PREROUTING -p tcp -j REDIRECT --to-ports ${PORT}

# 5) mitmproxy (transparent) loading the forge addon; registries pass through
ip netns exec "$FNS" env CR_FORGE_CAPTURE="$CAP" \
  "$MITM" --mode transparent --showhost \
    --listen-host 0.0.0.0 --listen-port ${PORT} \
    --set block_global=false --set termlog_verbosity=warn \
    --set upstream_cert=false --set connection_strategy=lazy \
    --ignore-hosts "$REGISTRIES" \
    -s "$ADDON" >"/tmp/${FNS}-mitm.log" 2>&1 &
echo $! > "/run/${FNS}-mitm.pid"
for i in $(seq 1 40); do ip netns exec "$FNS" ss -ltn 2>/dev/null | grep -q ":${PORT}" && break; sleep 0.25; done
echo "CR_FORGE_UP id=${ID} run_netns=/var/run/netns/${RNS} forge=${GW} capture=${CAP} mitm_pid=$(cat /run/${FNS}-mitm.pid)"
if grep -qiE 'error|traceback' "/tmp/${FNS}-mitm.log"; then echo "CR_FORGE_MITM_WARN"; tail -3 "/tmp/${FNS}-mitm.log"; else echo "CR_FORGE_MITM ok"; fi
