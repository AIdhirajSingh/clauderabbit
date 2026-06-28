#!/usr/bin/env bash
# forge-down.sh — tear down a per-run forge netns and all its processes. Run as root.
# Per-scan reset: leaves ZERO orphan forge processes / namespaces (a containment rail).
set -uo pipefail
NS="${1:-cr-run}"
for pf in "/run/${NS}-mitm.pid" "/run/${NS}-dnsmasq.pid"; do
  [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null || true
  rm -f "$pf"
done
# kill any stragglers bound to this netns by name match, then delete the netns
pkill -f "netns exec ${NS} " 2>/dev/null || true
ip netns pids "$NS" 2>/dev/null | xargs -r kill 2>/dev/null || true
ip netns del "$NS" 2>/dev/null || true
rm -rf "/etc/netns/${NS}" "/tmp/${NS}-dnsmasq.conf" "/tmp/${NS}-mitm.log"
echo "CR_FORGE_DOWN ns=${NS} netns_left=$(ip netns list 2>/dev/null | grep -c "^${NS}\b") mitm_procs_left=$(pgrep -fc "netns exec ${NS}" 2>/dev/null || echo 0)"
