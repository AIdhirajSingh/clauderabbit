#!/usr/bin/env bash
# ClaudeRabbit detonation harness (DESIGN.md section 3.3). Runs as ROOT inside a
# fresh E2B VM created for exactly one scan and killed by the orchestrator in
# `finally`. Repo code runs only as uid 1001 (`cr`), behind the nftables inner
# fence, with every outbound connection and DNS query redirected into the forge.
#
# Started by lib/engine/sandbox/detonate.ts as soon as the VM exists, before the
# target is even fetched: steps 1 to 4 (per-VM CA, inner fence, forge, containment
# probe) run while the function resolves and fetches. Then the harness waits for
# /root/in/go, which the function writes only after every input below is in place.
# Nothing from the target exists in the VM before the probe has passed.
#
# Input (written by lib/engine/sandbox/detonate.ts as root):
#   /root/in/go                    written last; the harness waits for it (GO_WAIT_S)
#   /root/in/target.tgz            verified tarball bytes (GitHub archive or npm tarball)
#   /root/in/run.json              {"mode":"npm-package"|"repo","name":str|null,
#                                   "install_timeout_s":N,"entry_timeout_s":N,"fake_rate":N}
#   /root/.cr/canary.env           KEY=VALUE canary credentials (0600, root only)
#   /root/.cr/canary-patterns.txt  canary values and their encodings, one per line
# Output: /root/out.tgz holding /root/out/{result.json,checks.jsonl,capture.jsonl,
#   capture.probe.jsonl,trace.install,trace.entry,deps.json,written.txt,canary_files.txt,
#   install.out,install.err,entry.out,entry.err,forge.log,egress_drops.json}
# Every collection step has its own timeout; detonate.ts checks that the sum of
# the budgets below plus install and entry stays inside its command deadline
# (lib/engine/config.ts HARNESS_OVERHEAD_MS).
set -euo pipefail
umask 022

IN=/root/in
OUT=/root/out
CRDIR=/root/.cr
RUN=/run/cr
CR_USER=cr
CR_UID=1001
NODE_BIN=/opt/cr/node/bin
UV_BIN=/opt/cr/tools/bin
FAKETIME_LIB=/usr/lib/x86_64-linux-gnu/faketime/libfaketimeMT.so.1
TRACE_SET=execve,execveat,open,openat,creat,unlink,unlinkat,rename,renameat,renameat2,connect,sendto,sendmsg,sendmmsg,chmod,fchmodat,chdir,clone,clone3,fork,vfork
MAX_LOG=262144
# A GitHub repo is fetched, fence-proven and mapped inside this VM before the go
# file (lib/engine/sandbox/vmfetch.ts); a large repo needs most of this window.
GO_WAIT_S=150

log() { printf 'cr: %s\n' "$*"; }
now_ms() { date +%s%3N; }
check() {
  # check <name> <ok:true|false> <detail>
  jq -cn --arg n "$1" --argjson ok "$2" --arg d "$3" '{name:$n, ok:$ok, detail:$d}' >>"$OUT/checks.jsonl"
}

rm -rf "$OUT" "$RUN" /work
mkdir -p "$OUT" "$RUN" /work "$CRDIR"
chmod 0700 "$OUT" "$CRDIR"
: >"$OUT/checks.jsonl"
T0=$(now_ms)
since() { echo $(( $(now_ms) - T0 )); }

id -u "$CR_USER" | grep -qx "$CR_UID"

# ---- 1. per-VM CA -------------------------------------------------------------
log "phase forge-up"
mkdir -p "$CRDIR/ca" "$CRDIR/mitm" /etc/cr
chmod 0700 "$CRDIR/ca" "$CRDIR/mitm"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 60 \
  -subj "/CN=ClaudeRabbit Sandbox CA $(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$CRDIR/ca/key.pem" -out "$CRDIR/ca/cert.pem" >/dev/null 2>&1
cat "$CRDIR/ca/key.pem" "$CRDIR/ca/cert.pem" >"$CRDIR/mitm/mitmproxy-ca.pem"
cp "$CRDIR/ca/cert.pem" "$CRDIR/mitm/mitmproxy-ca-cert.pem"
chmod 0600 "$CRDIR/mitm/mitmproxy-ca.pem" "$CRDIR/ca/key.pem"
install -m 0644 "$CRDIR/ca/cert.pem" /etc/cr/ca.pem
cat /etc/cr/ca.pem >>/etc/ssl/certs/ca-certificates.crt
: >/etc/cr/npmrc-empty
chmod 0644 /etc/cr/npmrc-empty
CA_MS=$(since)

# ---- 2. inner fence (nftables meta skuid; the E2B kernel lacks xt_owner) -------
# Drop rules carry inline counters tagged by comment: the E2B kernel has no named
# counter objects (nft_objref), so `counter name ...` rules fail to load.
nft -f - <<NFT
flush ruleset
table inet cr {
  chain out_nat {
    type nat hook output priority -100;
    meta skuid $CR_UID udp dport 53 redirect to :5353
    meta skuid $CR_UID tcp dport 53 redirect to :5353
    meta skuid $CR_UID ip daddr != 127.0.0.0/8 meta l4proto tcp redirect to :8080
  }
  chain out_filter {
    type filter hook output priority 0; policy accept;
    meta skuid $CR_UID tcp dport { 49983, 8081 } reject with tcp reset
    meta skuid $CR_UID ip daddr 127.0.0.0/8 accept
    meta skuid $CR_UID tcp dport 8080 accept
    meta skuid $CR_UID udp dport 5353 accept
    meta skuid $CR_UID meta l4proto udp counter drop comment "cr_udp_drop"
    meta skuid $CR_UID meta l4proto { icmp, ipv6-icmp } counter drop comment "cr_icmp_drop"
    meta skuid $CR_UID meta nfproto ipv6 reject
    meta skuid $CR_UID meta l4proto != tcp counter drop comment "cr_other_drop"
  }
}
NFT
nft list table inet cr >"$OUT/nft.txt"
FENCE_MS=$(since)

