# INFRASTRUCTURE.md: ClaudeRabbit 2.0

This file is the factual reference for ClaudeRabbit's infrastructure: accounts, services, projects, environment
variable names and where secrets live. `CLAUDE.md` holds the binding rules and points here for infra facts.
The binding design contract for the 2.0 backend is `docs/2.0/DESIGN.md`; this file summarises the facts from it
that operators need. Do not guess account IDs, project refs, template names, model ids or env names: they are
recorded here exactly.

---

## 1. Accounts and ownership

- **GitHub:** user `AIdhirajSingh`, repo `clauderabbit` (`https://github.com/AIdhirajSingh/clauderabbit.git`).
- **Vercel:** project `clauderabbit` (`prj_ovQlkpZsijvfky3oZNlg0txYvqA5`), team `team_V0mWomgjXnBRzYX8zHSC4JQL`.
- **Supabase:** project `clauderabbit`, ref `mjvlczaytkhvsolnhhkz` (production, see section 3).
- **OpenAI:** API account holding `OPENAI_API_KEY` (key day).
- **E2B:** account holding `E2B_API_KEY` (key day).
- **Google:** 2.0 uses Google only for Google Sign-In (Supabase Auth provider) and AdSense.
- **1.0 production stack (stays running, untouched):** the 1.0 Google Cloud project (the `cr-detonation` Cloud Run
  job, the `cr-forge-gateway` VM, Secret Manager, the Gemini/Vertex keys) and the deployed 1.0 Supabase functions
  keep serving production 1.0. 2.0 does not import, call, read env vars for, or depend on any of them.

---

## 2. Runtime layout

| Piece | Where it runs | Code |
|---|---|---|
| Web app, report pages, badges | Vercel (Next.js App Router) | `app/`, `components/`, `lib/` |
| The scan (every stage) | Vercel function `POST /api/scan`, `runtime = "nodejs"`, `maxDuration = 120` | `app/api/scan/route.ts`, `lib/server/scan-service.ts`, `lib/engine/**` |
| Remote MCP | Vercel function `/mcp`, runs the engine in-process | `app/mcp/route.ts` |
| OAuth token endpoint for remote MCP | Vercel function `/oauth/token` | `app/oauth/token/route.ts` |
| Event replay | `/api/runs/[runId]/events`, `/api/scan/replay?target=&sha=` | `app/api/runs/`, `app/api/scan/replay/` |
| Detonation | One fresh E2B sandbox per scan from template `CR_E2B_TEMPLATE`, killed in `finally` | `lib/engine/sandbox/e2b.ts`, `lib/engine/sandbox/detonate.ts`, `sandbox/e2b/guest/*` |
| Static scanners (Semgrep, YARA, GuardDog) | A second E2B sandbox from the same template with `allowInternetAccess: false`; never runs repo code | `lib/engine/sandbox/analyze.ts`, `sandbox/e2b/guest/cr-analyze.sh` |
| Model | OpenAI Responses API, strict JSON schema, one adapter | `lib/engine/model/openai.ts`, `lib/engine/model/adapter.ts` |
| Database, auth, Realtime | Supabase | `supabase/migrations/`, `lib/engine/store.ts` |
| CLI and stdio MCP | User machines, posting to `${CLAUDE_RABBIT_SITE_URL}/api/scan` | `cli/`, `mcp-server/` |

Untrusted bytes exist only in Vercel function memory and inside E2B VMs.

- **Local preview:** the app runs on **localhost:2311** (`npm run dev`).

---

## 3. Supabase

- **Project:** `clauderabbit`, ref `mjvlczaytkhvsolnhhkz`, region `ap-south-1`, URL
  `https://mjvlczaytkhvsolnhhkz.supabase.co`.
