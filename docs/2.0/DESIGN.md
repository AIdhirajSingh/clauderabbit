# ClaudeRabbit 2.0 backend: binding design contract

Status: binding for steps 2 to 8. Written in step 1 (audit and design) against tag `pre-2.0` (commit `240d6b3`).
Every external fact below is listed in section 12 with the command or first-party page that produced it.
Prose rules for every file this rebuild touches: no em dashes, none of the banned words from the owner brief.

## 0. One-paragraph summary

One serverless scan in a Vercel function. Every scan runs the code. Request in, SHA cache check, fetch the
GitHub or npm tarball into memory and verify it, then four branches in parallel: static scanners (Semgrep,
YARA, GuardDog inside an E2B analysis sandbox, OSV lookup and in-process heuristics in Vercel), a
reachability graph of install and import code, three Luna readers on that slice, and a detonation in a fresh
E2B sandbox where a root forge answers every outbound call and the repo runs as uid 1001 on a fast fake clock.
A deterministic formula in code produces the score (behaviour outweighs static, unreachable code never lowers
it, reputation separate, doc-versus-code kept, never a bare "Safe"). Luna writes the report. One event stream
(stages, timings, transcript, forged calls, files, processes, checks) goes to the HTTP client, to a Supabase
table, and to Supabase Realtime, and replays per SHA. Every response carries an ad. Web API, CLI, stdio MCP and
remote `/mcp` all run this one pipeline. Keys on key day: `OPENAI_API_KEY`, `E2B_API_KEY`.

## 1. Removal map and keep list

### 1.1 Removed (path, why it existed, what replaces its function)