# ---- 3. forge -------------------------------------------------------------------
# The DNS listener binds 127.0.0.1, the address REDIRECT gives locally generated
# packets: a wildcard-bound UDP socket answers from the VM's own address, which
# conntrack cannot map back to the resolver the client asked, so every reply was
# dropped by the client (seen in the template build smoke).
: >"$OUT/capture.jsonl"
echo "probe $(date +%s.%N)" >"$OUT/phase"
/opt/cr/tools/bin/mitmdump --mode transparent@8080 --mode dns@127.0.0.1:5353 \
  --set confdir="$CRDIR/mitm" --set connection_strategy=lazy --set upstream_cert=false \
  --set block_global=false --set termlog_verbosity=warn \
  -s /opt/cr/forge/forge_addon.py >"$OUT/forge.log" 2>&1 &
FORGE_PID=$!
for _ in $(seq 1 50); do
  if ss -ltn 'sport = :8080' | grep -q LISTEN && ss -lun 'sport = :5353' | grep -q 5353; then break; fi
  if ! kill -0 "$FORGE_PID" 2>/dev/null; then log "forge exited"; check forge_up false "mitmdump exited"; exit 3; fi
  sleep 0.05
done
ss -ltn 'sport = :8080' | grep -q LISTEN || { check forge_up false "port 8080 not listening"; exit 3; }
check forge_up true "mitmdump pid $FORGE_PID"
FORGE_MS=$(since)

# ---- 4. containment probe (before any repo code) --------------------------------
# The probes send their own User-Agent: the forge answers a curl User-Agent with a
# shell no-op and anything else with {"ok":true}.
# The three probes are independent, so they run at once; each writes its own result file.
probe_http() {
  runuser -u "$CR_USER" -- env -i PATH=/usr/bin:/bin SSL_CERT_FILE=/etc/cr/ca.pem \
    curl -sS --max-time 2 -A cr-containment-probe http://example.invalid/cr-probe >"$RUN/probe.http" 2>&1 || true
}
probe_tls() {
  runuser -u "$CR_USER" -- env -i PATH=/usr/bin:/bin SSL_CERT_FILE=/etc/cr/ca.pem \
    curl -sS --max-time 2 -A cr-containment-probe https://probe.cr-fixture.invalid/cr-probe >"$RUN/probe.tls" 2>&1 || true
}
probe_envd() {
  local reached=0
  for ENVD_ADDR in 127.0.0.1 ::1; do
    if timeout 1 runuser -u "$CR_USER" -- bash -c "exec 3<>/dev/tcp/$ENVD_ADDR/49983" 2>/dev/null; then reached=1; fi
  done
  echo "$reached" >"$RUN/probe.envd"
}
probe_http & P_HTTP=$!
probe_tls & P_TLS=$!
probe_envd & P_ENVD=$!
wait "$P_HTTP" "$P_TLS" "$P_ENVD" || true
PROBE_BODY=$(cat "$RUN/probe.http" 2>/dev/null || true)
PROBE_TLS=$(cat "$RUN/probe.tls" 2>/dev/null || true)
ENVD_REACHED=$(cat "$RUN/probe.envd" 2>/dev/null || echo 1)
PROBE_MS=$(since)
# Containment proof, smoke detonation only (run.json is root-written before any
# repo code exists; the orchestrator never sets "proof").
if [ -f "$IN/run.json" ] && [ "$(jq -r '.proof // false' "$IN/run.json")" = true ]; then
  if timeout 40 /opt/cr/bin/cr-proof.sh "$FORGE_PID" "$OUT/proof.txt"; then
    check containment_proof true "cr-proof.sh passed"
  else
    check containment_proof false "cr-proof.sh failed; see proof.txt"
  fi
fi
# The forge appends a capture record per answered request; wait (at most 1 s) until both
# probe records are on disk instead of a fixed sleep. A late probe-phase record is
# harness traffic either way (lib/engine/forensics/capture.ts excludes the probe phase).
for ((i = 0; i < 50; i++)); do
  grep -qF 'example.invalid' "$OUT/capture.jsonl" 2>/dev/null && grep -qF 'probe.cr-fixture.invalid' "$OUT/capture.jsonl" 2>/dev/null && break
  sleep 0.02
done
mv "$OUT/capture.jsonl" "$OUT/capture.probe.jsonl"
: >"$OUT/capture.jsonl"
PROBE_SEEN=$(jq -s '[.[] | select(.host=="example.invalid" and .forged_kind=="json")] | length' "$OUT/capture.probe.jsonl")
if [ "$PROBE_BODY" = '{"ok":true}' ] && [ "$PROBE_TLS" = '{"ok":true}' ] && [ "$ENVD_REACHED" = 0 ] && [ "$PROBE_SEEN" -ge 1 ]; then
  check egress_contained true "http and https forged, envd refused, forge captured the probe"
else
  check egress_contained false "http=${PROBE_BODY:0:80} https=${PROBE_TLS:0:80} envd_reached=$ENVD_REACHED captured=$PROBE_SEEN"
  log "containment probe failed; no repo code will run"
  exit 4
fi

CONTAINED_MS=$(since)

# ---- 4b. wait for the per-run inputs ----------------------------------------------
# The function writes target.tgz, run.json and the canaries, then the go file.
log "phase wait-inputs"
for ((i = 0; i < GO_WAIT_S * 50; i++)); do
  [ -f "$IN/go" ] && break
  sleep 0.02
done
if [ ! -f "$IN/go" ]; then log "inputs did not arrive within ${GO_WAIT_S} s"; check inputs_arrived false "no go file after ${GO_WAIT_S} s"; exit 5; fi
INPUTS_MS=$(since)
for f in "$IN/target.tgz" "$IN/run.json" "$CRDIR/canary.env" "$CRDIR/canary-patterns.txt"; do
  [ -f "$f" ] || { log "missing input $f"; check inputs_arrived false "missing $(basename "$f")"; exit 2; }
done
chmod 0700 "$CRDIR"
chmod 0600 "$CRDIR/canary.env" "$CRDIR/canary-patterns.txt"

