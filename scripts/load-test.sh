#!/usr/bin/env bash
#
# load-test.sh — production load test for Claude Rabbit's public surfaces.
#
# Run against a PROD build (`npm run build && npx next start -p <port>`), NOT the
# dev server. Drives autocannon at the homepage, an SSR report page, and a trust
# badge — the three surfaces that take organic / SEO traffic. The scan edge
# function is deliberately NOT load-tested: it makes paid Gemini calls and is
# rate-limited by design, so hammering it would be both costly and
# unrepresentative of steady-state traffic (the cached report path is what scales).
#
# Usage:
#   scripts/load-test.sh [BASE_URL] [REPO_PATH] [CONNS] [DURATION_S]
#   scripts/load-test.sh http://localhost:3100 /unjs/mlly 30 10
set -uo pipefail

BASE="${1:-http://localhost:3100}"
REPO="${2:-/unjs/mlly}"      # a CACHED report (must already be scanned)
CONNS="${3:-30}"
DUR="${4:-10}"

summarize() {
  # Reads autocannon -j JSON on stdin → a one-line summary.
  python3 -c "
import json, sys
d = json.load(sys.stdin)
l, r = d['latency'], d['requests']
print(f\"  rps avg={r['average']:.0f} | p50={l['p50']}ms p99={l['p99']}ms max={l['max']}ms\"
      f\" | errors={d['errors']} timeouts={d['timeouts']} non2xx={d['non2xx']}\")
"
}

run() {
  local label="$1" url="$2"
  echo "=== ${label} (${CONNS} conns x ${DUR}s) → ${url} ==="
  npx --yes autocannon -c "$CONNS" -d "$DUR" -j "$url" 2>/dev/null | summarize
}

echo "Claude Rabbit load test — base=${BASE}"
run "Homepage"   "${BASE}/"
run "SSR report" "${BASE}${REPO}"
run "Trust badge" "${BASE}/badge${REPO}"
echo "Note: the scan edge function is intentionally NOT load-tested (paid + rate-limited)."
