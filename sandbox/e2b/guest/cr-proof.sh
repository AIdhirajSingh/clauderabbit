#!/usr/bin/env bash
# Containment proof (DESIGN.md section 3.3). Called by cr-detonate.sh as ROOT only
# when /root/in/run.json carries "proof": true, which only the smoke detonation
# (cr-smoke.sh) writes; the orchestrator never sets it. It runs after the forge
# and the inner fence are up and before any repo code, and records, from inside
# the VM, what the fence and the forge do to uid 1001.
#
#   cr-proof.sh <forge_pid> <out_file>
#
# Exit 0 when every assertion holds, 1 otherwise. Every section is printed to
# <out_file> either way so a failure shows its evidence.
set -uo pipefail

FORGE_PID=$1
OUT_FILE=$2
CR_USER=cr
FAILED=0
CR_ENV=(env -i PATH=/usr/bin:/bin HOME=/home/cr LANG=C.UTF-8)

exec 3>"$OUT_FILE"
say() { printf '%s\n' "$*" >&3; }
section() { printf '\n== %s ==\n' "$*" >&3; }
pass() { printf 'PASS %s\n' "$*" >&3; }
fail() { printf 'FAIL %s\n' "$*" >&3; FAILED=1; }
drop_count() { /opt/cr/bin/cr-drops.sh "$1"; }

section "resources"
say "nproc: $(nproc)"
say "$(grep -E '^MemTotal:' /proc/meminfo)"
say "kernel: $(uname -r)"

section "forge process (ps -o user,uid,pid,cmd)"
ps -o user,uid,pid,cmd -p "$FORGE_PID" >&3 2>&1
FORGE_UID=$(ps -o uid= -p "$FORGE_PID" | tr -d ' ')
FORGE_CMD=$(ps -o cmd= -p "$FORGE_PID")
if [ "$FORGE_UID" = 0 ] && [[ "$FORGE_CMD" == *mitmdump* ]] && [[ "$FORGE_CMD" == *forge_addon.py* ]]; then
  pass "forge (mitmdump + forge_addon.py) runs as uid 0"
else
  fail "forge uid=${FORGE_UID:-none} cmd=${FORGE_CMD:-none}"
fi
say "listeners:"
ss -ltnup 2>/dev/null | grep -E ':(8080|5353)\b' >&3 || true

section "detonation user"
id "$CR_USER" >&3
[ "$(id -u "$CR_USER")" = 1001 ] && pass "repo user cr is uid 1001" || fail "cr is not uid 1001"

section "nft list ruleset"
nft list ruleset >&3
RULESET=$(nft list ruleset)
if grep -Eq 'meta skuid 1001 .*tcp redirect to :8080' <<<"$RULESET" \
  && grep -Eq 'meta skuid 1001 .*udp .*counter packets [0-9]+ bytes [0-9]+ drop comment "cr_udp_drop"' <<<"$RULESET"; then
  pass "skuid 1001 TCP redirect and UDP drop rules loaded"
else
  fail "skuid 1001 rules missing from the ruleset"
fi

section "uid 1001 raw UDP to 1.1.1.1:443 (fence drop rule)"
UDP_BEFORE=$(drop_count cr_udp_drop)
runuser -u "$CR_USER" -- "${CR_ENV[@]}" python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(2)
try:
    s.sendto(b"cr-proof", ("1.1.1.1", 443))
    s.recvfrom(64)
    print("udp reply received")
except Exception as e:
    print("udp: " + type(e).__name__ + " " + str(e))
' >&3 2>&1
UDP_AFTER=$(drop_count cr_udp_drop)
say "cr_udp_drop packets: before=$UDP_BEFORE after=$UDP_AFTER"
if [ "$UDP_AFTER" -gt "$UDP_BEFORE" ]; then pass "drop counter incremented for uid 1001 UDP"; else fail "drop counter did not move"; fi