INSTALL_TIMEOUT=$(jq -r '.install_timeout_s // 20' "$IN/run.json")
ENTRY_TIMEOUT=$(jq -r '.entry_timeout_s // 4' "$IN/run.json")
FAKE_RATE=$(jq -r '.fake_rate // 30' "$IN/run.json")
# The install may run past INSTALL_TIMEOUT only if the viewer asks (keep-installing),
# and never past INSTALL_MAX, which the server sizes to fit the scan's budget.
INSTALL_MAX=$(jq -r '.install_max_s // 0' "$IN/run.json")
ASK_S=15
MODE=$(jq -r '.mode' "$IN/run.json")
PKG_NAME=$(jq -r '.name // ""' "$IN/run.json")
SAFE_NAME_RE='^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$'
case "$MODE" in npm-package|repo) ;; *) log "bad mode"; exit 2 ;; esac
[[ "$INSTALL_TIMEOUT" =~ ^[0-9]+$ ]] && [[ "$ENTRY_TIMEOUT" =~ ^[0-9]+$ ]] && [[ "$FAKE_RATE" =~ ^[0-9]+$ ]] && [[ "$INSTALL_MAX" =~ ^[0-9]+$ ]] || { log "bad run.json"; exit 2; }
[ "$INSTALL_MAX" -gt "$INSTALL_TIMEOUT" ] || INSTALL_MAX=$INSTALL_TIMEOUT

# ---- 5. decoys and canaries ------------------------------------------------------
declare -A CANARY
while IFS='=' read -r k v; do
  [[ "$k" =~ ^[A-Z_]+$ ]] && [[ "$v" =~ ^[A-Za-z0-9/+_-]+$ ]] && CANARY[$k]=$v
done <"$CRDIR/canary.env"
for k in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY NPM_TOKEN GITHUB_TOKEN OPENAI_API_KEY; do
  [ -n "${CANARY[$k]:-}" ] || { log "missing canary $k"; exit 2; }
done
H=/home/$CR_USER
install -d -o "$CR_USER" -g "$CR_USER" -m 0700 "$H/.ssh" "$H/.aws" "$H/.config" "$H/.config/gh" "$H/.docker" "$H/.cache"
write_decoy() { install -o "$CR_USER" -g "$CR_USER" -m 0600 /dev/stdin "$1"; }
PEM_KIND="OPENSSH PRIV""ATE KEY"
printf -- '-----BEGIN %s-----\n%s\n-----END %s-----\n' "$PEM_KIND" "${CANARY[GITHUB_TOKEN]}${CANARY[AWS_SECRET_ACCESS_KEY]}" "$PEM_KIND" | write_decoy "$H/.ssh/id_rsa"
printf '[default]\naws_access_key_id = %s\naws_secret_access_key = %s\n' "${CANARY[AWS_ACCESS_KEY_ID]}" "${CANARY[AWS_SECRET_ACCESS_KEY]}" | write_decoy "$H/.aws/credentials"
printf '//registry.npmjs.org/:_authToken=%s\n' "${CANARY[NPM_TOKEN]}" | write_decoy "$H/.npmrc"
printf 'github.com:\n    oauth_token: %s\n    user: cr\n' "${CANARY[GITHUB_TOKEN]}" | write_decoy "$H/.config/gh/hosts.yml"
printf '{"auths":{"https://index.docker.io/v1/":{"auth":"%s"}}}\n' "$(printf 'cr:%s' "${CANARY[GITHUB_TOKEN]}" | base64 -w0)" | write_decoy "$H/.docker/config.json"
printf 'https://cr:%s@github.com\n' "${CANARY[GITHUB_TOKEN]}" | write_decoy "$H/.git-credentials"

# The install runs on a clock FAKE_RATE times fast (to trip time-delayed
# payloads). The package manager cannot be given the real clock on its own: npm
# and yarn run lifecycle scripts in the same node binaries libfaketime would have
# to tell apart. So every package-manager network timeout is multiplied by the
# clock factor instead; each stays its default length in real time.
FETCH_MS=$((60000 * FAKE_RATE))   # fetch-timeout and the yarn timeouts: 60 s in real time
# Retry waits are not scaled: a shorter real wait between retries does no harm,
# and pnpm 11 fails outright when the retry minimum passes a maximum it fixes
# itself ("minTimeout is greater than maxTimeout").
# The timeouts go in the install's user npmrc, where npm and pnpm type them as
# numbers: pnpm 11 passes a `--config.fetch-timeout=` value to
# AbortSignal.timeout as a string and every request throws.
printf 'fetch-timeout=%s\nnetwork-timeout=%s\n' "$FETCH_MS" "$FETCH_MS" >/etc/cr/npmrc-install
chmod 0644 /etc/cr/npmrc-install
# pnpm 11 no longer reads its settings from an npmrc: it reads its global
# config.yaml under XDG_CONFIG_HOME and pnpm_config_* variables. XDG_CONFIG_HOME
# is the sandbox user's own ~/.config, so decoys under it (gh/hosts.yml) stay
# where an XDG-aware reader looks; ~/.npmrc, the npm token decoy, is untouched.
install -d -o "$CR_USER" -g "$CR_USER" -m 0700 "$H/.config/pnpm"
printf 'fetchTimeout: %s\n' "$FETCH_MS" | install -o "$CR_USER" -g "$CR_USER" -m 0600 /dev/stdin "$H/.config/pnpm/config.yaml"
BASE_ENV=(
  HOME="$H" USER="$CR_USER" LOGNAME="$CR_USER" SHELL=/bin/bash LANG=C.UTF-8 TMPDIR=/tmp
  PATH="$NODE_BIN:$UV_BIN:/usr/local/bin:/usr/bin:/bin"
  LD_PRELOAD="$FAKETIME_LIB" FAKETIME="+0 x$FAKE_RATE" FAKETIME_DONT_RESET=1 FAKETIME_NO_CACHE=1
  NODE_EXTRA_CA_CERTS=/etc/cr/ca.pem SSL_CERT_FILE=/etc/cr/ca.pem REQUESTS_CA_BUNDLE=/etc/cr/ca.pem UV_SYSTEM_CERTS=1
  NPM_CONFIG_USERCONFIG=/etc/cr/npmrc-install npm_config_dangerously_allow_all_scripts=true npm_config_ignore_scripts=false
  XDG_CONFIG_HOME="$H/.config" npm_config_fetch_timeout="$FETCH_MS" pnpm_config_fetch_timeout="$FETCH_MS"
  npm_config_network_timeout="$FETCH_MS" YARN_HTTP_TIMEOUT="$FETCH_MS" YARN_NETWORK_TIMEOUT="$FETCH_MS" UV_HTTP_TIMEOUT=$((30 * FAKE_RATE))
  npm_config_fetch_retries=1 npm_config_audit=false npm_config_fund=false
  npm_config_update_notifier=false npm_config_cache="$H/.npm" CI=true
  npm_config_maxsockets=16 npm_config_network_concurrency=16 npm_config_dangerously_allow_all_builds=true
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME="$H/.cache/corepack" COREPACK_ENABLE_STRICT=0
  npm_config_cafile=/etc/cr/ca.pem YARN_HTTPS_CA_FILE_PATH=/etc/cr/ca.pem YARN_ENABLE_TELEMETRY=0 YARN_ENABLE_GLOBAL_CACHE=0
  UV_CACHE_DIR="$H/.cache/uv" UV_PYTHON_DOWNLOADS=never UV_NO_PROGRESS=1 UV_LINK_MODE=copy
  AWS_ACCESS_KEY_ID="${CANARY[AWS_ACCESS_KEY_ID]}" AWS_SECRET_ACCESS_KEY="${CANARY[AWS_SECRET_ACCESS_KEY]}"
  NPM_TOKEN="${CANARY[NPM_TOKEN]}" GITHUB_TOKEN="${CANARY[GITHUB_TOKEN]}" OPENAI_API_KEY="${CANARY[OPENAI_API_KEY]}"
)
# Collection steps run as cr without the fake clock and without canaries.
PLAIN_ENV=(HOME="$H" USER="$CR_USER" PATH="$NODE_BIN:$UV_BIN:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8
  NPM_CONFIG_USERCONFIG=/etc/cr/npmrc-empty npm_config_cache="$H/.npm" UV_CACHE_DIR="$H/.cache/uv" UV_PYTHON_DOWNLOADS=never)

