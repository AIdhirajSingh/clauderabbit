#!/usr/bin/env bash
# Template start command (sandbox/e2b/template.ts setStartCmd). Runs once, as root,
# when E2B snapshots the template, never in a scan: it starts every tool a scan
# runs on our own files (the rule files and the forge sources), so their code is in
# the page cache of the memory snapshot every scan VM is restored from. Measured on
# the preview (docs/runs/2.0-keyday.md step 8): in a fresh VM Semgrep took 5.7 s
# cold and 1.9 s warm, npm 1.8 s and 0.1 s, mitmdump 1.5 s and 0.7 s.
#
# No repo code exists here and nothing it writes survives: the scratch output and
# the tools' own caches are removed before the ready file is written. Every scan
# VM is still a fresh restore of this one clean snapshot (per-scan reset).
set -uo pipefail
export PATH=/opt/cr/node/bin:/opt/cr/tools/bin:/opt/cr/venv/bin:/usr/bin:/bin
export SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 HOME=/root
W=/tmp/cr-warm
rm -rf "$W" && mkdir -p "$W"
timeout 60 semgrep scan --config /opt/cr/rules/semgrep --json --metrics=off --disable-version-check --jobs 1 /opt/cr/forge >"$W/sg" 2>&1 || true
timeout 60 guarddog npm scan /opt/cr/forge --output-format=json >"$W/gd" 2>&1 || true
timeout 60 /opt/cr/venv/bin/python /opt/cr/bin/cr-yara.py /opt/cr/rules/yara /opt/cr/forge >"$W/yx" 2>&1 || true
timeout 60 mitmdump --version >"$W/mi" 2>&1 || true
timeout 60 /opt/cr/tools/uv/mitmproxy/bin/python -c "import mitmproxy.tools.main, mitmproxy.addons, mitmproxy.proxy.server" >"$W/mp" 2>&1 || true
timeout 60 npm --version >"$W/np" 2>&1 || true
timeout 60 node -e "require('https'); require('child_process')" >"$W/no" 2>&1 || true
timeout 20 strace -V >/dev/null 2>&1 || true
timeout 20 openssl version >/dev/null 2>&1 || true
rm -rf "$W" /root/.semgrep /root/.npm /root/.cache/guarddog /root/.config/mitmproxy
sync
: >/run/cr-warm.done