- **Provides:** Postgres, Auth (Google + email) and Realtime. 1.0 lives in schema `public`; 2.0 lives in its
  own schema `v2` of the same production project (reports, owners, scan runs, scan events, budget, rate limit,
  CLI tokens, OAuth clients and codes). The 2.0 migrations create objects in `v2` only and never alter, drop or
  write a 1.0 object. The v2 trigger `v2.scan_events_broadcast` calls
  `realtime.send(..., 'scan:'||run_id, false)` (Realtime Broadcast, public channel), so clients subscribe to
  channel `scan:<run_id>` without `v2` being exposed to the Data API.
- **No Supabase functions.** `supabase/config.toml` sets `[edge_runtime] enabled = false`.
- **Keys:** the browser holds only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  (`sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B`). The 2.0 server reads and writes only as the Postgres login
  role `cr_v2_server` (`CR_V2_DATABASE_URL`, Supavisor pooler, transaction mode, port 6543, user
  `cr_v2_server.mjvlczaytkhvsolnhhkz`): USAGE on schema `v2`, per-table DML on v2 tables, EXECUTE on v2
  functions, no grant on any 1.0 table, NOBYPASSRLS, no CREATEROLE or CREATEDB. Its password is set once with an
  operator SQL call and lives only in Vercel env and the operator's local secrets file. 2.0 uses no Supabase
  secret or service key; the 1.0 keys and edge-function secrets stay untouched. The server checks web session
  JWTs against the Auth server with the publishable key.
- **2.0 migrations:** four additive up files `supabase/migrations/20261016000000..03_v2_*.sql` (schema and role,
  runs and events and reports, auth and rate limit, budget), each with a reverse file in
  `supabase/migrations-down/<name>.down.sql` (outside `migrations/` so the CLI never applies them).
  `tests/db/migrations.test.ts` proves on PGlite that the public, auth, realtime and extensions catalogs are
  identical before and after the set and after its reverse. They are applied to production through the Supabase
  MCP `apply_migration` with names prefixed `v2_`; `supabase/migrations-post-cutover/` stays unapplied until 1.0
  retires. Where they have been applied is recorded in `docs/runs/2.0-keyday.md`.

---

## 4. E2B

- **SDK:** `e2b@2.56.0`.
- **Template:** defined in `sandbox/e2b/template.ts` (Ubuntu 24.04, Node 24 with checked sha256, uv, mitmproxy,
  Semgrep, GuardDog, yara-x, nftables, strace, libfaketime; user `cr` uid 1001 with no sudo). Built by
  `sandbox/e2b/build.ts` at `cpuCount: 1`, `memoryMB: 2048` from `lib/engine/sandbox/resources.ts` (the same
  constants the cost ledger prices). The key never leaves Vercel: `npm run vercel-build` (what Vercel runs) calls
  `node sandbox/e2b/build.ts --vercel-hook` before `next build`, which builds only on a Preview build
  (`VERCEL_ENV=preview`) with `E2B_API_KEY` set, and only when the content tag (`sandbox/e2b/content-tag.ts`,
  sha256 of the template inputs and the VM size) is not already the `default` build. Production builds skip it.
  The build log line `template_id=... build_id=... name=... tag=c-...` records each build. Manual build:
  `E2B_API_KEY=... npm run template:build`. The default name is `clauderabbit-detonate`.
- **Smoke proof:** `POST /api/ops/smoke` on a Preview deployment with header `x-cr-operator-key`
  (`lib/server/ops-smoke.ts`; 404 on production and without the key) boots a detonation VM running
  `/opt/cr/bin/cr-smoke.sh` (forge as root, `meta skuid 1001` fence, drop counters, forged replies, via
  `cr-proof.sh`) and an analysis VM running Semgrep, GuardDog and YARA at the same moment, and kills both.
- **Per scan:** `Sandbox.create(template, { timeoutMs: 90000, ... })`, so E2B reaps a VM even if the function
  dies. Inside, the forge runs as root and nftables redirects every outbound connection from uid 1001 to it; the
  repo installs and runs as uid 1001 under `FAKETIME` acceleration. Forensics are read as root through the SDK.