# ---- 6. extract as cr --------------------------------------------------------------
install -m 0644 -o "$CR_USER" -g "$CR_USER" "$IN/target.tgz" /work/target.tgz
chown "$CR_USER:$CR_USER" /work
ECO=none
INSTALL_CMD=""
WORKDIR=/work
if [ "$MODE" = "npm-package" ]; then
  [[ "$PKG_NAME" =~ $SAFE_NAME_RE ]] || { check entry_name false "unsafe package name"; exit 2; }
  install -d -o "$CR_USER" -g "$CR_USER" /work/app
  runuser -u "$CR_USER" -- cp /work/target.tgz /work/pkg.tgz
  printf '{"name":"cr-run-app","version":"1.0.0","private":true}\n' | runuser -u "$CR_USER" -- tee /work/app/package.json >/dev/null
  ECO=npm
  WORKDIR=/work/app
  # A package scan installs what users of the package get: its production dependencies.
  INSTALL_CMD="npm install --omit=dev --no-audit --no-fund /work/pkg.tgz"
else
  install -d -o "$CR_USER" -g "$CR_USER" /work/src
  if ! timeout 90 runuser -u "$CR_USER" -- tar --no-same-permissions --no-same-owner --strip-components=1 -xzf /work/target.tgz -C /work/src; then
    check extract_complete false "repo extraction did not finish inside 90 s"
  fi
  WORKDIR=/work/src
  if [ -f /work/src/package.json ]; then
    ECO=npm
    # The package manager the repo declares (packageManager, else its lockfile), run by
    # corepack at the version the repo pins, through the same forge and fence.
    PM=$(jq -r '(.packageManager // "") | split("@")[0]' /work/src/package.json 2>/dev/null || echo "")
    if [ -z "$PM" ]; then
      if [ -f /work/src/pnpm-lock.yaml ]; then PM=pnpm
      elif [ -f /work/src/yarn.lock ]; then PM=yarn
      elif [ -f /work/src/bun.lock ] || [ -f /work/src/bun.lockb ]; then PM=bun
      else PM=npm; fi
    fi
    # Install surface: production dependencies with their scripts, the repo's own scripts,
    # and of the dev dependencies only those whose lockfile entry has an install script.
    # Every lockfile package is still checked against OSV (orchestrator), dev included.
    case "$PM" in
      pnpm)
        # The repo's minimumReleaseAge supply-chain policy makes pnpm fetch registry
        # metadata for every lockfile entry before installing anything (1,307 requests on
        # a large workspace, 10 s each through the forge), whatever the filter. The scan
        # installs the exact locked versions and is itself the check, so the policy is off here.
        PNPM_FLAGS="--prod --prefer-frozen-lockfile --config.minimum-release-age=0"
        INSTALL_CMD="pnpm install $PNPM_FLAGS"
        # pnpm-lock v6 to v8 mark build-script packages requiresBuild; v9 does not record it.
        PDEV=$(grep -c '^  /' /work/src/pnpm-lock.yaml 2>/dev/null || echo 0)
        if grep -q 'requiresBuild: true' /work/src/pnpm-lock.yaml 2>/dev/null; then
          check dev_scope true "pnpm lockfile marks build scripts; production install, dev build-script packages run by pnpm rebuild"
          INSTALL_CMD="$INSTALL_CMD && pnpm rebuild"
        else
          check dev_scope false "pnpm lockfile does not record which dev packages have install scripts (lockfile v9); production dependencies and the repo's own scripts ran, dev dependencies were not executed"
        fi
        check package_manager true "pnpm (declared)" ;;
      yarn) INSTALL_CMD="yarn install"; check package_manager true "yarn (declared)" ;;
      bun)
        # bun is not in the template: the npm install of the same manifest, marked.
        INSTALL_CMD="npm install --no-audit --no-fund"; check package_manager false "bun declared; bun is not in the sandbox, installed with npm" ;;
      *)
        if [ "$(jq -r 'has("dev_total")' "$IN/run.json")" = true ]; then
          # The server's plan: the production tree, then only the dev packages with an install script.
          DEVS=$(jq -r '(.dev_scripts // [])[] | select(test("^(@[a-z0-9._~-]+/)?[a-z0-9._~-]+@[0-9A-Za-z.+-]+$"))' "$IN/run.json" | tr '\n' ' ')
          DN=$(jq -r '(.dev_scripts // []) | length' "$IN/run.json"); DT=$(jq -r '.dev_total' "$IN/run.json")
          if [ -f /work/src/package-lock.json ] || [ -f /work/src/npm-shrinkwrap.json ]; then
            BASE="npm ci --omit=dev --no-audit --no-fund"
          else
            # No lockfile: npm resolves only the production tree (devDependencies are planned above).
            BASE="jq 'del(.devDependencies)' package.json > .cr-package.json && mv .cr-package.json package.json && npm install --no-package-lock --no-audit --no-fund"
          fi
          INSTALL_CMD="$BASE${DEVS:+ && npm install --no-save --no-package-lock --no-audit --no-fund $DEVS}"
          check dev_scope true "install scripts run ($DN packages), other code not executed ($((DT - DN)) packages)"
          check package_manager true "npm"
          PLANNED=1
        fi
        if [ -z "${PLANNED:-}" ]; then
        # No lockfile: resolve the tree once from the registry (through the forge), no scripts.
        LOCK_STEP=""
        if [ ! -f /work/src/package-lock.json ] && [ ! -f /work/src/npm-shrinkwrap.json ]; then
          LOCK_STEP="npm install --package-lock-only --ignore-scripts --no-audit --no-fund && "
        fi
        # Production tree with every script, then only the dev packages that have an install script.
        DEV_STEP='L=package-lock.json; [ -f npm-shrinkwrap.json ] && L=npm-shrinkwrap.json; '\