| Path | Why it existed / invariant it protected | 2.0 replacement |
|---|---|---|
| `supabase/functions/scan/` (1990 lines) | The fast path: GitHub/npm resolve, regex static scan, Vertex read, deterministic score, persist, NDJSON stages, CLI/MCP login gate, burst rate limit | `lib/engine/*` called from `app/api/scan/route.ts` (Node runtime on Vercel). Login gate, rate limit, persistence, NDJSON stream all move with it |
| `supabase/functions/_shared/vertex.ts`, `deep-read.ts` | Gemini via Vertex REST with SA JWT; Conversational Agents backend switch | `lib/engine/model/openai.ts` (one adapter, Responses API, strict json_schema) |
| `supabase/functions/_shared/scoring.ts` | The one place the number is decided; code vs reputation groups; verdict from score only | `lib/engine/score.ts` (section 5). Same invariant, new formula with behaviour group |
| `supabase/functions/_shared/static-scan.ts` | Regex heuristics: obfuscation, credential paths, install-time network, typosquat | Ported to `lib/engine/static/heuristics.ts`, now filtered by reachability |
| `supabase/functions/_shared/github.ts`, `npm.ts` | Repo/package resolution, npm `dist.integrity` verification, tarball-vs-repo divergence, owner reputation | `lib/engine/resolve/github.ts`, `lib/engine/resolve/npm.ts`, `lib/engine/reputation.ts` |
| `supabase/functions/_shared/host-verify.ts` | Live-verified captured hosts to downgrade build-phase fetches. Source of moat bypass #4 (a live C2 scored clean) | Removed with no replacement. 2.0 never live-verifies a captured host. Classification uses phase + a fixed distribution-host list + canary content (section 5) |
| `supabase/functions/_shared/rate-limit.ts` | Burst/velocity floor, IP + device buckets, global anon breaker (anti-abuse, never a daily cap) | `lib/engine/ratelimit.ts` calling the kept RPC `check_scan_rate_limit`; IP from Vercel headers |
| `supabase/functions/_shared/run-timeline.ts`, `summary.ts`, `cors.ts` | Stage timeline; summary always agrees with verdict; CORS | `lib/engine/events.ts`; writer validator in `lib/engine/model/writer.ts`; route headers |
| `supabase/functions/attach-forensics/` | Runner-key-gated endpoint the Cloud Run job POSTed forensics to | Removed. The orchestrator reads forensics from the VM as root through the E2B SDK in the same request. No runner key exists, so the forge control-plane auth class (#2/#3) is gone |
| `supabase/functions/deep-queue/`, `lib/deep-queue.ts`, `lib/deep-queue-client.ts`, tables `deep_scan_queue`, `deep_dispatch_lock` | Serialized deep runs through one shared gateway VM; deduped dispatch per commit so repeat calls could not multiply Cloud Run runs | Per-scan sandbox, no shared gateway. Dedup per (subject, SHA) by a partial unique index on `scan_runs` where `status='running'`: a second request attaches to the running stream. Capacity: E2B concurrency error becomes a 503 with `retry_after` and an event |
| `supabase/functions/billing-guard/` | GCP budget push kill switch for Vertex spend | Daily spend floor: table `scan_budget` + RPC `scan_budget_charge`; caps `CR_DAILY_SANDBOX_SECONDS_CAP`, `CR_DAILY_MODEL_TOKENS_CAP`. Over cap: cached reports still serve, fresh scans return 503 with an event |
| `supabase/functions/oauth-token/` | OAuth token endpoint for remote `/mcp` (code exchange to `cr_cli_` token) | `app/oauth/token/route.ts` on Vercel with the same table access the edge function has today (reads/consumes `oauth_codes`, inserts into `cli_tokens`, PKCE check ported); `.well-known/oauth-authorization-server` `token_endpoint` repointed. `issue_cli_token`, `create_oauth_code`, `register_oauth_client` RPCs unchanged |
| `app/api/deep/route.ts`, `lib/cloud-run-dispatch.ts`, `lib/git-bash-path.ts` | Dispatch Cloud Run `cr-detonation` executions (SA JSON in Vercel env) or `gcloud` locally | `lib/engine/sandbox/e2b.ts` |
| `sandbox/cloudrun/`, `sandbox/microvm/`, `sandbox/harness/`, `sandbox/net/`, `sandbox/agent/`, `sandbox/analysis/`, `sandbox/golden-image/`, `sandbox/orchestrate.sh`, `sandbox/run-deep-queue.sh`, `sandbox/verdict.py`, `sandbox/test_verdict.py`, `sandbox/AGENTIC-DESIGN.md`, `sandbox/README.md` | Cloud Run harness, NVA forge gateway (mitmproxy addon, dnsmasq, forensics API), older microVM generation, in-sandbox agent loop | `sandbox/e2b/` (template, guest harness, forge addon, rules). The forge logic is ported, not dropped |
| GCP: `cr-detonation` job, `cr-forge-gateway` VM, VPC, Secret Manager secrets, Vertex | Substrate + model | E2B + OpenAI. Decommission is a key-day owner action after cutover (production) |
| `deno.json`, `deno.lock`, `supabase/functions/**/deno.json`, scripts `test:functions`, `check:functions` | Deno toolchain for edge functions | None. All server code is Node/TypeScript under `npm test` |
| `scripts/apply-migration.mjs` | Applied SQL to the production project ref by Management API | `scripts/db-branch-apply.mjs`: requires a branch project ref argument and refuses `mjvlczaytkhvsolnhhkz` |
| table `scan_usage`, RPC `check_and_increment_scan_limit` | Daily quota, already dead (zero callers, koenigsegg 05 D5/D6) | Removed with a down migration |
| Tests `tests/cloud-run-dispatch.test.ts`, `tests/deep-queue.test.ts`, `tests/deep-git-bash-path.test.ts`, `tests/deep-scan-availability.test.ts`, all `supabase/functions/**/*.test.ts` | Covered removed code | Replaced by `tests/engine/**` |
| Operator env `CR_PROBE_KEY`, `CR_FORCE_DEEP_TARGETS` | Probe/regenerate runs; force the deep path | `CR_OPERATOR_KEY` (regenerate + operator tarball target). Forcing is meaningless: every scan runs the code |

### 1.2 Kept (invariant and where it lives in 2.0)

| Invariant | 2.0 location |
|---|---|
| Forge: every outbound call from repo code is answered by us and recorded | `sandbox/e2b/guest/forge_addon.py` + `forge_core.py` as root in the VM, nftables redirect for uid 1001, E2B outer fence (section 3) |
| Reset per scan | One fresh E2B sandbox from the template per scan, killed in `finally`; analysis sandbox likewise. Nothing persists between scans |
| Never a bare "Safe" | `lib/engine/score.ts` verdict words + non-empty `not_verified`; writer validator; CLI/MCP formatters print verdict + `not_verified` |
| Reputation separate from code/behaviour | Score groups `behaviour`, `intel`, `static`, `docs`, `reputation`; report sections tagged by group |
| Auth for CLI/MCP (`cr_cli_` tokens, RPC `verify_cli_token`) | `lib/engine/auth.ts`; CLI/stdio MCP send `x-clauderabbit-client` + Bearer to `/api/scan` |
| OAuth for remote `/mcp` (tables `oauth_clients`, `oauth_codes`, RPCs `register_oauth_client`, `create_oauth_code`, `cleanup_oauth`) | Unchanged SQL; token endpoint moves to `app/oauth/token/route.ts`; `app/mcp/route.ts` calls the engine in-process |
| Report pages `/owner/repo`, `/npm/<pkg>`, badges, leaderboard views | Unchanged readers of `reports`; the engine writes a compatible `reports` row (section 7.3) |
| Rate-limit floor (anti-abuse, never a daily cap) | RPC `check_scan_rate_limit` (kept) via `lib/engine/ratelimit.ts` |
| Web scanning needs no login | `/api/scan` without the client header stays anonymous |
| Secrets server-side only | All keys are Vercel server env; the browser holds only `NEXT_PUBLIC_*` |

## 2. Architecture and time budget

### 2.1 Placement

- Vercel function `app/api/scan/route.ts`, `runtime = "nodejs"`, `maxDuration = 120`. Runs: input validation, auth,
  rate limit, budget, cache, resolve, tarball fetch and verification, in-memory untar, reachability graph,
  in-process heuristics, OSV, reputation, three Luna readers, orchestration of both sandboxes, forensic parsing,
  score, Luna report writer, persistence, event fan-out.
- E2B detonation sandbox (template `CR_E2B_TEMPLATE`): forge, harness, install, entry point, forensics capture.
- E2B analysis sandbox (same template, `allowInternetAccess: false`): Semgrep, YARA, GuardDog on the extracted tree.
  Justification for a separate sandbox: scanners must read the bytes before any repo code can rewrite them, and
  the analysis VM never runs repo code, so its results cannot be tampered with by the detonation.
- Untrusted bytes exist only in Vercel memory and inside E2B VMs. Never on a developer machine. Tests run only
  our own fixture.

### 2.2 Stage order and budget (target about 8 s wall on a small package with a warm mirror)

| t (ms) | Stage | Budget | Hard deadline |
|---|---|---|---|
| 0 | parse, auth, rate limit, budget, cache lookup | 200 | 1500 |
| 200 | resolve SHA / version (GitHub API or npm packument) | 300 | 4000 |
| 500 | tarball fetch + verify + untar in memory (cap 25 MB compressed, 120 MB / 20000 files expanded) | 500 | 8000 |
| 1000 | parallel fan-out begins: | | |
| | (a1) analysis sandbox create + upload + scanners | 4500 | 15000 |
| | (a2) OSV querybatch on lockfile deps; heuristics | 400 | 5000 |
| | (b) reachability graph | 50 | 1000 |
| | (c) readers: install + docs start at t=1050; flagged reader starts when a1 returns | 2500 each | 12000 each |
| | (d) detonation: create 600, upload 200, forge-up 1200, install 3000, entry 3000 (fake clock x30), collect 300 | 8300 | install 20000, entry 4000, total 30000 |
| ~7000 | OSV pass 2 on the installed tree (from `npm ls --all --json` / `uv pip list --format json`) | 300 | 4000 |
| ~7300 | score | 5 | 100 |
| ~7300 | writer (Luna) | 1500 | 10000 |
| ~8800 | persist report, close stream | 200 | 3000 |

Global scan deadline 75 s; any stage past its deadline emits `stage{status:"error"}` and a `check`, and the
score applies the corresponding cap (section 5.4). Sandboxes are created with `timeoutMs = 90000` so E2B
reaps them even if the function dies.

## 3. Detonation design

### 3.1 Template (pinned definition in repo)

`sandbox/e2b/template.ts` (E2B Template builder v2, SDK `e2b@2.56.0`), built by `sandbox/e2b/build.ts` with
`Template.build(template, "clauderabbit-detonate", { cpuCount: 2, memoryMB: 4096 })` on key day.

- Base: `fromUbuntuImage("24.04")`.
- apt (versions recorded at build into `/opt/cr/manifest.json`): `ca-certificates nftables strace libfaketime
  python3 python3-venv openssl git build-essential util-linux procps jq`.
- Node 24 LTS from the official `node-v24.x-linux-x64.tar.xz` with sha256 checked against `SHASUMS256.txt`;
  npm pinned in the same tarball. uv pinned `0.13.1` via its release tarball + sha256.
- Python tools via `uv tool install` with pinned versions: `mitmproxy==12.2.3` (needs Python >=3.12, Ubuntu
  24.04 ships 3.12), `semgrep==1.181.0`, `guarddog==3.2.0`, `yara-x==1.21.0` (Python module used by
  `cr-yara.py`).
- Users: `cr` uid 1001 gid 1001, no sudo, no shell login, home `/home/cr`. Build asserts `sudo -l -U cr` grants
  nothing. E2B's default user is not used for repo code.
- Files: `/opt/cr/bin/cr-detonate.sh`, `/opt/cr/bin/cr-analyze.sh`, `/opt/cr/bin/cr-yara.py`,
  `/opt/cr/forge/forge_addon.py`, `/opt/cr/forge/forge_core.py`, `/opt/cr/forge/policy.json`,
  `/opt/cr/rules/semgrep/*.yaml`, `/opt/cr/rules/yara/*.yar`. All root-owned, mode 0755/0644.
- Mirror (package cache, never trusted): `/opt/cr/mirror/` root-owned mode 0700, warmed at build time by the
  forge fetching the top N npm packuments + tarballs and PyPI wheels listed in `sandbox/e2b/mirror-seed.json`,
  stored content-addressed by sha512 (npm) / sha256 (PyPI).
- Build-time smoke checks (`runCmd`, build fails on any failure): forge redirects a uid-1001 `curl
  http://example.invalid/` to a forged body; a uid-1001 connect to `127.0.0.1:49983` (envd) is refused;
  `FAKETIME="+0 x30"` makes `node -e "setTimeout(()=>{},30000)"` finish in under 3 s real and `Date.now()`
  advance about 30 s; a dependency postinstall in a local test package runs under
  `npm_config_dangerously_allow_all_scripts=true`.

### 3.2 Sandbox creation (per scan, `lib/engine/sandbox/e2b.ts`)

```ts
Sandbox.create(config.e2bTemplate, {
  timeoutMs: 90_000,
  metadata: { runId, purpose: "detonate" },
  allowInternetAccess: true,
  network: { denyOut: ["0.0.0.0/0"], allowOut: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"] },
})
```
Outer fence (E2B host level): only the three registry hostnames on 443 (SNI) / 80 (Host), plus DNS to 8.8.8.8
which E2B allows automatically when domains are used. Analysis sandbox: `allowInternetAccess: false`.
All harness commands run with `commands.run(cmd, { user: "root", timeoutMs })`. `CommandExitError` is caught and
mapped to `{ exitCode, stdout, stderr }`. `kill()` runs in `finally` and emits `check{name:"sandbox_killed"}`.

### 3.3 Inner fence and forge (inside the VM, root)

Order inside `cr-detonate.sh`, run as root, `set -euo pipefail`:
1. CA per VM: `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 60` into
   `/root/.cr/ca` (0700); write mitmproxy confdir `mitmproxy-ca.pem`; append the cert to
   `/etc/ssl/certs/ca-certificates.crt` and write `/etc/cr/ca.pem`.
2. nftables (the E2B kernel lacks `xt_owner`, so iptables `--uid-owner` exits 4; nftables `meta skuid` is used):
   ```
   table inet cr {
     chain out_nat { type nat hook output priority -100;
       meta skuid 1001 udp dport 53 redirect to :5353
       meta skuid 1001 tcp dport 53 redirect to :5353
       meta skuid 1001 ip daddr != 127.0.0.0/8 meta l4proto tcp redirect to :8080 }
     chain out_filter { type filter hook output priority 0; policy accept;
       meta skuid 1001 ip daddr 127.0.0.0/8 tcp dport { 49983, 8081 } reject
       meta skuid 1001 ip daddr 127.0.0.0/8 accept
       meta skuid 1001 tcp dport 8080 accept
       meta skuid 1001 udp dport 5353 accept
       meta skuid 1001 ip6 daddr != ::1 drop
       meta skuid 1001 meta l4proto != tcp drop } }
   ```
   uid 1001 keeps loopback for its own servers, never reaches envd (49983). IPv6 and non-TCP egress is dropped.
   The harness verifies by probe (`check{name:"egress_contained"}`) before any repo code runs.
3. Forge: `mitmdump --mode transparent@8080 --mode dns@5353 --set confdir=/root/.cr/mitm -s
   /opt/cr/forge/forge_addon.py` as root. Root traffic is not redirected, so the forge reaches upstream only
   through the outer fence.
4. Forge policy (`forge_core.py`, pure stdlib, unit-tested locally; `forge_addon.py` is thin mitmproxy glue):
   - Registry request (host in `policy.json.registries` and method GET and path matches the packument/tarball/
     simple-index/files shape): served from `/opt/cr/mirror` when present, otherwise fetched upstream by the
     forge and stored. Tarballs are verified before serving: npm sha512 against `dist.integrity` from the
     packument the forge itself fetched; PyPI sha256 against the digest in the JSON API / simple index. Mismatch:
     HTTP 502 + capture record `mirror_integrity_mismatch`. npm then also checks lockfile `integrity`. Non-GET
     or off-shape registry requests are forged like any other host.
   - Everything else: forged and captured. Response body chosen by consumer shape (shell no-op for curl/wget/
     `.sh`, PowerShell no-op, JSON `{"ok":true}` default), same rules as the pre-2.0 `_forged_body`. TLS is
     intercepted with the per-VM CA; a client that refuses it (pinning, mTLS) is recorded as `tls:"refused"`.
   - DNS: every query from uid 1001 answered with an address that routes into the forge, query name captured.
   - Capture: JSONL `/root/out/capture.jsonl`, one record per request/DNS query/TLS failure: `{t, phase, proto,
     host, port, method, path, sni, req_headers, req_body_b64 (<=64 KiB), forged_kind, tls}`.
5. Decoys and canaries: decoy files with unique per-run canary strings at `/home/cr/.ssh/id_rsa`,
   `/home/cr/.aws/credentials`, `/home/cr/.npmrc`, `/home/cr/.config/gh/hosts.yml`, `/home/cr/.docker/config.json`,
   `/home/cr/.git-credentials`; canary env vars `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`,
   `GITHUB_TOKEN`, `OPENAI_API_KEY` set only in the uid-1001 environment with canary values. Canary values are
   generated in Vercel per run and passed in a root-only file; the orchestrator searches the capture for them.
6. Extract tarball (written by the orchestrator to `/root/in/target.tgz`) into `/work` owned `cr:cr`.
7. Phase marker `install` written by root to `/root/out/phase` with a monotonic timestamp; forge reads it for
   each record's `phase`.
8. Install as uid 1001 under trace and fake clock:
   `strace -f --seccomp-bpf -qq -ttt -s 256 -e trace=execve,openat,unlinkat,renameat2,connect,chmod -o
   /root/out/trace.install -u cr -- env -i <allowlisted env> <install cmd>`
   - env: `HOME=/home/cr PATH=... LD_PRELOAD=<libfaketimeMT.so.1> FAKETIME="+0 x30" FAKETIME_DONT_RESET=1
     NODE_EXTRA_CA_CERTS=/etc/cr/ca.pem SSL_CERT_FILE=/etc/cr/ca.pem REQUESTS_CA_BUNDLE=/etc/cr/ca.pem
     npm_config_dangerously_allow_all_scripts=true npm_config_ignore_scripts=false npm_config_fetch_timeout=3600000
     npm_config_audit=false npm_config_fund=false UV_CACHE_DIR=/home/cr/.cache/uv UV_PYTHON_DOWNLOADS=never`
     plus the canary env vars. npm 11 blocks dependency install scripts unless allowed, so the
     `dangerously_allow_all_scripts` flag is mandatory for "every dep and every script".
   - npm GitHub repo: `npm ci` when `package-lock.json` exists, else `npm install`. npm package target: create
     `/work/app/package.json` and run `npm install /work/pkg.tgz` there so the package's own lifecycle hooks
     and every dependency's hooks run as a consumer would see them. yarn/pnpm lockfiles: `npm install` (records
     `check{name:"lockfile_translated"}`).
   - Python: `uv venv /work/.venv`; then `uv sync --frozen` with `uv.lock`, else `uv pip install --python
     /work/.venv/bin/python -r requirements.txt` and/or `uv pip install --python ... .` (runs the build backend /
     `setup.py`). `*.pth` files installed into site-packages are recorded (they execute at interpreter start).