- **Pricing (e2b.dev/pricing, recorded in DESIGN.md section 12):** $0.000014 per vCPU-second and $0.0000045 per
  GiB-second; Hobby 20 concurrent sandboxes, Pro 100.

---

## 5. Models: Jev checks, Luna writes

- **Jev (every model-judged check):** decision model `typesafe-ai/jev` on Vercel AI Gateway (default in
  `lib/engine/config.ts`, override `CR_JEV_MODEL_ID`), called with `experimental_decide` from `ai@7.0.128`
  (`@ai-sdk/gateway@4.0.104`, `@vercel/oidc@3.2.0`, both exact pins) in `lib/engine/model/jev.ts`. Auth is Vercel
  OIDC only: the `x-vercel-oidc-token` request header on Vercel (project `oidcTokenConfig.enabled: true`) or
  `VERCEL_OIDC_TOKEN` from `vercel env pull` locally, sent as the bearer with `ai-gateway-auth-method: oidc`.
  No `AI_GATEWAY_API_KEY` is used; with no token the check fails closed. Calls per fresh scan: install check,
  docs check, flagged check (when static findings exist), run concurrently. Gateway list price on 2026-10-18
  (`GET https://ai-gateway.vercel.sh/v1/models`): input $0.042 per 1M tokens, output $0; type `evaluation`,
  32,000-token state limit. The gateway needs a credit card on the Vercel team before it serves a call.
- **Luna (the report, exactly one call per fresh scan, zero on a cache hit):** `gpt-6-luna` (default in
  `lib/engine/config.ts`, override `CR_MODEL_ID`), reasoning effort `CR_MODEL_REASONING_EFFORT` (default `low`).
  SDK `openai@7.34.0`, Responses API with strict `json_schema`, static instructions first and per-scan facts last
  with `prompt_cache_key` `clauderabbit-luna-report-v1`; `cached_tokens` and `cache_write_tokens` are recorded.
  The output is validated (`lib/engine/model/writer.ts`): it can never produce a bare "Safe" and must agree with
  the verdict computed in code. A rejected or failed call is not retried; the deterministic report is published.
- **The number is never a model's:** `lib/engine/score.ts` computes the score and verdict from sandbox facts,
  static hits, OSV intel, Jev answers mapped to findings in code, and reputation in its own group.
- **Pricing (developers.openai.com/api/docs/pricing, Standard, short context, 2026-10-18):** input $0.10, cached
  input $0.01, cache writes $0.125, output $0.50 per 1M tokens.
- **Cost ledger:** `lib/engine/cost.ts`; every fresh report carries `cost` (also on the NDJSON `result` line and
  in `v2.scan_runs.cost`): Jev and Luna tokens with these prices, E2B seconds at the template size, total in USD
  and INR (pinned 94.96 INR per USD, ECB reference via api.frankfurter.app for 2026-10-16; `CR_USD_INR` overrides).

---

## 6. Environment variables (exact names)