'D=$(jq -r "[.packages // {} | to_entries[] | select(.key != \"\" and .value.dev == true)] | length" $L); '\
'S=$(jq -r ".packages // {} | to_entries[] | select(.key != \"\" and .value.dev == true and .value.hasInstallScript == true) | ((.key | sub(\".*node_modules/\"; \"\")) + \"@\" + .value.version)" $L | sort -u); '\
'N=$(printf "%s" "$S" | grep -c . || true); echo "cr-dev-scope $N $((D - N))"; '\
'if [ -n "$S" ]; then npm install --no-save --no-package-lock --no-audit --no-fund $S; fi'
        INSTALL_CMD="${LOCK_STEP}npm ci --omit=dev --no-audit --no-fund && $DEV_STEP"
        check package_manager true "npm"
        fi ;;
    esac
    # Install only what runs (lib/engine/reach/graph.ts planWorkspace): in a workspace,
    # the root package and the planned workspace packages, with the package manager's
    # own filter. Never the whole workspace.
    WS_TOTAL=$(jq -r '.ws_total // 0' "$IN/run.json" 2>/dev/null || echo 0)
    if [ "${WS_TOTAL:-0}" -gt 0 ] 2>/dev/null; then
      WS_NAMES=$(jq -r '(.ws_selected // [])[] | select(test("^(@[a-z0-9._~-]+/)?[a-z0-9._~-]+$"))' "$IN/run.json" | tr '\n' ' ')
      WS_ROOT=$(jq -r '(.ws_root // "") | select(test("^(@[a-z0-9._~-]+/)?[a-z0-9._~-]+$"))' "$IN/run.json")
      WS_N=$(printf '%s' "$WS_NAMES" | wc -w | tr -d ' ')
      case "$PM" in
        pnpm)
          F="--filter ${WS_ROOT:-.}"; for n in $WS_NAMES; do F="$F --filter $n"; done
          INSTALL_CMD="pnpm install --prod --prefer-frozen-lockfile --config.minimum-release-age=0 $F" ;;
        yarn)
          INSTALL_CMD="(yarn workspaces focus --production $WS_ROOT $WS_NAMES || yarn install)" ;;
        *)
          F="--include-workspace-root"; for n in $WS_NAMES; do F="$F -w $n"; done
          INSTALL_CMD="npm install --omit=dev --no-audit --no-fund $F" ;;
      esac
      check workspace_scope true "installing the root and $WS_N of $WS_TOTAL workspace packages ($PM)"
    fi
  elif [ -f /work/src/pyproject.toml ] || [ -f /work/src/setup.py ] || [ -f /work/src/requirements.txt ]; then
    ECO=python
    INSTALL_CMD="uv venv --quiet /work/.venv --python /usr/bin/python3"
    if [ -f /work/src/uv.lock ]; then
      INSTALL_CMD="$INSTALL_CMD && UV_PROJECT_ENVIRONMENT=/work/.venv uv sync --frozen"
    else
      if [ -f /work/src/requirements.txt ]; then
        INSTALL_CMD="$INSTALL_CMD && uv pip install --python /work/.venv/bin/python -r requirements.txt"
      fi
      if [ -f /work/src/pyproject.toml ] || [ -f /work/src/setup.py ]; then
        INSTALL_CMD="$INSTALL_CMD && uv pip install --python /work/.venv/bin/python ."
      fi
    fi
  fi
fi