9. Phase marker `entry`. Entry point as uid 1001 with the same env, `timeout 4`: npm: first `bin` with `--help`,
   then `node -e "require('<name>')"` (CJS) or `node --input-type=module -e "await import('<name>')"` (ESM);
   Python: `python -c "import <top_level>"` for each top-level package, then the first console script with
   `--help`. GitHub repo with neither: `npm start`/`python -m <pkg>` when declared, else entry skipped with a check.
10. Collect as root: `npm ls --all --json` or `uv pip list --format json` into `/root/out/deps.json`; writes
    outside `/work`, `/home/cr/.npm`, `/home/cr/.cache`, `/tmp` from the trace; `/root/out/` tarred to
    `/root/out.tgz` (cap 25 MB). The orchestrator reads it with `files.read(path, { user: "root", format: "bytes" })`.
11. Orchestrator `kill()` in `finally`.

### 3.4 Forensics captured (parsed in Vercel, `lib/engine/forensics/*.ts`)

- `process`: every `execve` (pid, ppid, argv truncated to 512 chars, phase).
- `file`: `openat` with write flags or `O_CREAT`, `unlinkat`, `renameat2`, `chmod` outside the install tree;
  any `openat` of a decoy path (`op:"read_decoy"`).
- `forged_call`: every capture record, with `canary_hits` computed in Vercel.
- DNS: capture records with `proto:"dns"`.
- Env reads: direct `getenv` tracing is not available for code that reads `environ` directly, so env reads are
  measured by canary propagation (a canary value found in a request, DNS name or written file).
