#!/usr/bin/env bash
# ClaudeRabbit analysis harness (DESIGN.md sections 2.1, 3.1).
#
# Runs as root inside the ANALYSIS sandbox (allowInternetAccess: false). It never
# runs repo code: it extracts the normalized archive the orchestrator uploaded
# and runs Semgrep, GuardDog and YARA over the bytes. Results land in /root/out
# and are read back by lib/engine/sandbox/analyze.ts.
#
# Input:  /root/in/src.tgz   (normalized repack of the verified archive, no links)
#         /root/in/analyze.json  {"ecosystems":["npm","python"],"tool_timeout_s":12}
# Output: /root/out/semgrep.json guarddog-npm.json guarddog-pypi.json yara.json
#         /root/out/status.json {"<tool>":{"exit":N,"ms":N}}
set -euo pipefail

IN=/root/in
OUT=/root/out
SRC=/work/src
TOOLS=/opt/cr/tools/bin
export PATH="$TOOLS:/opt/cr/venv/bin:/usr/local/bin:/usr/bin:/bin"
export SEMGREP_SEND_METRICS=off
export SEMGREP_ENABLE_VERSION_CHECK=0

rm -rf "$OUT" "$SRC"
mkdir -p "$OUT" "$SRC"
chmod 0700 "$OUT"

tar --no-same-owner --no-same-permissions --no-overwrite-dir -xzf "$IN/src.tgz" -C "$SRC"
# The repack holds regular files only; refuse anything else defensively.
find "$SRC" ! -type f ! -type d -delete

TOOL_TIMEOUT=$(jq -r '.tool_timeout_s // 12' "$IN/analyze.json")
NPM=$(jq -r '(.ecosystems // []) | index("npm") != null' "$IN/analyze.json")
PY=$(jq -r '(.ecosystems // []) | index("python") != null' "$IN/analyze.json")

now_ms() { date +%s%3N; }

run_tool() {
  # run_tool <name> <outfile> <cmd...>
  local name=$1 out=$2
  shift 2
  local start rc
  start=$(now_ms)
  set +e
  timeout --kill-after=2 "$TOOL_TIMEOUT" "$@" >"$out" 2>"$OUT/$name.err"
  rc=$?
  set -e
  printf '{"tool":"%s","exit":%d,"ms":%d}\n' "$name" "$rc" "$(( $(now_ms) - start ))" >>"$OUT/status.jsonl"
}

: >"$OUT/status.jsonl"
run_tool semgrep "$OUT/semgrep.json" semgrep scan --config /opt/cr/rules/semgrep --json --metrics=off \
  --disable-version-check --no-git-ignore --timeout 8 --max-target-bytes 2000000 --jobs 2 "$SRC" &
if [ "$NPM" = "true" ]; then
  run_tool guarddog-npm "$OUT/guarddog-npm.json" guarddog npm scan "$SRC" --output-format=json &
fi
if [ "$PY" = "true" ]; then
  run_tool guarddog-pypi "$OUT/guarddog-pypi.json" guarddog pypi scan "$SRC" --output-format=json &
fi
run_tool yara "$OUT/yara.json" /opt/cr/venv/bin/python /opt/cr/bin/cr-yara.py /opt/cr/rules/yara "$SRC" &
wait

jq -s 'map({(.tool): {exit: .exit, ms: .ms}}) | add // {}' "$OUT/status.jsonl" >"$OUT/status.json"
echo "analysis complete: $(jq -c . "$OUT/status.json")"