# ---- 7-8. install phase -------------------------------------------------------------
touch "$RUN/start.marker"
sleep 0.01
INSTALL_START_MS=$(since)
INSTALL_STATUS=skipped
INSTALL_EXIT=null
INSTALL_MS=0
if [ -n "$INSTALL_CMD" ]; then
  log "phase install ($ECO)"
  echo "install $(date +%s.%N)" >"$OUT/phase"
  START=$(now_ms)
  set +e
  ( cd "$WORKDIR" && exec timeout --kill-after=2 "$INSTALL_MAX" \
      strace -f --seccomp-bpf -qq -ttt -s 256 -e trace="$TRACE_SET" -o "$OUT/trace.install" -u "$CR_USER" -- \
      env -i "${BASE_ENV[@]}" bash -c "$INSTALL_CMD" ) >"$OUT/install.out" 2>"$OUT/install.err" &
  IPID=$!
  # At INSTALL_TIMEOUT the install keeps running for up to ASK_S while the scan page
  # asks "Keep installing?" (the marker line below reaches it live). The server's
  # answer is /root/in/keep-installing (root-only; the repo's code cannot write it):
  # present, the install runs on to completion or INSTALL_MAX; absent, it is stopped.
  CUT=0
  if [ "$INSTALL_MAX" -gt "$INSTALL_TIMEOUT" ]; then
    ASKED=0
    while kill -0 "$IPID" 2>/dev/null; do
      EL=$(( ($(now_ms) - START) / 1000 ))
      if [ "$EL" -ge "$INSTALL_TIMEOUT" ]; then
        if [ "$ASKED" = 0 ]; then log "install-at-limit ${INSTALL_TIMEOUT} s: waiting ${ASK_S} s for keep-installing"; ASKED=1; fi
        if [ -f "$IN/keep-installing" ]; then
          log "keep-installing: the install continues, up to ${INSTALL_MAX} s"
          check install_continued true "the viewer asked to keep installing at ${EL} s; limit ${INSTALL_MAX} s"
          break
        fi
        if [ "$EL" -ge $(( INSTALL_TIMEOUT + ASK_S )) ]; then CUT=1; kill -TERM "$IPID" 2>/dev/null; pkill -KILL -u "$CR_UID" || true; break; fi
      fi
      sleep 0.5
    done
  fi
  wait "$IPID"
  INSTALL_EXIT=$?
  [ "$CUT" = 1 ] && INSTALL_EXIT=124
  if DS=$(grep -m1 '^cr-dev-scope ' "$OUT/install.out" 2>/dev/null); then
    read -r _ DEV_RUN DEV_SKIP <<<"$DS"
    check dev_scope true "install scripts run ($DEV_RUN packages), other code not executed ($DEV_SKIP packages)"
  fi
  set -e
  INSTALL_MS=$(( $(now_ms) - START ))
  case "$INSTALL_EXIT" in
    0) INSTALL_STATUS=completed ;;
    124|137) INSTALL_STATUS=timeout; pkill -KILL -u "$CR_UID" || true ;;
    *) INSTALL_STATUS=failed ;;
  esac
  # A failed root lifecycle script (the repo's own preinstall, install,
  # postinstall or prepare, run after every dependency is installed) is not a
  # cut install: the dependencies and their scripts ran and are scored. The
  # failure is recorded.
  if [ "$INSTALL_STATUS" = failed ] && [ "$ECO" = npm ]; then
    RS=$(cat "$OUT/install.out" "$OUT/install.err" 2>/dev/null | grep -aoE "^\. (preinstall|install|postinstall|prepare): Failed|$WORKDIR (preinstall|install|postinstall|prepare): .*exit status: [0-9]+|YN0009: .*@workspace:\. couldn't build successfully.*" | tail -n 1 || true)
    if [ -z "$RS" ] && grep -aqE "^npm (error|ERR!) path $WORKDIR\$" "$OUT/install.err" 2>/dev/null && grep -aqE "^npm (error|ERR!) command failed" "$OUT/install.err" 2>/dev/null; then
      RS="npm: $(grep -aoE '^> [^ ]+ (preinstall|install|postinstall|prepare)$' "$OUT/install.out" 2>/dev/null | tail -n 1 | awk '{print $NF}') of $WORKDIR failed"
    fi
    if [ -n "$RS" ]; then
      INSTALL_STATUS=completed
      check root_script false "the repo's own lifecycle script failed (exit $INSTALL_EXIT): ${RS:0:300}"
    fi
  fi
  log "install $INSTALL_STATUS exit=$INSTALL_EXIT ms=$INSTALL_MS"
  if [ "${PM:-}" = pnpm ]; then
    # The scaled timeout as the install's own pnpm sees it, in the install's env.
    PFT=$( (cd "$WORKDIR" && timeout 15 runuser -u "$CR_USER" -- env -i "${BASE_ENV[@]}" pnpm config get fetch-timeout) 2>&1 | tail -n 1 | head -c 120 || true)
    check pnpm_fetch_timeout "$([ "$PFT" = "$FETCH_MS" ] && echo true || echo false)" "pnpm config get fetch-timeout: $PFT (want $FETCH_MS)"
  fi
  E23=$(cat "$OUT/install.out" "$OUT/install.err" 2>/dev/null | grep -c 'error (23)' || true)
  check fetch_timeouts "$([ "${E23:-0}" = 0 ] && echo true || echo false)" "${E23:-0} package-manager requests timed out (error 23)"
  # Registry pass-through (forge_addon.py): time from request to response headers.
  RT=$(jq -rs '[.[] | select(.forged_kind == "registry" and .pass == true and (.ms | type) == "number") | .ms] | sort
    | if length == 0 then "0 registry requests"
      else "\(length) registry requests, median \(.[(length / 2 | floor)] | round) ms, p95 \(.[(length * 0.95 | floor)] | round) ms, slowest \(.[-1] | round) ms" end' \
    "$OUT/capture.jsonl" 2>/dev/null || echo "registry timing unavailable")
  check registry_timing true "$RT"
  check disk_after_install true "free on /work and /tmp: $(df -h --output=avail,pcent /work /tmp 2>/dev/null | tail -n +2 | tr -s ' ' | paste -sd ';' -)"
else
  check install_manifest false "no package.json, pyproject.toml, setup.py or requirements.txt"
fi
if [ "$ECO" = python ] && [ -d /work/.venv ]; then
  timeout 2 find /work/.venv -name '*.pth' -newer "$RUN/start.marker" -type f >"$OUT/pth.txt" 2>/dev/null || true
fi

# ---- 9. entry phase ---------------------------------------------------------------------
ENTRY_SCRIPT="$RUN/entry.sh"
: >"$ENTRY_SCRIPT"
entry_line() { printf '%s\n' "$1" >>"$ENTRY_SCRIPT"; }
if [ "$INSTALL_STATUS" = completed ]; then
  if [ "$ECO" = npm ]; then
    if [ "$MODE" = npm-package ]; then
      MANI="/work/app/node_modules/$PKG_NAME/package.json"
      REQ="$PKG_NAME"
    else
      MANI=/work/src/package.json
      REQ=/work/src
    fi
    if [ -f "$MANI" ]; then
      BIN=$(jq -r 'if (.bin|type)=="string" then .bin elif (.bin|type)=="object" then (.bin|to_entries[0].value // "") else "" end' "$MANI")
      TYPE=$(jq -r '.type // "commonjs"' "$MANI")
      HAS_ENTRY=$(jq -r 'if (.main // .exports // .module) != null then "1" else "0" end' "$MANI")
      PKG_DIR=$(dirname "$MANI")
      if [ -n "$BIN" ] && [[ "$BIN" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$BIN" != *..* ]]; then
        entry_line "node '$PKG_DIR/${BIN#./}' --help || true"
      fi
      if [ -f "$PKG_DIR/index.js" ] || [ "$HAS_ENTRY" = 1 ]; then
        if [ "$TYPE" = module ]; then
          entry_line "node --input-type=module -e \"await import('$REQ')\""
        else
          entry_line "node -e \"require('$REQ')\" || node --input-type=module -e \"await import('$REQ')\""
        fi
      elif [ "$MODE" = repo ] && [ "$(jq -r '.scripts.start // ""' "$MANI")" != "" ]; then
        entry_line "npm start"
      fi
    fi
  elif [ "$ECO" = python ]; then
    SITE=$(ls -d /work/.venv/lib/python3*/site-packages 2>/dev/null | head -n1 || true)
    if [ -n "$SITE" ]; then
      for DI in "$SITE"/*.dist-info; do
        [ -f "$DI/direct_url.json" ] || continue
        jq -e '.url | startswith("file:///work/src")' "$DI/direct_url.json" >/dev/null 2>&1 || continue
        if [ -f "$DI/top_level.txt" ]; then
          while read -r mod; do
            if [[ "$mod" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then entry_line "/work/.venv/bin/python -c 'import $mod'"; fi
          done <"$DI/top_level.txt"
        elif [ -f "$DI/RECORD" ]; then
          while IFS=, read -r path _rest; do
            mod=${path%%/*}
            if [[ "$mod" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then entry_line "/work/.venv/bin/python -c 'import $mod'"; fi
          done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*/__init__\.py,' "$DI/RECORD" | sort -u)
        fi
        if [ -f "$DI/entry_points.txt" ]; then
          SCRIPT=$(awk '/^\[console_scripts\]/{f=1;next} /^\[/{f=0} f && /=/{gsub(/ /,"");split($0,a,"=");print a[1];exit}' "$DI/entry_points.txt")
          if [[ "$SCRIPT" =~ ^[A-Za-z0-9._-]+$ ]]; then entry_line "/work/.venv/bin/$SCRIPT --help || true"; fi
        fi
      done
    fi
  fi
fi

ENTRY_STATUS=skipped
ENTRY_EXIT=null
ENTRY_MS=0
CLOCK_REAL=0
CLOCK_FAKE=0
if [ -s "$ENTRY_SCRIPT" ]; then
  chmod 0755 "$RUN"
  chmod 0644 "$ENTRY_SCRIPT"
  # Clock check: one faked second must pass in well under one real second.
  C0=$(now_ms)
  CLOCK_FAKE=$(timeout 3 runuser -u "$CR_USER" -- env -i LD_PRELOAD="$FAKETIME_LIB" FAKETIME="+0 x$FAKE_RATE" FAKETIME_DONT_RESET=1 \
    bash -c 'a=$(date +%s%3N); sleep 1; b=$(date +%s%3N); echo $((b-a))' 2>/dev/null || echo 0)
  CLOCK_REAL=$(( $(now_ms) - C0 ))
  [[ "$CLOCK_FAKE" =~ ^[0-9]+$ ]] || CLOCK_FAKE=0
  if [ "$CLOCK_FAKE" -ge 900 ] && [ "$CLOCK_REAL" -lt 500 ]; then
    check clock_accelerated true "faked ${CLOCK_FAKE}ms in real ${CLOCK_REAL}ms"
  else
    check clock_accelerated false "faked ${CLOCK_FAKE}ms in real ${CLOCK_REAL}ms"
  fi
  log "phase entry"
  echo "entry $(date +%s.%N)" >"$OUT/phase"
  START=$(now_ms)
  set +e
  ( cd "$WORKDIR" && timeout --kill-after=1 "$ENTRY_TIMEOUT" \
      strace -f --seccomp-bpf -qq -ttt -s 256 -e trace="$TRACE_SET" -o "$OUT/trace.entry" -u "$CR_USER" -- \
      env -i "${BASE_ENV[@]}" bash "$ENTRY_SCRIPT" ) >"$OUT/entry.out" 2>"$OUT/entry.err"
  ENTRY_EXIT=$?
  set -e
  ENTRY_MS=$(( $(now_ms) - START ))
  case "$ENTRY_EXIT" in
    0) ENTRY_STATUS=completed ;;
    124|137) ENTRY_STATUS=timeout ;;
    *) ENTRY_STATUS=failed ;;
  esac
  log "entry $ENTRY_STATUS exit=$ENTRY_EXIT ms=$ENTRY_MS"
