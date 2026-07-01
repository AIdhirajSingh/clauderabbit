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
# remove the registry-uplink host plumbing (the per-run NATed veth + iptables). The veth
# name + subnet are derived from a SHORT, stable hash of the ID (the 15-char IFNAMSIZ cap
# means they can't come from the long scan ID) — must match forge-up.sh exactly.
IFID=$(( $(printf '%s' "$ID" | cksum | cut -d' ' -f1) % 100000000 ))
UPB=$(( IFID % 16000 ))
UPO3=$(( UPB / 64 )); UPO4=$(( (UPB % 64) * 4 ))
UPNET="10.111.${UPO3}.${UPO4}/30"
# Use the interface forge-up recorded so we delete the EXACT MASQUERADE rule it created, even
# if the default route changed since (review MEDIUM #8). Fall back to re-deriving for old runs.
MAINIF="$(cat "/run/${FNS}-mainif" 2>/dev/null || true)"
[ -n "$MAINIF" ] || MAINIF="$(ip route show default | awk '{print $5; exit}')"
ip link del "fwdh-${IFID}" 2>/dev/null || true
iptables -t nat -D POSTROUTING -s "${UPNET}" -o "${MAINIF}" -j MASQUERADE 2>/dev/null || true
iptables -D FORWARD -s "${UPNET}" -j ACCEPT 2>/dev/null || true
iptables -D FORWARD -d "${UPNET}" -j ACCEPT 2>/dev/null || true
rm -f "/run/${FNS}-mainif" "/tmp/${FNS}-dnsmasq.err" "/tmp/${FNS}-uplink.err"
rm -rf "/etc/netns/${FNS}"
for NS in "$FNS" "$RNS"; do
  ip netns pids "$NS" 2>/dev/null | xargs -r kill 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
done
rm -rf "/tmp/${FNS}-dnsmasq.conf" "/tmp/${FNS}-mitm.log"
left=$(ip netns list 2>/dev/null | grep -cE "^(${FNS}|${RNS})\b")
procs=$(pgrep -fc "netns exec ${FNS}" 2>/dev/null || echo 0)
echo "CR_FORGE_DOWN id=${ID} netns_left=${left} mitm_procs_left=${procs}"
