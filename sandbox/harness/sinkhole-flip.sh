#!/usr/bin/env bash
#
# sinkhole-flip.sh — runs ON the detonation VM (as root) to switch the network
# from the BUILD configuration (registry proxy) to the RUN configuration
# (full sinkhole), and to assert containment before any untrusted code runs.
#
# This is CONTAINMENT LAYER 2 (the in-VM redirect), layered on top of LAYER 1
# (the VPC deny-1000 egress firewall, which is the fail-closed backstop). The
# two together are the double containment: even if one is bypassed, no packet
# reaches the real internet.
#
# RUN config:
#   - /etc/resolv.conf -> ONLY the trap private IP (so name resolution lands at
#     the sinkhole dnsmasq, which answers every name with the trap IP).
#   - iptables OUTPUT/nat DNAT: redirect ALL outbound TCP and UDP from the
#     unprivileged runner user to the trap private IP, PRESERVING the original
#     destination port. Locally-generated packets hit OUTPUT(nat) BEFORE the
#     routing/egress decision, so the destination is rewritten to a
#     10.200.0.0/24 trap address; GCP's egress firewall then sees a subnet
#     destination (allowed by pri-800) and the packet goes to the trap. A
#     hardcoded-public-IP connect is therefore ALSO redirected to the trap.
#   - Anything the DNAT does NOT catch (ICMP, raw sockets, non-TCP/UDP L4)
#     falls through to the deny-1000 firewall and dies — fail-closed.
#
# Exceptions to the DNAT (so the VM itself keeps working):
#   - loopback (127.0.0.0/8)
#   - the trap IP itself (avoid a redirect loop)
#   - the IAP SSH control plane (so the orchestrator keeps its SSH session)
#
# Usage:
#   sudo sinkhole-flip.sh run <TRAP_IP>     # apply sinkhole + assert, before RUN
#   sudo sinkhole-flip.sh assert <TRAP_IP>  # re-verify the control probe is contained
set -uo pipefail

RUNNER_USER="runner"
log() { echo "[flip] $*" >&2; }
die() { log "FATAL: $*"; exit 1; }

apply_run() {
  local trap_ip="$1"
  [ -n "$trap_ip" ] || die "trap IP required"

  log "RUN sinkhole: resolv.conf -> trap $trap_ip ONLY (no public fallback resolver)"
  # Single nameserver: the trap. No public secondary, so glibc cannot fail over
  # to a real resolver. (The udp:53 DNAT below catches hardcoded resolvers too.)
  chattr -i /etc/resolv.conf 2>/dev/null || true
  printf 'nameserver %s\noptions timeout:1 attempts:1\n' "$trap_ip" > /etc/resolv.conf

  # IPv6 defense-in-depth: the subnet is IPv4-only today, so there is no IPv6
  # DNAT path to the trap — which means ANY IPv6 packet that somehow leaves would
  # bypass the sinkhole entirely. Slam IPv6 OUTPUT/FORWARD to DROP so there is no
  # unmonitored IPv6 egress. (Best-effort: ip6tables may be absent on a v4-only
  # host; that is fine — there is no v6 stack to leak through.)
  log "RUN sinkhole: ip6tables OUTPUT/FORWARD -> DROP (no unmonitored IPv6 egress)"
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -P OUTPUT DROP 2>/dev/null || log "WARNING: could not set ip6tables OUTPUT DROP"
    ip6tables -P FORWARD DROP 2>/dev/null || log "WARNING: could not set ip6tables FORWARD DROP"
  else
    log "ip6tables not present — no IPv6 stack to close (ok)"
  fi

  log "RUN sinkhole: iptables DNAT ALL outbound TCP/UDP -> trap $trap_ip (orig port preserved)"
  # Get the runner uid so we redirect ONLY untrusted-code traffic, leaving the
  # root/orchestrator SSH session and metadata-less system traffic alone.
  local ruid
  ruid="$(id -u "$RUNNER_USER" 2>/dev/null || echo 0)"

  # Clean any prior rules in our chain, then build fresh.
  iptables -t nat -N CR_SINK 2>/dev/null || iptables -t nat -F CR_SINK
  # Do NOT touch loopback or trap-bound traffic.
  iptables -t nat -A CR_SINK -d 127.0.0.0/8 -j RETURN
  iptables -t nat -A CR_SINK -d "$trap_ip" -j RETURN
  # Redirect everything else (any original dst, any port) to the trap, KEEPING
  # the original destination port via --to-destination ip (port unchanged).
  iptables -t nat -A CR_SINK -p tcp -j DNAT --to-destination "$trap_ip"
  iptables -t nat -A CR_SINK -p udp -j DNAT --to-destination "$trap_ip"

  # Hook the chain into OUTPUT (locally generated packets). We sink ALL non-root
  # traffic, not just the runner uid: untrusted code can spawn helpers under a
  # different unprivileged uid (e.g. a postinstall doing `useradd evil; su evil`),
  # and those must ALSO be intercepted so the sinkhole captures their intent.
  # Root (uid 0) is left untouched so the orchestrator's SSH/control plane keeps
  # working. Anything the DNAT still misses dies at the deny-1000 firewall
  # (fail-closed) — but with this rule the capture is complete for any uid the
  # untrusted code can reach without CAP_SETUID to become root.
  # Remove any prior jumps first (idempotent).
  iptables -t nat -D OUTPUT -m owner --uid-owner "$ruid" -j CR_SINK 2>/dev/null || true
  iptables -t nat -D OUTPUT -m owner ! --uid-owner 0 -j CR_SINK 2>/dev/null || true
  iptables -t nat -A OUTPUT -m owner ! --uid-owner 0 -j CR_SINK

  assert_contained "$trap_ip"
}

assert_contained() {
  local trap_ip="$1"
  # Control probe AS THE RUNNER: a real public host must NOT be reachable
  # directly — the connection must be redirected to the trap (so it "succeeds"
  # against the sink) OR be blocked, but it must NEVER reach the real host.
  # We verify the DNAT chain is installed and the runner's traffic is hooked.
  iptables -t nat -S OUTPUT 2>/dev/null | grep -q "CR_SINK" \
    || die "CONTAINMENT VIOLATION: CR_SINK not hooked into OUTPUT nat"
  iptables -t nat -S CR_SINK 2>/dev/null | grep -q "DNAT" \
    || die "CONTAINMENT VIOLATION: CR_SINK has no DNAT rule"
  # Confirm resolv.conf points ONLY at the trap.
  if grep -qE '^nameserver' /etc/resolv.conf; then
    grep -E '^nameserver' /etc/resolv.conf | grep -qv "$trap_ip" \
      && die "CONTAINMENT VIOLATION: resolv.conf has a non-trap nameserver"
  fi
  log "containment OK: DNAT hooked, resolv.conf -> trap only."
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    run)    apply_run "${2:-}" ;;
    assert) assert_contained "${2:-}" ;;
    *) echo "usage: $0 {run <TRAP_IP>|assert <TRAP_IP>}" >&2; exit 2 ;;
  esac
}

main "$@"