elif [ "$INSTALL_STATUS" = completed ]; then
  check entry_point false "no bin, main, exports, index.js, start script or importable module found"
fi
pkill -KILL -u "$CR_UID" || true
echo "collect $(date +%s.%N)" >"$OUT/phase"
COLLECT_START_MS=$(since)

# ---- 10. collect ---------------------------------------------------------------------------
DEPS_KIND=none
if [ "$ECO" = npm ] && [ -d "$WORKDIR/node_modules" ]; then
  ( cd "$WORKDIR" && timeout 3 runuser -u "$CR_USER" -- env -i "${PLAIN_ENV[@]}" npm ls --all --json --offline ) >"$OUT/deps.json" 2>/dev/null || true
  DEPS_KIND=npm-ls
elif [ "$ECO" = python ] && [ -x /work/.venv/bin/python ]; then
  timeout 3 runuser -u "$CR_USER" -- env -i "${PLAIN_ENV[@]}" uv pip list --python /work/.venv/bin/python --format json >"$OUT/deps.json" 2>/dev/null || true
  DEPS_KIND=uv-pip-list
fi
pkill -KILL -u "$CR_UID" || true

# Written files, NUL-separated so a file name holding a newline can never turn
# into a second path (a FIFO or device the root grep would block on).
set +e
timeout 5 find / /tmp /home /work /var /etc /usr/local -xdev \
  \( -path /proc -o -path /sys -o -path /dev -o -path /root -o -path /opt/cr -o -path /run/cr \) -prune \
  -o -type f -newer "$RUN/start.marker" -print0 2>/dev/null >"$RUN/written.0"