- Clock check: the harness records real vs faked elapsed for the entry window (`check{name:"clock_accelerated"}`).

## 4. Module layout and interfaces

```
lib/engine/
  config.ts            env parsing; MODEL_ID default "gpt-6-luna" (override CR_MODEL_ID); template name; caps
  types.ts             ScanTarget, ScanRequest, ScanOutcome, ScanEvent, Finding, ReportPayload
  orchestrator.ts      runScan()
  deps.ts              productionDeps(): OpenAIAdapter + E2BProvider + SupabaseStore/Sink
  events.ts            EventSink, fan-out, NDJSON encoder, truncation rules
  archive.ts           gunzip + tar (pax/ustar) parse in memory, limits, path normalization
  resolve/github.ts    ref -> SHA, codeload tarball, pax comment == SHA check
  resolve/npm.ts       packument, version/tag, tarball, sha512 SRI check
  resolve/tarball.ts   operator target (url + sha512), CR_OPERATOR_KEY only
  reach/graph.ts       reachability graph (section 5.2)
  static/heuristics.ts ported regex heuristics
  static/osv.ts        querybatch client + MAL- classification
  static/scanners.ts   parse Semgrep JSON, GuardDog JSON, cr-yara JSON
  reputation.ts        GitHub owner + npm signals, owners cache
  model/adapter.ts     ModelAdapter interface
  model/openai.ts      OpenAIAdapter
  model/readers.ts     install, flagged, docs readers (zod schemas + prompts)
  model/writer.ts      report writer + validator
  sandbox/provider.ts  SandboxProvider, SandboxSession
  sandbox/e2b.ts       E2BProvider
  sandbox/detonate.ts  drives cr-detonate.sh, returns raw forensics bundle
  sandbox/analyze.ts   drives cr-analyze.sh
  forensics/strace.ts  strace -ff parser
  forensics/capture.ts capture.jsonl parser + canary search
  score.ts             deterministic score (section 5)
  ads.ts               ad payloads (section 8.3)
  store.ts             ScanStore interface + SupabaseStore (runs, events, reports, budget, dedup)
  ratelimit.ts         check_scan_rate_limit RPC wrapper, client IP from Vercel headers
  auth.ts              cr_cli_ token (verify_cli_token) and Supabase JWT verification
sandbox/e2b/ template.ts build.ts mirror-seed.json guest/{cr-detonate.sh,cr-analyze.sh,cr-yara.py,
             forge_addon.py,forge_core.py,policy.json,test_forge_core.py} rules/{semgrep,yara}
app/api/scan/route.ts             POST scan (NDJSON)
app/api/runs/[runId]/events/route.ts  GET replay
app/api/scan/replay/route.ts      GET replay by subject + sha
app/oauth/token/route.ts          OAuth token endpoint
tests/engine/**                   unit tests; tests/e2e/keyless-scan.test.ts
tests/support/stand-in-model.ts   test-only ModelAdapter
tests/support/mock-sandbox.ts     test-only SandboxProvider
tests/support/test-forge.ts       test-only forge honoring policy.json and the capture format
tests/fixtures/phone-home/        our fixture package
tests/labeled/set.json            labeled set
```
Test stand-ins live only under `tests/`. `lib/engine/deps.ts` imports only production implementations.