| Name | Where | Required | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | Vercel server | key day | OpenAI Responses API |
| `E2B_API_KEY` | Vercel server + template build shell | key day | E2B sandboxes and template build |
| `CR_MODEL_ID` | Vercel server | no (default `gpt-6-luna`) | Luna model id override |
| `CR_JEV_MODEL_ID` | Vercel server | no (default `typesafe-ai/jev`) | Jev gateway model id override |
| `VERCEL_OIDC_TOKEN` | Vercel runtime (injected) / local `vercel env pull` | Jev | AI Gateway auth; never a stored secret |
| `CR_USD_INR` | Vercel server | no (default 94.96) | USD to INR rate for the cost ledger |
| `CR_MODEL_REASONING_EFFORT` | Vercel server | no (default `low`) | `none`, `low`, `medium`, `high` |
| `CR_E2B_TEMPLATE` | Vercel server | no (default `clauderabbit-detonate`) | template name |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | yes | Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | client + server | yes | publishable key |
| `CR_V2_DATABASE_URL` | Vercel server | yes | pooler URL for role `cr_v2_server` (schema v2 only); 2.0 reads no Supabase secret key |
| `NEXT_PUBLIC_SITE_URL` | client + server | yes | canonical site URL |
| `GITHUB_TOKEN` | Vercel server | no | higher GitHub API limit |
| `NEXT_PUBLIC_ADSENSE_CLIENT_ID` | client + server | no | `ca-pub-...` |
| `NEXT_PUBLIC_ADSENSE_SLOT_ID` | client + server | no | ad slot |
| `NEXT_PUBLIC_ADSENSE_TEST` | client + server | no (default `on`) | `data-adtest` |
| `NEXT_PUBLIC_GAM_REWARDED_AD_UNIT` | client | no (default Google's sample `/22639388115/rewarded_web_example`) | GPT rewarded unit shown during a web scan |
| `CR_OPERATOR_KEY` | Vercel server | no (at least 32 chars) | regenerate and operator tarball target |
| `CR_DAILY_SANDBOX_SECONDS_CAP` | Vercel server | no (default 20000) | daily spend floor |
| `CR_DAILY_MODEL_TOKENS_CAP` | Vercel server | no (default 20000000) | daily spend floor |
| `CLAUDE_RABBIT_SITE_URL` | CLI / stdio MCP | no (default `https://clauderabbit.in`) | API base |
| `CLAUDE_RABBIT_SCAN_TIMEOUT_MS` | CLI / stdio MCP | no | client timeout |
| `CR_PRODUCTION_REFS` | operator shell | no | extra refs `scripts/db-branch-apply.mjs` refuses |

---

## 7. Secrets: server-side method (absolute)

- Every model, sandbox and database write credential is a **Vercel server environment variable**. Nothing secret
  is `NEXT_PUBLIC_*`, nothing secret is in the repo.
- Set them with the Vercel dashboard or `vercel env add <NAME> preview` / `vercel env add <NAME> production`.
- `.env`, `.env.local`, `.env*` and `*-key.json` are gitignored; `.env.example` lists names only.
- A lost or exposed key is rotated at the provider (new key, revoke old), never copied elsewhere.

---

## 8. Ads

Every scan response carries an `ad` (DESIGN.md section 8.3). The web renders Google AdSense in test mode
(`data-adtest="on"` unless `NEXT_PUBLIC_ADSENSE_TEST=off`) when both `NEXT_PUBLIC_ADSENSE_CLIENT_ID` and
`NEXT_PUBLIC_ADSENSE_SLOT_ID` are set, and the house ad otherwise. CLI and MCP responses carry the house ad from
`lib/engine/ads.ts`. Ads never gate a scan or a result.

While a web scan runs, `lib/ads/gpt-rewarded.ts` loads Google Publisher Tag and requests a rewarded
out-of-page slot (Google's public sample unit unless `NEXT_PUBLIC_GAM_REWARDED_AD_UNIT` is set), shows it
on `rewardedSlotReady` and logs granted, closed and no-fill. It is fire-and-forget: the scan stream and the
result never wait on it. No AdSense publisher id exists in the repo or here; the AdSense unit on report
pages renders only once the owner sets `NEXT_PUBLIC_ADSENSE_CLIENT_ID` and `NEXT_PUBLIC_ADSENSE_SLOT_ID`.
The CSP (`lib/csp.ts`) uses the `https:` scheme for script, frame and connect sources because Google's
GPT and AdSense CSP guidance supports only a nonce plus `'strict-dynamic'` policy (with an `https:`
fallback) and states that domain allowlists are unsupported.

---

## 9. Spend floor

Table `scan_budget` and RPC `scan_budget_charge` cap sandbox seconds and model tokens per day
(`CR_DAILY_SANDBOX_SECONDS_CAP`, `CR_DAILY_MODEL_TOKENS_CAP`). Over a cap, cached reports still serve and fresh
scans return 503 with an event. The burst rate limit (RPC `check_scan_rate_limit`) is an anti-abuse floor, never
a daily quota. Unit costs are in `docs/COST.md`.