FIND_EXIT=$?
set -e
[ "$FIND_EXIT" = 124 ] && check canary_file_scan false "written-file listing passed its 5 s budget"
tr '\0' '\n' <"$RUN/written.0" | head -n 20000 >"$OUT/written.txt" || true
: >"$OUT/canary_files.txt"
# Candidates: written regular files outside the npm/uv caches and the venv tree.
# Every uid 1001 process is dead, so nothing can swap a file for a FIFO now; grep
# skips devices and FIFOs anyway, and its timeout bounds a huge or sparse file
# (a timeout is reported, and the scorer treats the record as cut).
grep -z -v -E '^/(home/cr/\.npm|home/cr/\.cache)/|/node_modules/\.cache/|/\.venv/lib/' "$RUN/written.0" | head -z -n 10000 >"$RUN/check-files.0" || true
if [ -s "$RUN/check-files.0" ]; then
  set +e
  timeout 3 xargs -0 -r grep -l -s -D skip -F -f "$CRDIR/canary-patterns.txt" -- <"$RUN/check-files.0" >>"$OUT/canary_files.txt" 2>/dev/null
  GREP_EXIT=$?
  set -e
  [ "$GREP_EXIT" = 124 ] && check canary_file_scan false "canary search of written files passed its 3 s budget"
fi

kill "$FORGE_PID" 2>/dev/null || true
wait "$FORGE_PID" 2>/dev/null || true

for f in install.out install.err entry.out entry.err forge.log; do
  if [ -f "$OUT/$f" ]; then truncate -s "<$MAX_LOG" "$OUT/$f"; fi
done
# Egress the fence dropped (UDP other than DNS, ICMP, other non-TCP), per protocol.
DROPS='{}'
for c in udp icmp other; do
  n=$(/opt/cr/bin/cr-drops.sh "cr_${c}_drop")
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  # Drops counted before the go file (the post-fetch containment check's own test
  # datagrams, root-written by vmfetch.ts before any repo code ran) are not repo behaviour.
  b=$(jq -r --arg k "$c" '.[$k] // 0' "$IN/drop-baseline.json" 2>/dev/null || echo 0)
  [[ "$b" =~ ^[0-9]+$ ]] || b=0
  n=$((n > b ? n - b : 0))
  DROPS=$(jq -c --arg k "$c" --argjson v "$n" '. + {($k): $v}' <<<"$DROPS")
done
printf '%s\n' "$DROPS" >"$OUT/egress_drops.json"

# Size caps. The capture keeps scored records ahead of registry traffic before it
# is cut; traces keep their head and tail. Any cut is reported as a check, and
# the scorer caps a run with a cut record.
CAP=8388608
if [ -f "$OUT/capture.jsonl" ] && [ "$(stat -c %s "$OUT/capture.jsonl")" -gt "$CAP" ]; then
  SIZE=$(stat -c %s "$OUT/capture.jsonl")
  if timeout 3 jq -c 'select((.forged_kind == "mirror" or .forged_kind == "registry") | not)' "$OUT/capture.jsonl" >"$RUN/cap.scored" 2>/dev/null \
    && timeout 3 jq -c 'select(.forged_kind == "mirror" or .forged_kind == "registry")' "$OUT/capture.jsonl" >"$RUN/cap.registry" 2>/dev/null; then
    cat "$RUN/cap.scored" "$RUN/cap.registry" >"$OUT/capture.jsonl"
  fi
  truncate -s "<$CAP" "$OUT/capture.jsonl"
  check forensics_truncated false "capture.jsonl ${SIZE} bytes cut to 8 MB, scored records first"
fi
# The package manager's own store and node_modules writes are folded into counts
# first (cr-trace-fold.py); script lines, execs, connects and sends all stay.
if [ -f "$OUT/trace.install" ] && [ "$(stat -c %s "$OUT/trace.install")" -gt "$CAP" ]; then
  SIZE=$(stat -c %s "$OUT/trace.install")
  if FOLD=$(timeout 30 python3 /opt/cr/bin/cr-trace-fold.py "$OUT/trace.install" "$H" "$OUT/trace.install.folded.json" 2>"$RUN/fold.err"); then
    check trace_folded true "trace.install ${SIZE} to $(stat -c %s "$OUT/trace.install") bytes: ${FOLD% *} package-manager file lines folded into counts, ${FOLD#* } lines kept"
  else
    check trace_folded false "fold did not finish: $(head -c 200 "$RUN/fold.err")"
  fi
fi
for f in trace.install trace.entry; do
  if [ -f "$OUT/$f" ] && [ "$(stat -c %s "$OUT/$f")" -gt "$CAP" ]; then
    SIZE=$(stat -c %s "$OUT/$f")
    { head -c 4194304 "$OUT/$f"; printf '\n'; tail -c 4194304 "$OUT/$f"; } >"$RUN/$f.cut"
    mv "$RUN/$f.cut" "$OUT/$f"
    check forensics_truncated false "$f ${SIZE} bytes cut to its first and last 4 MB"
  fi
done
truncate -s "<$CAP" "$OUT/written.txt"

jq -n \
  --arg mode "$MODE" --arg eco "$ECO" --arg deps "$DEPS_KIND" \
  --arg is "$INSTALL_STATUS" --argjson ie "$INSTALL_EXIT" --argjson ims "$INSTALL_MS" --arg icmd "$INSTALL_CMD" \
  --arg es "$ENTRY_STATUS" --argjson ee "$ENTRY_EXIT" --argjson ems "$ENTRY_MS" \
  --argjson cr "$CLOCK_REAL" --argjson cf "$CLOCK_FAKE" --argjson total "$(since)" \
  --argjson pca "$CA_MS" --argjson pfe "$FENCE_MS" --argjson pf "$FORGE_MS" --argjson pp "$PROBE_MS" --argjson pc "$CONTAINED_MS" --argjson pi "$INPUTS_MS" --argjson pis "$INSTALL_START_MS" --argjson pcs "$COLLECT_START_MS" \
  '{version:1, mode:$mode, ecosystem:$eco, deps_kind:$deps,
    install:{status:$is, exit_code:$ie, ms:$ims, command:$icmd},
    entry:{status:$es, exit_code:$ee, ms:$ems},
    clock:{real_ms:$cr, fake_ms:$cf}, total_ms:$total,
    phases:{ca_ms:$pca, fence_ms:$pfe, forge_ms:$pf, probe_ms:$pp, contained_ms:$pc, inputs_ms:$pi, install_start_ms:$pis, collect_start_ms:$pcs}}' >"$OUT/result.json"

timeout 4 tar -czf /root/out.tmp.tgz -C /root out
mv /root/out.tmp.tgz /root/out.tgz
log "done $(jq -c '{install:.install.status, entry:.entry.status}' "$OUT/result.json")"