```ts
// model/adapter.ts
export type ModelTask = "reader.install" | "reader.flagged" | "reader.docs" | "writer";
export interface ModelAdapter {
  readonly modelId: string;
  structured<T>(req: { task: ModelTask; system: string; input: string; schema: z.ZodType<T>;
    schemaName: string; maxOutputTokens: number; signal: AbortSignal }):
    Promise<{ value: T; usage: { inputTokens: number; outputTokens: number }; rawText: string }>;
}
// OpenAIAdapter: client.responses.parse({ model, input: [{role:"system",content},{role:"user",content}],
//   text: { format: zodTextFormat(schema, schemaName) }, reasoning: { effort: config.reasoningEffort },
//   max_output_tokens, store: false }, { signal }). zodTextFormat sets strict json_schema.

// sandbox/provider.ts
export interface SandboxProvider {
  create(opts: { purpose: "detonate" | "analyze"; runId: string; timeoutMs: number;
    network: "registry-only" | "none" }): Promise<SandboxSession>;
}
export interface SandboxSession {
  readonly id: string;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;          // as root
  run(cmd: string, opts: { timeoutMs: number; onStdout?: (s: string) => void;
    onStderr?: (s: string) => void }): Promise<{ exitCode: number; stdout: string; stderr: string }>; // as root
  readFile(path: string): Promise<Uint8Array>;                               // as root
  kill(): Promise<void>;
}

// events.ts
export interface EventSink { emit(e: Omit<ScanEvent, "seq" | "t_ms" | "run_id">): void; flush(): Promise<void>; }

// orchestrator.ts
export async function runScan(req: ScanRequest, deps: EngineDeps,
  opts: { signal?: AbortSignal; onEvent?: (e: ScanEvent) => void }): Promise<ScanOutcome>;
export interface EngineDeps { model: ModelAdapter; sandbox: SandboxProvider; store: ScanStore;
  fetch: typeof fetch; now: () => number; config: EngineConfig; }
export type ScanOutcome =
  | { kind: "cached" | "fresh"; runId: string; report: ReportPayload }
  | { kind: "attached"; runId: string }
  | { kind: "error"; runId: string | null; code: ErrorCode; message: string };
```

## 5. Deterministic score

### 5.1 Inputs

`behaviour` (detonation), `intel` (OSV), `static` (heuristics, Semgrep, YARA, GuardDog, reader findings),
`docs` (doc-versus-code), `reputation`. Model output never sets the number; it only contributes bounded,
reachability-filtered findings.

### 5.2 Reachability

Entries, install surface: npm `preinstall`, `install`, `postinstall`, `prepare` scripts (files they name:
`node x`, `sh x`, `bash x`, `python x`), `binding.gyp` (node-gyp on install). Python: `setup.py`, in-tree build
backend (`backend-path`), `*.pth`. Import surface: npm `main`, `module`, every `exports` target, `bin`, default
`index.js`; Python top-level package `__init__.py` and console-script modules. Edges: string-literal `require`,
`import`, `import()`, `export from`; Python `import x`, `from . import`. Resolution inside the tarball only.
A non-literal `require`/`import` in a reachable file marks the reachable set `unbounded`: every file except
tests/docs/examples paths counts as reachable. Files never reached (tests/, `__tests__`, spec/, docs/, examples/,
benchmark/, fixtures/, .github/, Dockerfile, terraform/, k8s/, *.md) contribute 0 points; their findings are
listed as informational.

### 5.3 Formula (all weights in `score.ts`, each documented there)

```
score = clamp(85 + B + I + max(S, -40) + D + R, 0, 100), then caps (5.4)
B behaviour (cap -85):
  canary value seen in any forged request, DNS name, or written file ....... -70
  decoy credential file opened by repo process ............................. -35
  persistence write (~/.bashrc, ~/.profile, crontab, systemd user unit,
    ~/.ssh/authorized_keys, shell rc, /etc attempt) ......................... -35
  DNS query with tunneling shape (label entropy > 3.5 bits/char and len > 40) -30
  contact to a non-distribution host (per distinct host, cap -45) .......... -25
  TLS interception refused (pinned or mTLS client) ........................ -20
  install hook exec of curl|wget|nc|bash -c|powershell|base64 -d (cap -30) . -15
  install-phase fetch to a distribution host (github.com,
    objects.githubusercontent.com, sourceforge.net, nodejs.org; cap -9) .... -3
I intel: any installed or locked dependency with an OSV MAL- id ............ -60
S static (reachable files only; dedup by file:line; floor -40):
  high finding -12, medium -5 (Semgrep/YARA/GuardDog/heuristics);
  reader finding with verdict malicious/suspicious: high -8, medium -4
D docs: declared "no network"/"pure" contradicted by observed behaviour ..... -15
        contradicted only by reachable static capability ................... -6
R reputation (bounded [-8, +5]): owner < 60 d -5; npm first publish < 30 d -4;
  maintainer set changed < 30 d -3; established owner +3; npm downloads > 100k/wk +2;
  GitHub repo target with stargazers_count >= 1000 +2 (from the resolver's repo metadata)
```
Behaviour outweighs static: B reaches -85, S stops at -40, and a single canary hit alone lands under 30.

### 5.4 Caps (never confident without evidence)

- Any canary hit or persistence write: score <= 15.
- Any MAL- dependency: score <= 25.
- Install did not complete (timeout, failure, archive truncated): score <= 74.
- Install completed, entry phase failed or skipped: score <= 89.
- Score >= 90 requires: install and entry completed, B == 0, I == 0, no reachable high static finding, R >= 0.

### 5.5 Verdict words and the rail

`>= 90 "No threats observed"`, `80-89 "Low risk"`, `60-79 "Caution"`, `30-59 "High risk"`, `< 30 "Malicious"`.
Bands match `lib/score.ts` (90/80/60). The word "Safe" is never a verdict. Every report carries a non-empty
`not_verified` list, always including: behaviour outside the observed install and entry windows; code paths
not triggered by install or the entry point; payloads gated on calendar dates or on hosts that require real
responses; and, when present, each failed phase. The writer validator rejects output containing the token
"safe" as a standalone claim, any banned word from the owner brief, or a summary whose band disagrees with the
score; one retry, then a deterministic summary built from the breakdown (`writer:"deterministic"` recorded).

## 6. Event schema and replay

```ts
type ScanEvent = { run_id: string; seq: number; t_ms: number } & (
 | { type: "stage"; data: { name: StageName; status: "start" | "done" | "error" | "skipped"; detail?: string } }
 | { type: "timing"; data: { name: string; ms: number } }
 | { type: "transcript"; data: { source: "install" | "entry" | "semgrep" | "guarddog" | "yara" |
     "reader.install" | "reader.flagged" | "reader.docs" | "writer"; stream: "stdout" | "stderr" | "model";
     text: string } }                                   // text <= 4 KiB per event
 | { type: "forged_call"; data: { phase: "install" | "entry"; proto: "http" | "https" | "dns" | "tcp";
     host: string; port: number; method?: string; path?: string; sni?: string; req_bytes: number;
     forged_kind: string; tls?: "intercepted" | "refused"; canary_hits: string[] } }
 | { type: "file"; data: { phase: Phase; op: "write" | "create" | "unlink" | "rename" | "chmod" | "read_decoy";
     path: string; pid: number } }
 | { type: "process"; data: { phase: Phase; pid: number; ppid: number; argv: string[] } }
 | { type: "check"; data: { name: string; ok: boolean; detail?: string } } )
StageName = "cache" | "resolve" | "fetch" | "verify" | "reach" | "static" | "osv" | "readers" |
  "detonate" | "score" | "report" | "persist"
```
Rules: `seq` strictly increasing per run; max 600 persisted events per run (overflow becomes one
`check{name:"events_truncated"}` with counts); transcripts chunked. Emission: in-memory fan-out to the NDJSON
response immediately; batched insert into `scan_events` every 250 ms; a trigger broadcasts each inserted row on
Realtime topic `scan:<run_id>` (public channel, event name = `type`). Replay: `GET /api/runs/<runId>/events`
(ordered by seq) and `GET /api/scan/replay?target=<github:owner/repo|npm:name>&sha=<sha or version>` which
resolves the latest `done` run for that SHA. A cache hit streams the stored events of that run with
`replayed:true` before the result line.

