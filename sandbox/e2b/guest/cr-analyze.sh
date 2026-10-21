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
# In the detonation VM (one VM per scan) the scanners run before any repo code, on
# the tree vmfetch.ts already extracted (CR_ANALYZE_SRC), writing to their own
# directory (CR_ANALYZE_OUT) so the harness's /root/out and /work stay untouched.
OUT=${CR_ANALYZE_OUT:-/root/out}
SRC=${CR_ANALYZE_SRC:-/work/src}
TOOLS=/opt/cr/tools/bin
export PATH="$TOOLS:/opt/cr/venv/bin:/usr/local/bin:/usr/bin:/bin"
export SEMGREP_SEND_METRICS=off
export SEMGREP_ENABLE_VERSION_CHECK=0

rm -rf "$OUT"
mkdir -p "$OUT"
chmod 0700 "$OUT"

if [ -z "${CR_ANALYZE_SRC:-}" ]; then
  rm -rf "$SRC"
  mkdir -p "$SRC"
  tar --no-same-owner --no-same-permissions --no-overwrite-dir -xzf "$IN/src.tgz" -C "$SRC"
fi
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

# Scope. Scanning every file of a large monorepo (18,000+) cannot finish inside the
# tool timeout, and all three scanners were killed (exit 124) with no output. Above
# SCOPE_MAX_FILES the scanners read a bounded copy of the tree instead: code and
# manifest files only, test/spec/fixture/mock/example paths and vendored or built
# output left out (they are never install- or entry-reachable), ordered root first
# and shallowest first, capped at SCOPE_MAX_FILES. The scope is recorded in
# scope.json so the report states the scan was scoped, never full.
SCOPE_MAX_FILES=$(jq -r '.scope_max_files // 2500' "$IN/analyze.json")
TARGET="$SRC"
total=$(find "$SRC" -type f | wc -l)
if [ "$total" -gt "$SCOPE_MAX_FILES" ]; then
  SCOPE="$(cd "$(dirname "$OUT")" && pwd)/cr-scope"
  rm -rf "$SCOPE"
  mkdir -p "$SCOPE"
  (cd "$SRC" && find . -type f \
      \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' -o -name '*.ts' -o -name '*.cts' -o -name '*.mts' \
         -o -name '*.jsx' -o -name '*.tsx' -o -name '*.py' -o -name '*.sh' -o -name 'package.json' \
         -o -name 'setup.py' -o -name 'pyproject.toml' \) \
      -size -1M \
      -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' \
      -not -path '*/vendor/*' -not -path '*/.next/*' -not -path '*/coverage/*' \
      -not -ipath '*/test/*' -not -ipath '*/tests/*' -not -path '*/__tests__/*' -not -path '*/__mocks__/*' \
      -not -ipath '*/spec/*' -not -ipath '*/fixtures/*' -not -ipath '*/fixture/*' -not -ipath '*/mocks/*' \
      -not -ipath '*/examples/*' -not -ipath '*/example/*' -not -ipath '*/e2e/*' \
      -not -name '*.test.*' -not -name '*.spec.*' -not -name '*.min.js' -not -name '*.d.ts' \
      -print | awk -F/ '{ print NF "\t" $0 }' | sort -n -k1,1 | head -n "$SCOPE_MAX_FILES" | cut -f2- >"$OUT/scope.list")
  (cd "$SRC" && cpio -pdm --quiet "$SCOPE" <"$OUT/scope.list") 2>/dev/null || (cd "$SRC" && while IFS= read -r f; do mkdir -p "$SCOPE/$(dirname "$f")" && cp -p "$f" "$SCOPE/$f"; done <"$OUT/scope.list")
  scoped=$(wc -l <"$OUT/scope.list")
  printf '{"scoped":true,"total_files":%d,"scanned_files":%d}\n' "$total" "$scoped" >"$OUT/scope.json"
  TARGET="$SCOPE"
else
  printf '{"scoped":false,"total_files":%d,"scanned_files":%d}\n' "$total" "$total" >"$OUT/scope.json"
fi

run_tool semgrep "$OUT/semgrep.json" semgrep scan --config /opt/cr/rules/semgrep --json --metrics=off \
  --disable-version-check --no-git-ignore --timeout 8 --max-target-bytes 2000000 --jobs "$(nproc)" "$TARGET" &
if [ "$NPM" = "true" ]; then
  run_tool guarddog-npm "$OUT/guarddog-npm.json" guarddog npm scan "$TARGET" --output-format=json &
fi
if [ "$PY" = "true" ]; then
  run_tool guarddog-pypi "$OUT/guarddog-pypi.json" guarddog pypi scan "$TARGET" --output-format=json &
fi
run_tool yara "$OUT/yara.json" /opt/cr/venv/bin/python /opt/cr/bin/cr-yara.py /opt/cr/rules/yara "$TARGET" &
wait

# Findings from the scoped copy name the copy's path; point them back at the tree
# so they line up with the archive map like a full scan's findings.
if [ "$TARGET" != "$SRC" ]; then
  for f in "$OUT"/semgrep.json "$OUT"/guarddog-*.json "$OUT"/yara.json; do
    [ -f "$f" ] && sed -i "s#${TARGET}/#${SRC%/}/#g" "$f"
  done
  rm -rf "$TARGET"
fi

jq -s 'map({(.tool): {exit: .exit, ms: .ms}}) | add // {}' "$OUT/status.jsonl" >"$OUT/status.json"
echo "analysis complete: $(jq -c . "$OUT/status.json")"
