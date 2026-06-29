#!/usr/bin/env bash
# forge-down.sh — tear down a per-run forge (both netns + processes). Run as root.
# Per-scan reset: leaves ZERO orphan forge processes / namespaces (a containment rail).
set -uo pipefail
ID="${1:-default}"
FNS="cr-forge-${ID}"; RNS="cr-run-${ID}"
for pf in "/run/${FNS}-mitm.pid" "/run/${FNS}-dnsmasq.pid"; do
  [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null || true
  rm -f "$pf"
done
pkill -f "netns exec ${FNS} " 2>/dev/null || true
# remove the registry-uplink host plumbing (the per-run NATed veth + iptables)
UPOCT=$(( $(printf '%s' "$ID" | cksum | cut -d' ' -f1) % 200 + 10 ))
UPNET="10.111.${UPOCT}.0/30"
ip link del "fwdh-${ID}" 2>/dev/null || true
iptables -t nat -D POSTROUTING -s "${UPNET}" -o "$(ip route show default | awk '{print $5; exit}')" -j MASQUERADE 2>/dev/null || true
iptables -D FORWARD -s "${UPNET}" -j ACCEPT 2>/dev/null || true
iptables -D FORWARD -d "${UPNET}" -j ACCEPT 2>/dev/null || true
for NS in "$FNS" "$RNS"; do
  ip netns pids "$NS" 2>/dev/null | xargs -r kill 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
done
rm -rf "/tmp/${FNS}-dnsmasq.conf" "/tmp/${FNS}-mitm.log"
left=$(ip netns list 2>/dev/null | grep -cE "^(${FNS}|${RNS})\b")
procs=$(pgrep -fc "netns exec ${FNS}" 2>/dev/null || echo 0)
echo "CR_FORGE_DOWN id=${ID} netns_left=${left} mitm_procs_left=${procs}"