## 7. Supabase schema

### 7.1 Migrations (each up file in `supabase/migrations/`, each down file at
`supabase/migrations-down/<same name>.down.sql`; down files live outside `migrations/` so the CLI never applies them)

1. `20261016000001_scan_runs_events.sql`: table `scan_runs(id uuid pk default gen_random_uuid(), target_kind
   text check in ('github','npm','tarball'), subject text not null, commit_sha text not null, status text check
   in ('running','done','error') default 'running', error_code text, started_at timestamptz default now(),
   finished_at timestamptz, timings jsonb, report_id bigint references reports(id) on delete set null,
   model_id text, template text)`; partial unique index `(subject, commit_sha) where status='running'`;
   index `(subject, commit_sha, finished_at desc) where status='done'`. Table `scan_events(run_id uuid references
   scan_runs(id) on delete cascade, seq int, t_ms int, type text check in (...7 types), data jsonb, primary key
   (run_id, seq))`. Trigger `scan_events_broadcast` after insert for each row: `perform realtime.send(
   jsonb_build_object('seq',new.seq,'t_ms',new.t_ms,'data',new.data), new.type, 'scan:'||new.run_id::text,
   false)`. RLS: public select on both, service role all. Function `expire_stale_runs()` marks `running` rows
   older than 5 min as `error` (`error_code='stale'`), called by the orchestrator before the dedup insert.
2. `20261016000002_reports_run_path.sql`: `reports.scan_path` and `scans.scan_path` checks gain `'run'`; add
   `reports.run_id uuid`, `reports.score_breakdown jsonb`, `reports.not_verified jsonb`.
3. `20261016000003_scan_budget.sql`: `scan_budget(day date pk, sandbox_seconds bigint, model_tokens bigint)`,
   RPC `scan_budget_charge(p_sandbox_seconds int, p_tokens int, p_cap_seconds int, p_cap_tokens int) returns
   boolean` (security definer, service role only). RLS service only.
4. `20261016000004_drop_deep_queue.sql`: drop `deep_scan_queue`, `deep_dispatch_lock` and their RPCs
   (`deep_queue_*`, `deep_dispatch_try_claim`, `deep_dispatch_release`). Down recreates them from the original
   DDL of `20260702000002`, `20260703000001`, `20260711000001`.
5. `20261016000005_drop_dead_quota.sql`: drop `check_and_increment_scan_limit` and `scan_usage`. Down recreates
   both from `20260625000001`.

### 7.2 Where they run

Only on a Supabase branch of project `mjvlczaytkhvsolnhhkz`, never on production. Each up then down then up is
run on the branch and the outputs recorded. Local syntax tests: PGlite (`@electric-sql/pglite`, devDependency)
with a prelude that creates stub `auth.users` and `realtime.send` so up/down round-trips run in `npm test`.

### 7.3 Report compatibility

The engine writes a `reports` row the existing pages read: `owner_login`/`repo_name` (`"npm"` + package name
for npm), `commit_sha` (git SHA; for npm `<version>+<sha512 integrity>`), `score`, `verdict`, `summary`,
`scan_path='run'`, `deep=true`, `cached=false`, `confidence`, `stats_json`, `packages_json` (deps + OSV),
`risky_json` (findings tagged `behavior`/`code`/`rep`), `logs_json` (stage chapters), `forensics_json`
(`{version:2, ...}`), plus `run_id`, `score_breakdown`, `not_verified`. Upsert on `uq_reports_owner_repo_sha`.

## 8. API contract

### 8.1 Web API

`POST /api/scan` body `{ target: "owner/repo" | "github:owner/repo" | "npm:name[@version]" | url, ref?, deviceId? }`
or the structured form `{ ecosystem: "github", owner, repo, ref? } | { ecosystem: "npm", package, version? }`.
Response `application/x-ndjson`: event lines `{"type":"event","event":ScanEvent}` and one final line
`{"type":"result","outcome":"cached"|"fresh","run_id","report":ReportPayload,"ad":Ad}` or
`{"type":"error","code","message","run_id","ad":Ad}`. Pre-stream errors return JSON with the same `error` shape,
status 400/401/429/503, and `ad`. Operator headers: `x-cr-operator-key` (+ `x-cr-regenerate: 1`).

`ReportPayload = { run_id, target, commit_sha, score, verdict, band, summary, headline, evidence: { behaviour[],
code[], reputation[] }, breakdown: ScoreDelta[], not_verified: string[], forensics, packages, model_id,
template, timings }`.

### 8.2 CLI, stdio MCP, remote MCP

- CLI (`clauderabbit scan`) and stdio MCP (`mcp-server`) POST to `${CLAUDE_RABBIT_SITE_URL}/api/scan` with
  `Authorization: Bearer cr_cli_...` and `x-clauderabbit-client: cli|mcp`; missing/invalid token returns 401
  with `signInUrl`. They render stage lines from events, then verdict, score, `not_verified`, report URL, ad.
- Remote `/mcp` calls `runScan` in-process with `caller.surface="mcp-remote"` after OAuth bearer verification.
  Tool `scan` returns text content with verdict, score, `not_verified`, report URL, ad text.

### 8.3 Ad payload (every response)

```ts
type Ad =
  | { kind: "adsense"; placement: "scan_result"; client: string; slot: string; format: "auto"; adtest: "on" | "off" }
  | { kind: "house"; placement: "scan_result"; id: string; label: "Sponsored"; headline: string; body: string; url: string };
```
Web gets `adsense` when `NEXT_PUBLIC_ADSENSE_CLIENT_ID` and `NEXT_PUBLIC_ADSENSE_SLOT_ID` are set, else `house`.
The page renders `<ins class="adsbygoogle" style="display:block" data-ad-client data-ad-slot
data-ad-format="auto" data-adtest="on">` and the `adsbygoogle.js?client=` script, `crossorigin="anonymous"`,
then `(adsbygoogle = window.adsbygoogle || []).push({})`. `adtest` is `"on"` unless
`NEXT_PUBLIC_ADSENSE_TEST=off`. CLI and MCP get `house`: ClaudeRabbit's own badge offer for the scanned target
(`<site>/badge/...`), defined in `lib/engine/ads.ts`. Ads never gate a scan or a result.

## 9. Environment variables (exact names)

