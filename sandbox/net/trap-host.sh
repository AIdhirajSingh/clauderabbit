#!/usr/bin/env bash
#
# trap-host.sh — provisions the TRAP / CONTROL host for the monitored sinkhole.
#
# This runs ON the trap VM (delivered as a startup-script or executed over SSH).
# The trap is the controlled internal destination that the detonation VM's
# traffic is redirected to. It is OUTSIDE the detonation VM and the running code
# cannot detect, kill, or forge it — it is the tamper-proof monitor.
#
# It provides THREE services + ONE independent record + containment hardening:
#
#   1. dnsmasq  — a DNS resolver that answers EVERY query with the trap's OWN
#                 private IP. So any name the detonated code resolves (evil C2,
#                 mining pool, anything) points back at the trap. (RUN phase.)
#   2. sinkd.py — a catch-all TCP/TLS/HTTP sink that accepts any connection on
#                 any port, speaks enough to make the client believe it
#                 succeeded, and records SNI/Host/path/payload INERT. (RUN phase.)
#   3. squid    — an allowlist HTTP/HTTPS proxy that permits ONLY package
#                 registries (npm, PyPI), used by the detonation VM during the
#                 BUILD phase so normal repos can install deps. Everything else
#                 is REFUSED. (BUILD phase.)
#   4. tcpdump  — a packet capture on the trap's NIC: the trustworthy, external
#                 network record that survives even if the detonation VM is owned
#                 and its in-VM strace is tampered with.
#
#   CONTAINMENT HARDENING (so the trap can NEVER forward detonation traffic to a
#   real destination, even though it has an external IP for the build proxy):
#     - net.ipv4.ip_forward = 0      (kernel will not route between paths)
#     - iptables FORWARD policy DROP (belt: drop anything that tries to forward)
#     - NO MASQUERADE / SNAT rule    (nothing to translate detonation traffic out)
#   These are asserted at the end; provisioning ABORTS if any is wrong.
#
# Usage (on the trap VM):
#   sudo trap-host.sh provision     # install + configure everything, start services
#   sudo trap-host.sh registries    # print the allowlisted registry domains (for the VM proxy env)
#   sudo trap-host.sh assert        # re-verify containment (ip_forward=0, FORWARD DROP, no NAT)
set -uo pipefail

SINK_DIR="/etc/cr-sink"
SINK_CAPTURE_DIR="/var/log/cr-sink"
SINK_CAPTURE="$SINK_CAPTURE_DIR/capture.jsonl"
SINK_CERT="$SINK_DIR/sink.pem"
SINK_PY="/opt/cr/sinkd.py"
PCAP="$SINK_CAPTURE_DIR/trap.pcap"
SQUID_CONF="/etc/squid/squid.conf"
DNSMASQ_CONF="/etc/dnsmasq.d/cr-sinkhole.conf"

# The ONLY domains the build proxy permits, as squid dstdomain entries. squid
# REJECTS an ACL that lists both an apex-dot form and one of its subdomains
# (e.g. ".npmjs.org" AND "registry.npmjs.org"), so we use the apex-dot forms
# only — ".npmjs.org" already covers registry.npmjs.org, and so on. These are
# the package registries and nothing else; everything else is default-denied.
ALLOW_REGISTRIES=(
  ".npmjs.org"
  ".yarnpkg.com"
  ".pypi.org"
  ".pythonhosted.org"
)

log() { echo "[trap] $*" >&2; }
die() { log "FATAL: $*"; exit 1; }

priv_ip() {
  # The trap's PRIMARY internal (10.200.0.0/24) IP. Everything the detonation VM
  # talks to MUST be this private address, never the external IP.
  hostname -I | tr ' ' '\n' | grep -E '^10\.200\.' | head -1
}

