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
- **Provides:** Postgres (reports, owners, scan runs, scan events, budget, auth tables), Auth (Google + email),
  and Realtime. The scan event trigger `scan_events_broadcast` calls `realtime.send(..., 'scan:'||run_id, false)`
  so clients subscribe to channel `scan:<run_id>`.
- **No Supabase functions.** `supabase/config.toml` sets `[edge_runtime] enabled = false`.
- **Keys:** the browser holds only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  (`sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B`). Vercel server code writes with `SUPABASE_SECRET_KEY`
  (`sb_secret_...`), falling back to `SUPABASE_SERVICE_ROLE_KEY`.
- **2.0 migrations:** five up files `supabase/migrations/20261016000001..05_*.sql`, each with a reverse file in
  `supabase/migrations-down/<name>.down.sql` (outside `migrations/` so the CLI never applies them). They run on a
  non-production database first with `scripts/db-branch-apply.mjs`, which refuses `mjvlczaytkhvsolnhhkz`.
  Where they have been applied is recorded in `docs/runs/2.0-backend.md`.

---

## 4. E2B

- **SDK:** `e2b@2.56.0`.
- **Template:** defined in `sandbox/e2b/template.ts` (Ubuntu 24.04, Node 24 with checked sha256, uv, mitmproxy,
  Semgrep, GuardDog, yara-x, nftables, strace, libfaketime; user `cr` uid 1001 with no sudo). Built with
  `E2B_API_KEY=... npm run template:build` (runs `sandbox/e2b/build.ts`, `cpuCount: 2`, `memoryMB: 4096`), which
  prints `template_id=... build_id=... name=...`. The default name is `clauderabbit-detonate`; set
  `CR_E2B_TEMPLATE` in Vercel to the built name.
- **Per scan:** `Sandbox.create(template, { timeoutMs: 90000, ... })`, so E2B reaps a VM even if the function
  dies. Inside, the forge runs as root and nftables redirects every outbound connection from uid 1001 to it; the
  repo installs and runs as uid 1001 under `FAKETIME` acceleration. Forensics are read as root through the SDK.
- **Pricing (e2b.dev/pricing, recorded in DESIGN.md section 12):** $0.000014 per vCPU-second and $0.0000045 per
  GiB-second; Hobby 20 concurrent sandboxes, Pro 100.

---

## 5. Model

- **Model id:** `gpt-6-luna` (default in `lib/engine/config.ts`, override `CR_MODEL_ID`), reasoning effort
  `CR_MODEL_REASONING_EFFORT` (default `low`). SDK `openai@7.34.0`, Responses API with strict `json_schema`.
- **Calls per fresh scan:** three readers (install surface, flagged code, README versus code) and one report
  writer. The writer output is validated (`lib/engine/model/writer.ts`): it can never produce a bare "Safe" and
  must agree with the verdict computed in code.
- **The number is never the model's:** `lib/engine/score.ts` computes the score and verdict.
- **Pricing (developers.openai.com, DESIGN.md section 12):** $0.10 per 1M input tokens, $0.50 per 1M output.

---

## 6. Environment variables (exact names)

| Name | Where | Required | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | Vercel server | key day | OpenAI Responses API |
| `E2B_API_KEY` | Vercel server + template build shell | key day | E2B sandboxes and template build |
| `CR_MODEL_ID` | Vercel server | no (default `gpt-6-luna`) | model id override |
| `CR_MODEL_REASONING_EFFORT` | Vercel server | no (default `low`) | `none`, `low`, `medium`, `high` |
| `CR_E2B_TEMPLATE` | Vercel server | no (default `clauderabbit-detonate`) | template name |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | yes | Supabase URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | client + server | yes | publishable key |
| `SUPABASE_SECRET_KEY` | Vercel server | yes | `sb_secret_...` for writes; fallback `SUPABASE_SERVICE_ROLE_KEY` |
| `NEXT_PUBLIC_SITE_URL` | client + server | yes | canonical site URL |
| `GITHUB_TOKEN` | Vercel server | no | higher GitHub API limit |
| `NEXT_PUBLIC_ADSENSE_CLIENT_ID` | client + server | no | `ca-pub-...` |
| `NEXT_PUBLIC_ADSENSE_SLOT_ID` | client + server | no | ad slot |
| `NEXT_PUBLIC_ADSENSE_TEST` | client + server | no (default `on`) | `data-adtest` |
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

---

## 9. Spend floor

Table `scan_budget` and RPC `scan_budget_charge` cap sandbox seconds and model tokens per day
(`CR_DAILY_SANDBOX_SECONDS_CAP`, `CR_DAILY_MODEL_TOKENS_CAP`). Over a cap, cached reports still serve and fresh
scans return 503 with an event. The burst rate limit (RPC `check_scan_rate_limit`) is an anti-abuse floor, never
a daily quota. Unit costs are in `docs/COST.md`.