| Name | Where | Required | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | Vercel server | key day | OpenAI Responses API |
| `E2B_API_KEY` | Vercel server + template build shell | key day | E2B sandboxes and template build |
| `CR_MODEL_ID` | Vercel server | no (default `gpt-6-luna` in `lib/engine/config.ts`) | model id override |
| `CR_MODEL_REASONING_EFFORT` | Vercel server | no (default `low`) | `none|low|medium|high` |
| `CR_E2B_TEMPLATE` | Vercel server | no (default `clauderabbit-detonate`) | template name |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | yes | Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | client + server | yes | publishable key |
| `SUPABASE_SECRET_KEY` | Vercel server | yes | `sb_secret_...` for writes; fallback `SUPABASE_SERVICE_ROLE_KEY` |
| `NEXT_PUBLIC_SITE_URL` | client + server | yes | canonical site URL |
| `GITHUB_TOKEN` | Vercel server | no | higher GitHub API limit |
| `NEXT_PUBLIC_ADSENSE_CLIENT_ID` | client + server | no | `ca-pub-...` |
| `NEXT_PUBLIC_ADSENSE_SLOT_ID` | client + server | no | ad slot |
| `NEXT_PUBLIC_ADSENSE_TEST` | client + server | no (default `on`) | `data-adtest` |
| `CR_OPERATOR_KEY` | Vercel server | no (>= 32 chars) | regenerate + operator tarball target |
| `CR_DAILY_SANDBOX_SECONDS_CAP` | Vercel server | no (default 20000) | spend floor |
| `CR_DAILY_MODEL_TOKENS_CAP` | Vercel server | no (default 20000000) | spend floor |
| `CLAUDE_RABBIT_SITE_URL` | CLI / stdio MCP | no (default `https://clauderabbit.in`) | API base |
| `CLAUDE_RABBIT_SCAN_TIMEOUT_MS` | CLI / stdio MCP | no | client timeout |

Removed names: `CR_RUN_SA_JSON`, `CR_RUN_REGION`, `CR_RUN_JOB_NAME`, `CR_RUN_PROJECT`, `CR_DEEP_RUNNER_KEY`,
`CR_ALLOW_LOCAL_DEEP`, `CR_BASH`, `CR_SANDBOX_PATH_PREPEND`, `CLAUDE_RABBIT_DEEP_TIMEOUT_MS`,
`CLAUDE_RABBIT_SUPABASE_URL`, `CLAUDE_RABBIT_SUPABASE_PUBLISHABLE_KEY` (CLI login keeps them only if step 6 finds
`cli/src/lib/auth.ts` needs them), and every edge-function secret (`GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_*`,
`VERTEX_LOCATION`, `GEMINI_*`, `CR_GUARD_*`, `CR_DF_AGENT_ID`, `CR_MODEL_BACKEND`, `CR_COMBINE*`,
`CR_FORCE_DEEP_TARGETS`, `CR_PROBE_KEY`).

## 10. Test plan

- Unit (`tests/engine/*.test.ts`, node:test): archive limits and path traversal rejection; GitHub pax comment
  check against a tarball made by `git archive` of this repo; npm SRI check; reachability on synthetic trees
  (unbounded case, tests/ excluded); OSV parsing with recorded JSON fixtures (MAL- vs GHSA); strace and capture
  parsers on synthetic text; canary search; score table tests for every weight and cap and the rule that an
  unreachable high finding changes nothing; verdict words; writer validator (banned words, bare "Safe", band
  mismatch); ads payload per surface; events seq/truncation; auth and rate-limit wrappers with stub RPC.
- Python: `python3 -m unittest sandbox/e2b/guest/test_forge_core.py` for registry shape matching, integrity
  verification, forged body selection, capture record format (stdlib only).
- Keyless e2e (`tests/e2e/keyless-scan.test.ts`): `runScan` with `StandInModel` (deterministic structured output
  from the input slice, schema-validated with the same zod schemas) and `MockSandboxProvider`. The mock runs our
  fixture `tests/fixtures/phone-home/` (postinstall `node beacon.js` that reads `AWS_SECRET_ACCESS_KEY` and POSTs
  it to `http://c2.cr-fixture.invalid/collect`, then writes the response body to `beacon-result.json`) through
  `tests/support/test-forge.ts`, which honors `policy.json`, forges the response, and writes the same
  `capture.jsonl` format. Assertions: a `forged_call` event for `c2.cr-fixture.invalid` with a canary hit; the
  fixture's own result file holds the forged body; score <= 15 and verdict "Malicious"; a clean fixture
  `tests/fixtures/quiet-lib/` scores >= 80 with verdict not equal to "Safe"; every response has `ad`; events
  cover all seven types.
- Gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `vercel build` then `vercel deploy`
  (preview, never `--prod`).
- Labeled set `tests/labeled/set.json`: `[{ id, kind: "github"|"npm", target, pin: { sha } | { version,
  integrity }, expected: "clean"|"malicious", source }]`. 50 clean (popular GitHub repos and npm packages,
  pinned SHA/integrity) and 20 malicious (npm versions with OSV MAL- ids). Selection checks retrievability with
  metadata only (packument lists the version, `HEAD` on the tarball URL returns 200); no bytes on this machine.
  `scripts/labeled-run.mjs` calls the deployed preview `/api/scan` on key day and writes
  `docs/runs/2.0-labeled-results.md` (score, verdict, expected, pass/fail; removed tarballs count as
  unavailable, not as passes).

## 11. Step assignments

- Step 2, engine core (pure, no keys): `config.ts`, `types.ts`, `events.ts`, `archive.ts`, `resolve/*`,
  `reach/graph.ts`, `static/heuristics.ts`, `static/osv.ts`, `static/scanners.ts`, `reputation.ts`, `score.ts`,
  `ads.ts`, `model/writer.ts` validator, with unit tests. Adds deps `tar-stream` (or a reviewed in-repo parser).
- Step 3, sandbox: `sandbox/e2b/**` (template, build script, guest harness, forge, rules, mirror seed, Python
  tests), `sandbox/provider.ts`, `sandbox/e2b.ts`, `sandbox/detonate.ts`, `sandbox/analyze.ts`,
  `forensics/*.ts`. Adds dep `e2b@2.56.0`.
- Step 4, model + orchestrator: `model/adapter.ts`, `model/openai.ts` (dep `openai@7.34.0`), `model/readers.ts`,
  writer prompt, `orchestrator.ts`, `deps.ts`, test stand-ins, fixtures, keyless e2e test.
- Step 5, data: migrations 1 to 5 with down files, PGlite round-trip tests, `store.ts` (runs, events,
  reports, budget, dedup), `ratelimit.ts`, `auth.ts`, `scripts/db-branch-apply.mjs`; apply on a Supabase branch
  (create via `supabase branches create`; Supabase MCP refused this project with `-32600`).
