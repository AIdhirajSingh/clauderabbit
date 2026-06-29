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
mkdir -p "$CAP_DIR"
CAP="$CAP_DIR/${RNS}-capture.jsonl"; : > "$CAP"

# 1) forge netns + bridge
ip netns add "$FNS" 2>/dev/null || true
# Resolver for processes INSIDE the forge netns (mitmproxy/the addon). `ip netns exec`
# bind-mounts /etc/netns/<ns>/resolv.conf over /etc/resolv.conf for every exec into the ns.
# The addon validates registry raw-passthroughs by resolving the SNI and checking the dest
# IP is a real registry IP (containment). It MUST resolve via the SAME dnsmasq the guest uses
# (->GW), or a CDN registry that hands different members to different resolvers would make a
# legit registry IP fail the check and break the build. dnsmasq runs no-resolv, so this file
# does not affect dnsmasq itself; only the addon's getaddrinfo. Created before any exec.
mkdir -p "/etc/netns/${FNS}"
printf 'nameserver %s\noptions timeout:2 attempts:2\n' "${GW}" > "/etc/netns/${FNS}/resolv.conf"
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

# 2b) registry fast-path uplink: a NATed veth so the forge (mitmproxy --ignore-hosts
#     passthrough) can reach the REAL registries for a genuine build. The GUEST cannot
#     use this — every guest flow is REDIRECTed to mitmproxy, which forges everything
#     except the allowlisted registries; only mitmproxy's passthrough egresses here.
# Linux interface names are capped at 15 chars (IFNAMSIZ). The uplink veth therefore
# CANNOT be named from the (long) scan ID — `fwd-amrdab-clawdcursor-z6mt9ua4` is 30+
# chars, so `ip link add` silently fails and the forge gets NO uplink: registry DNS can't
# resolve, npm dies with EAI_AGAIN, and the repo "did not build". Derive a SHORT, stable
# hash of the ID for both the veth names AND the /30 uplink subnet (forge-down recomputes
# the same hash). Surface a creation failure instead of swallowing it.
IFID=$(( $(printf '%s' "$ID" | cksum | cut -d' ' -f1) % 100000000 ))
FWD="fwd-${IFID}"; FWDH="fwdh-${IFID}"
# Uplink /30 inside 10.111.0.0/16 (a range known-clear of the GCP VPC subnet). Spread across
# ~16k distinct /30s (NOT 200 buckets) so two concurrent detonations can't land on the same
# subnet — a collision would cross-wire their MASQUERADE/routing and break containment by
# letting one run's egress ride another run's NAT (review HIGH #3). forge-down recomputes this.
UPB=$(( IFID % 16000 ))
UPO3=$(( UPB / 64 )); UPO4=$(( (UPB % 64) * 4 ))
UPNET="10.111.${UPO3}.${UPO4}/30"; UPGW="10.111.${UPO3}.$(( UPO4 + 1 ))"; UPF="10.111.${UPO3}.$(( UPO4 + 2 ))"
ip link add "$FWD" netns "$FNS" type veth peer name "$FWDH" 2>"/tmp/${FNS}-uplink.err" \
  || { echo "CR_FORGE_UPLINK_FAIL"; cat "/tmp/${FNS}-uplink.err" >&2; }
ip netns exec "$FNS" ip addr add "${UPF}/30" dev "$FWD" 2>/dev/null || true
ip netns exec "$FNS" ip link set "$FWD" up
ip netns exec "$FNS" ip route add default via "${UPGW}" 2>/dev/null || true
ip addr add "${UPGW}/30" dev "$FWDH" 2>/dev/null || true
ip link set "$FWDH" up
sysctl -qw net.ipv4.ip_forward=1 >/dev/null 2>&1
MAINIF="$(ip route show default | awk '{print $5; exit}')"
# Persist the uplink interface so teardown deletes the EXACT MASQUERADE rule we add here. If
# the default route's interface changes before forge-down, re-deriving it there would orphan
# this NAT rule (a slow leak of stale MASQUERADE rules across runs) — review MEDIUM #8.
printf '%s' "$MAINIF" > "/run/${FNS}-mainif" 2>/dev/null || true
iptables -t nat -C POSTROUTING -s "${UPNET}" -o "${MAINIF}" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "${UPNET}" -o "${MAINIF}" -j MASQUERADE
iptables -C FORWARD -s "${UPNET}" -j ACCEPT 2>/dev/null || iptables -A FORWARD -s "${UPNET}" -j ACCEPT
iptables -C FORWARD -d "${UPNET}" -j ACCEPT 2>/dev/null || iptables -A FORWARD -d "${UPNET}" -j ACCEPT