section "uid 1001 ICMP datagram to 1.1.1.1 (fence drop rule)"
ICMP_BEFORE=$(drop_count cr_icmp_drop)
runuser -u "$CR_USER" -- "${CR_ENV[@]}" python3 -c '
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
except OSError as e:
    print("icmp socket not permitted for uid 1001: " + str(e))
    raise SystemExit(0)
s.settimeout(2)
try:
    s.sendto(b"\x08\x00\x00\x00\x00\x01\x00\x01cr-proof", ("1.1.1.1", 0))
    s.recvfrom(64)
    print("icmp reply received")
except Exception as e:
    print("icmp: " + type(e).__name__ + " " + str(e))
' >&3 2>&1
say "cr_icmp_drop packets: before=$ICMP_BEFORE after=$(drop_count cr_icmp_drop)"

section "uid 1001 TCP to 1.1.1.1:80 (redirected into the forge)"
BODY=$(runuser -u "$CR_USER" -- "${CR_ENV[@]}" curl -sS --max-time 5 -w '\nhttp_code=%{http_code} remote=%{remote_ip}:%{remote_port}' http://1.1.1.1/cr-proof-direct-ip 2>&1)
say "$BODY"
if [ "$(printf '%s' "$BODY" | head -n1)" = '{"ok":true}' ]; then
  pass "uid 1001 never reached 1.1.1.1; the forge answered with its forged body"
else
  fail "direct-IP request was not answered by the forge"
fi

section "uid 1001 HTTPS to https://example.com (forge intercepts TLS)"
ISSUER=$(runuser -u "$CR_USER" -- "${CR_ENV[@]}" bash -c 'openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject' 2>&1)
say "$ISSUER"
TLS_BODY=$(runuser -u "$CR_USER" -- "${CR_ENV[@]}" SSL_CERT_FILE=/etc/cr/ca.pem curl -sS --max-time 5 -w '\nhttp_code=%{http_code} remote=%{remote_ip}' https://example.com/cr-proof-tls 2>&1)
say "$TLS_BODY"
if [[ "$ISSUER" == *"ClaudeRabbit Sandbox CA"* ]] && [ "$(printf '%s' "$TLS_BODY" | head -n1)" = '{"ok":true}' ]; then
  pass "TLS terminated by the per-VM forge CA; forged body returned"
else
  fail "HTTPS was not intercepted by the forge"
fi

section "uid 1001 DNS (redirected into the forge resolver)"
runuser -u "$CR_USER" -- "${CR_ENV[@]}" python3 -c '
import socket
print("example.com ->", socket.gethostbyname("example.com"))
' >&3 2>&1

section "forge capture records for the requests above"
sleep 0.3
jq -c 'select(.path != null and (.path|test("cr-proof"))) | {host, method, path, tls, forged_kind, phase}' /root/out/capture.jsonl >&3 2>&1 || true
if jq -s -e 'map(select(.path != null and (.path|contains("cr-proof-direct-ip")) and .forged_kind == "json")) | length >= 1' /root/out/capture.jsonl >/dev/null 2>&1 \
  && jq -s -e 'map(select(.host == "example.com" and .tls == "intercepted" and .forged_kind == "json")) | length >= 1' /root/out/capture.jsonl >/dev/null 2>&1; then
  pass "forge recorded both forged requests"
else
  fail "forge capture is missing the proof requests"
fi

section "root (outside the inner fence) to 1.1.1.1:443 (outer E2B egress policy; informational)"
curl -sS --max-time 4 -o /dev/null -w 'http_code=%{http_code}\n' https://1.1.1.1/ >&3 2>&1 || say "root egress to 1.1.1.1 failed (exit $?)"

section "fence drop counters (packets per tagged rule)"
for c in cr_udp_drop cr_icmp_drop cr_other_drop; do say "$c=$(drop_count "$c")"; done

section "result"
if [ "$FAILED" = 0 ]; then say "cr-proof: PASS"; else say "cr-proof: FAIL"; fi
exit "$FAILED"