cmd_provision() {
  export DEBIAN_FRONTEND=noninteractive
  log "apt update + trap tooling (dnsmasq, squid, tcpdump, openssl, python3)"
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y --no-install-recommends \
    dnsmasq squid tcpdump openssl python3 ca-certificates iptables jq >/dev/null 2>&1 \
    || die "apt install failed"

  local TRAP_IP
  TRAP_IP="$(priv_ip)"
  [ -n "$TRAP_IP" ] || die "could not determine trap private 10.200.x IP"
  log "trap private IP = $TRAP_IP"

  mkdir -p "$SINK_DIR" "$SINK_CAPTURE_DIR" /opt/cr

  # ---- containment hardening FIRST (before any service is up) --------------
  log "hardening containment: ip_forward=0, FORWARD DROP, no NAT"
  sysctl -w net.ipv4.ip_forward=0 >/dev/null
  echo "net.ipv4.ip_forward=0" > /etc/sysctl.d/99-cr-noforward.conf
  iptables -P FORWARD DROP
  iptables -F FORWARD
  # Ensure there is NO masquerade/SNAT that could translate detonation traffic
  # out to the real internet.
  iptables -t nat -F POSTROUTING 2>/dev/null || true

  # ---- self-signed cert for the TLS sink -----------------------------------
  if [ ! -f "$SINK_CERT" ]; then
    log "generating throwaway self-signed cert for the TLS sink"
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$SINK_DIR/sink.key" -out "$SINK_DIR/sink.crt" \
      -days 3 -subj "/CN=cr-sinkhole" >/dev/null 2>&1 \
      || die "openssl cert generation failed"
    cat "$SINK_DIR/sink.crt" "$SINK_DIR/sink.key" > "$SINK_CERT"
    chmod 600 "$SINK_CERT"
  fi

  # ---- dnsmasq: answer EVERY query with the trap's private IP --------------
  log "configuring dnsmasq sinkhole (every name -> $TRAP_IP)"
  systemctl stop systemd-resolved >/dev/null 2>&1 || true
  cat > "$DNSMASQ_CONF" <<EOF
# Claude Rabbit sinkhole DNS: resolve EVERYTHING to the trap private IP.
# A malicious lookup of evil-c2 / mining-pool returns the trap, so the
# subsequent connection lands in the sink — never at the real host.
listen-address=$TRAP_IP,127.0.0.1
bind-interfaces
no-resolv
no-hosts
# address=/#/ is the catch-all: any domain -> trap IP.
address=/#/$TRAP_IP
EOF
  systemctl enable dnsmasq >/dev/null 2>&1 || true
  systemctl restart dnsmasq >/dev/null 2>&1 || die "dnsmasq failed to start"

  # ---- squid: BUILD-phase allowlist proxy (registries ONLY) ----------------
  log "configuring squid build proxy (registries ONLY, default DENY)"
  : > "$SQUID_CONF"
  {
    echo "# Claude Rabbit build proxy — allowlist registries ONLY, deny all else."
    echo "http_port 3128"
    echo "# Intra-VPC source only (the detonation VM)."
    echo "acl srcsubnet src 10.200.0.0/24"
    echo "acl registries dstdomain ${ALLOW_REGISTRIES[*]}"
    echo "# CONNECT (HTTPS tunnels) allowed ONLY to 443 and ONLY to registries."
    echo "acl SSL_ports port 443"
    echo "acl Safe_ports port 80 443"
    echo "acl CONNECT method CONNECT"
    echo "# Deny CONNECT to anything that is not an allowlisted registry domain."
    echo "# A bare-IP CONNECT does not match dstdomain, so it falls through to deny."
    echo "http_access deny CONNECT !registries"
    echo "http_access deny CONNECT !SSL_ports"
    echo "http_access deny !Safe_ports"
    echo "# Allow registry traffic from the subnet; deny everything else."
    echo "http_access allow srcsubnet registries"
    echo "http_access deny all"
    echo "# Do not advertise ourselves; minimal logging of denied attempts."
    echo "via off"
    echo "forwarded_for delete"
    # Log into squid's OWN dir (/var/log/squid), which is owned by the 'proxy'
    # user squid drops to — /var/log/cr-sink is root-owned and not writable by
    # 'proxy', which makes squid FATAL on startup.
    echo "access_log stdio:/var/log/squid/cr-access.log"
    echo "cache deny all"
  } >> "$SQUID_CONF"
  # Make sure squid's spool/log dir exists and is owned by the proxy user.
  mkdir -p /var/log/squid /var/spool/squid
  chown -R proxy:proxy /var/log/squid /var/spool/squid 2>/dev/null || true
  # Validate the config before (re)starting so a bad ACL fails LOUDLY here
  # rather than silently leaving the build proxy down.
  if ! squid -k parse >/tmp/cr-squid-parse.log 2>&1; then
    log "ERROR: squid config rejected — build proxy will be DOWN:"
    tail -5 /tmp/cr-squid-parse.log >&2 || true
  fi
  systemctl enable squid >/dev/null 2>&1 || true
  systemctl restart squid >/dev/null 2>&1 || log "WARNING: squid restart returned non-zero"
  sleep 1
  if systemctl is-active squid >/dev/null 2>&1; then
    log "squid build proxy active on :3128 (registries only)"
  else
    log "WARNING: squid is NOT active — build-phase dependency fetch will fail"
  fi

  # ---- tcpdump: the independent, tamper-proof network record ---------------
  log "starting tcpdump packet capture (external monitor) -> $PCAP"
  # Capture on the primary interface; ignore SSH/IAP control traffic noise by
  # excluding port 22. Rotate-cap at a bounded size so it cannot fill the disk.
  pkill -f "tcpdump.*$PCAP" 2>/dev/null || true
  nohup tcpdump -i any -n -s 0 -w "$PCAP" -C 50 -W 4 \
    "not port 22" >/dev/null 2>&1 &
  sleep 1

  # ---- sinkd: the catch-all sink -------------------------------------------
  [ -f "$SINK_PY" ] || die "sinkd.py not staged at $SINK_PY"
  log "starting catch-all sink (sinkd.py)"
  pkill -f "sinkd.py" 2>/dev/null || true
  nohup python3 "$SINK_PY" --capture "$SINK_CAPTURE" --cert "$SINK_CERT" \
    --bind "$TRAP_IP" >"$SINK_CAPTURE_DIR/sinkd.out" 2>&1 &
  sleep 1

  cmd_assert
  log "trap provisioned. private IP=$TRAP_IP  capture=$SINK_CAPTURE  pcap=$PCAP"
  echo "$TRAP_IP" > /opt/cr/TRAP_IP
  echo "ready $(date -u +%FT%TZ)" > /opt/cr/TRAP_READY
}

cmd_registries() {
  # Emit the allowlisted registry domains (apex forms), one per line.
  for d in "${ALLOW_REGISTRIES[@]}"; do
    printf '%s\n' "${d#.}"
  done | sort -u
}

cmd_assert() {
  # Containment must hold. ABORT loudly if not.
  local fwd pol mq
  fwd="$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 1)"
  [ "$fwd" = "0" ] || die "CONTAINMENT VIOLATION: ip_forward=$fwd (must be 0)"
  pol="$(iptables -L FORWARD -n 2>/dev/null | head -1)"
  echo "$pol" | grep -q "policy DROP" || die "CONTAINMENT VIOLATION: FORWARD policy is not DROP ($pol)"
  mq="$(iptables -t nat -S POSTROUTING 2>/dev/null | grep -i MASQUERADE || true)"
  [ -z "$mq" ] || die "CONTAINMENT VIOLATION: a MASQUERADE/SNAT rule is present: $mq"
  log "containment OK: ip_forward=0, FORWARD policy DROP, no MASQUERADE."
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    provision)  cmd_provision ;;
    registries) cmd_registries ;;
    assert)     cmd_assert ;;
    *) echo "usage: $0 {provision|registries|assert}" >&2; exit 2 ;;
  esac
}

main "$@"