# 3) dnsmasq: answer EVERY query with the forge IP
# Catch-all -> the forge IP (so every C2 name lands on us, forged). EXCEPT the package
# registries: resolve those (and ALL their subdomains, dnsmasq server= is suffix-matching)
# to their REAL IPs so the addon's verified passthrough reaches the real registry.
#
# This list MUST stay in sync with REGISTRY_RE in forge_addon.py (review H2): a domain the
# addon treats as a registry but dnsmasq does NOT forward would resolve to the catch-all
# forge IP for both guest and addon — a degenerate "match" that relays to a dead local
# port and breaks the build (e.g. node-gyp fetching nodejs.org). The suffixes here are
# exactly REGISTRY_RE's: npmjs.org, yarnpkg.com, pypi.org, pythonhosted.org, crates.io,
# debian.org, ubuntu.com, nodejs.org (suffix-matching covers registry.npmjs.org,
# files.pythonhosted.org, deb.debian.org, downloads.nodejs.org, ... automatically).
#
# Registry DNS goes to 8.8.8.8 (reachable from the forge netns via the NATed uplink). The
# GCP metadata resolver 169.254.169.254 is link-local and NOT routable from inside the forge
# netns (no route + not MASQUERADEd), so using it as primary only added a per-query timeout
# before the 8.8.8.8 fallback — an EAI_AGAIN source under npm load. `filter-AAAA` strips
# IPv6 (the microVM egress is IPv4-only — an AAAA is a dead route + wasted query). cache-size
# absorbs the repeated lookups a dependency install makes; the addon shares this cache (it
# resolves via this same dnsmasq), so its containment check sees the guest's exact IPs.
REGDNS="${CR_REG_DNS:-8.8.8.8}"
{
  printf 'no-resolv\nno-hosts\nfilter-AAAA\ncache-size=4000\ndns-forward-max=300\naddress=/#/%s\n' "${GW}"
  for d in npmjs.org yarnpkg.com pypi.org pythonhosted.org crates.io \
           debian.org ubuntu.com nodejs.org; do
    printf 'server=/%s/%s\n' "$d" "$REGDNS"
  done
  printf 'listen-address=%s\nbind-interfaces\nport=53\n' "${GW}"
} > "/tmp/${FNS}-dnsmasq.conf"
ip netns exec "$FNS" dnsmasq --conf-file="/tmp/${FNS}-dnsmasq.conf" --pid-file="/run/${FNS}-dnsmasq.pid" 2>"/tmp/${FNS}-dnsmasq.err" || true
# dnsmasq readiness (review HIGH #4): a SILENT dnsmasq failure (port busy, bad config) leaves
# the guest with NO resolver — every registry lookup fails and the repo "did not build". That
# is precisely the failure we just spent a debugging cycle on, so confirm it is actually bound
# on :53 before proceeding and surface a failure loudly instead of swallowing it.
DNS_OK=0
for i in $(seq 1 40); do
  ip netns exec "$FNS" ss -lun 2>/dev/null | grep -q ":53" && { DNS_OK=1; break; }
  sleep 0.1
done
if [ "$DNS_OK" != 1 ]; then echo "CR_FORGE_DNSMASQ_FAIL"; cat "/tmp/${FNS}-dnsmasq.err" >&2 2>/dev/null || true; fi

# 4) REDIRECT all guest TCP arriving on the bridge -> mitmproxy (except the forge port)
ip netns exec "$FNS" iptables -t nat -A PREROUTING -p tcp --dport ${PORT} -j RETURN
ip netns exec "$FNS" iptables -t nat -A PREROUTING -p tcp -j REDIRECT --to-ports ${PORT}

# 4b) CONTAINMENT (review CRITICAL #2): DROP any non-TCP guest egress that would be ROUTED
# toward the real internet — UDP straight to 8.8.8.8:53, an ICMP ping, a raw socket — i.e.
# anything that bypasses the forge. Such a packet is the one thing that could actually leave.
# Reasoning on what legitimately transits the forge netns FORWARD chain: nothing.
#   - guest TCP is REDIRECTed (nat PREROUTING) to the LOCAL mitmproxy -> INPUT, never FORWARD.
#   - guest DNS goes to the forge IP (dnsmasq) -> INPUT, never FORWARD.
#   - mitmproxy's own registry passthrough originates in THIS netns -> OUTPUT, never FORWARD.
# So the ONLY thing that can hit FORWARD here is a guest packet aimed past the forge, and the
# correct answer is DROP. A fresh netns has ip_forward=0 already; this makes the containment
# guarantee explicit and survives any future change that turns forwarding on. (The host netns
# FORWARD chain — where the registry-uplink MASQUERADE lives — is separate and untouched.)
ip netns exec "$FNS" iptables -P FORWARD DROP
ip netns exec "$FNS" iptables -A FORWARD -j DROP

# 5) mitmproxy (transparent) loading the forge addon; registries pass through
ip netns exec "$FNS" env CR_FORGE_CAPTURE="$CAP" \
  "$MITM" --mode transparent --showhost \
    --listen-host 0.0.0.0 --listen-port ${PORT} \
    --set block_global=false --set termlog_verbosity=warn \
    --set upstream_cert=false --set connection_strategy=lazy \
    -s "$ADDON" >"/tmp/${FNS}-mitm.log" 2>&1 &
echo $! > "/run/${FNS}-mitm.pid"
for i in $(seq 1 40); do ip netns exec "$FNS" ss -ltn 2>/dev/null | grep -q ":${PORT}" && break; sleep 0.25; done
echo "CR_FORGE_UP id=${ID} run_netns=/var/run/netns/${RNS} forge=${GW} capture=${CAP} mitm_pid=$(cat /run/${FNS}-mitm.pid)"
if grep -qiE 'error|traceback' "/tmp/${FNS}-mitm.log"; then echo "CR_FORGE_MITM_WARN"; tail -3 "/tmp/${FNS}-mitm.log"; else echo "CR_FORGE_MITM ok"; fi