- Step 6, surfaces: `app/api/scan/route.ts`, replay routes, `app/oauth/token/route.ts` + `.well-known` update,
  `app/mcp/route.ts` on the engine, `lib/scan.ts` web client on `/api/scan`, CLI and `mcp-server` clients on
  `/api/scan` with ads and `not_verified`, `lib/score.ts` band labels without banned words. UI pages compile
  and render existing reports.
- Step 7, removal + build: delete everything in 1.1, package.json scripts, `.github/workflows/ci.yml.disabled`
  updated to the 2.0 gates (left disabled), `vercel link` to project `clauderabbit`
  (`prj_ovQlkpZsijvfky3oZNlg0txYvqA5`), all gates green, preview deploy.
- Step 8, labeled set + docs: `tests/labeled/set.json`, `scripts/labeled-run.mjs`, updates to `CLAUDE.md`
  (ads now shown, fast/deep split gone), `docs/INFRASTRUCTURE.md`, `docs/COST.md`, `README.md`, and the final
  `docs/runs/2.0-backend.md` sections: what was proven, exact env var names, key-day checklist.

## 12. Evidence for external and local facts (all from step 1 of this session)

| Fact | Source |
|---|---|
| e2b latest `2.56.0`; `@e2b/code-interpreter` `2.9.0` | `npm view e2b version`, `npm view @e2b/code-interpreter version` |
| `Sandbox.create(template, opts)`; opts `timeoutMs`, `metadata`, `envs`, `allowInternetAccess`, `network`, `lifecycle`; `secure` ignored because "Every sandbox secures envd access"; envd port 49983 | `e2b@2.56.0` `dist/index.d.ts` lines 9246-9330, 10654-10669, 9274, 10601 |
| `commands.run(cmd, { user, cwd, envs, timeoutMs (default 60000), background, onStdout, onStderr })`; `CommandExitError`; `files.read(path, { user, format: "bytes" })` | same file 5482-5530, 5630-5665, 5696, 5096, 5219-5234 |
| Template builder: `fromUbuntuImage`, `fromImage`, `fromDockerfile`, `runCmd(cmd, { user })`, `copy`, `setUser`, `aptInstall`, `pipInstall`, `npmInstall`, `setStartCmd`; `Template.build(template, name, { cpuCount, memoryMB, skipCache })` | same file 11295-11964; docs.e2b.dev/template/quickstart |
| Network: `denyOut: ['0.0.0.0/0']` + hostname `allowOut`; HTTP Host on 80, TLS SNI on 443, other ports CIDR only; 8.8.8.8 DNS allowed when domains used; allow overrides deny; blocked TCP can appear to connect | docs.e2b.dev/sandbox/internet-access |
| E2B kernel lacks `xt_owner`; iptables `--uid-owner` exits 4; use nftables | docs.e2b.dev/faq/iptables-xt-owner.md |
| E2B pricing $0.000014 per vCPU-second, $0.0000045 per GiB-second; Hobby 20 concurrent, 1 h; Pro 100 concurrent, 24 h; default 2 vCPU / 4 GiB | e2b.dev/pricing |
| openai latest `7.34.0`; `responses.parse`; `text.format` `{ type: "json_schema", name, schema, strict }`; `zodTextFormat`; zod peer `^3.25 || ^4.0` | `npm view openai version`; `openai@7.34.0` `resources/responses/responses.d.ts` 54-92, 2642-2666; `helpers/zod.d.ts` 106 |
| `gpt-6-luna`: Responses API, structured outputs, reasoning effort none..max, $0.10 in / $0.50 out per 1M | developers.openai.com/api/docs/models/gpt-6-luna |
| OSV `POST /v1/querybatch` returns ids + modified only; MAL- ids exist (`MAL-2022-1`) | google.github.io/osv.dev/post-v1-querybatch; `curl api.osv.dev/v1/vulns/MAL-2022-1`; querybatch probe |
| npm `dist.integrity` is sha512 SRI (left-pad 1.3.0) | `curl registry.npmjs.org/left-pad/1.3.0` |
| GitHub `api.github.com/repos/o/r/tarball/<sha>` 302 to `codeload.github.com/.../legacy.tar.gz/<sha>`; codeload `tar.gz/<sha>` 200 gzip | `curl -sSI` (headers only) |
| `git archive` pax global header `comment=<commit sha>` | `git archive --format=tar HEAD` on this repo = `240d6b3e...` |
| npm 11 blocks dependency install scripts by default; `dangerously-allow-all-scripts` config exists | `npm help install-scripts`; `npm config ls -l` |
| libfaketime speed syntax `"+0 x30"`; `FAKETIME_DONT_RESET`; intercepts nanosleep, poll, ppoll, epoll_wait, epoll_pwait, select | libfaketime README and `src/libfaketime.c` |
| uv `0.13.1`; `UV_SYSTEM_CERTS` (replaces deprecated `UV_NATIVE_TLS`), `SSL_CERT_FILE`, `UV_CACHE_DIR`, `UV_PYTHON_DOWNLOADS` | PyPI JSON; docs.astral.sh/uv/reference/environment |
| GuardDog `3.2.0` (`guarddog npm|pypi scan <dir> --output-format=json`), Semgrep `1.181.0`, yara-x `1.21.0`, mitmproxy `12.2.3` (Python >=3.12) | GuardDog README; PyPI JSON |
| AdSense documented ins attributes: `data-ad-client`, `data-ad-slot`, `data-ad-format`, script `adsbygoogle.js?client=`, `push({})`. `data-adtest` is not documented on the fetched first-party pages; it is used because the owner brief requires it | developers.google.com/adsense/platforms/direct/ad-tags; web search |
| Supabase `realtime.send(payload, event, topic, is_private)`; REST `POST /realtime/v1/api/broadcast`; public vs private topics | supabase.com/docs/guides/realtime/broadcast |
| Vercel max duration: Hobby 300 s, Pro 800 s; `export const maxDuration` in App Router | vercel.com/docs/functions/configuring-functions/duration |
| Vercel project `clauderabbit` `prj_ovQlkpZsijvfky3oZNlg0txYvqA5`, team `team_V0mWomgjXnBRzYX8zHSC4JQL`; no `.vercel` link in the worktree | Vercel MCP `list_projects`; `ls .vercel` |
| Supabase: MCP `list_branches`/`get_project` refused (`-32600`); CLI `supabase branches list --project-ref mjvlczaytkhvsolnhhkz` returned `{"branches":[]}` | this session |
| Local tools: node v26.8.1, npm 11.19.0, deno 2.9.6, supabase CLI 2.116.0, vercel 59.11.2, gh 2.98.0, python 3.14.7; no docker, no psql | version commands |
| Baseline at `pre-2.0`: lint 0, typecheck 0, `npm test` 147 pass, `test:functions` 145 pass, `npm run build` 0 | this session |
