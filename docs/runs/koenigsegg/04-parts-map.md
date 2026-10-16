## 04. Parts map

Measured 2026-10-16 from this session. Each "production calls it" cell is YES or NO with its evidence, or UNKNOWN with the failed attempt. Secret values were never read. `supabase secrets list` prints SHA-256 digests in its value field; only names are recorded here.

### Evidence

E1, routes (`find app -name 'page.tsx' -o -name 'route.ts'`), 21 files:
```
app/.well-known/oauth-authorization-server/route.ts   app/.well-known/oauth-protected-resource/mcp/route.ts
app/[owner]/[repo]/page.tsx   app/api/deep/route.ts   app/api/export/markdown/route.ts   app/api/export/pdf/route.ts
app/auth/callback/route.ts   app/badge/[owner]/[repo]/route.ts   app/cli-auth/page.tsx   app/mcp/route.ts
app/npm/[...pkg]/page.tsx   app/oauth/authorize/page.tsx   app/oauth/register/route.ts   app/page.tsx
app/privacy/page.tsx   app/terms/page.tsx
```

E2, deployed edge functions (`supabase functions list --project-ref mjvlczaytkhvsolnhhkz`), 5 ACTIVE, `updated_at` in epoch ms:
```
scan              ACTIVE version 72  updated_at 1791103678985
attach-forensics  ACTIVE version 32  updated_at 1783620568184
deep-queue        ACTIVE version 23  updated_at 1783753158498
oauth-token       ACTIVE version 14  updated_at 1783157084530
billing-guard     ACTIVE version 9   updated_at 1791101200336
```
Local `ls supabase/functions`: `_shared attach-forensics billing-guard deep-queue oauth-token scan`. All 5 non-shared dirs are deployed.

E3, call paths into functions (`grep -rnoE "functions/v1/[a-z-]+" app lib cli supabase/functions`):
```
app/.well-known/oauth-authorization-server/route.ts:22:functions/v1/oauth-token
cli/src/lib/client.ts:128:functions/v1/scan
lib/deep-queue-client.ts:31:functions/v1/deep-queue
lib/scan.ts:480:functions/v1/scan
```
`grep -n attach-forensics app/api/deep/route.ts lib/cloud-run-dispatch.ts`:
```
lib/cloud-run-dispatch.ts:220: * POSTs its own forensic record to attach-forensics).
app/api/deep/route.ts:99:// OWN entrypoint POSTs to attach-forensics directly
```

E4, tables (`grep -hoiE 'create table ...' supabase/migrations/*.sql | sort -u`), 11 tables:
```
deep_dispatch_lock deep_scan_queue cli_tokens oauth_clients oauth_codes owners profiles reports scan_rate_limit scan_usage scans
```
Code references (`grep -rlw <table> app lib supabase/functions`, tests excluded):
```
deep_dispatch_lock: (none)
deep_scan_queue: app/api/deep/route.ts lib/deep-queue.ts
cli_tokens: app/.well-known/oauth-authorization-server/route.ts supabase/functions/oauth-token/index.ts
oauth_clients: (none)
oauth_codes: supabase/functions/oauth-token/index.ts
owners: lib/report-fetch.ts supabase/functions/scan/index.ts supabase/functions/attach-forensics/index.ts (+6)
profiles: (none)
reports: app/[owner]/[repo]/page.tsx app/badge/[owner]/[repo]/route.ts supabase/functions/scan/index.ts (+24)
scan_rate_limit: (none)
scan_usage: (none)
scans: app/mcp/route.ts lib/scan.ts supabase/functions/scan/index.ts supabase/functions/_shared/rate-limit.ts (+12)
```
Row counts attempted via Supabase MCP `execute_sql` on `pg_stat_user_tables`:
```
MCP error -32600: You do not have permission to perform this action
```

E5, GCP (`gcloud run jobs list`, `gcloud run jobs executions list --job cr-detonation --limit 1`, `gcloud compute instances list`, project gen-lang-client-0062239756):
```
cr-detonation  us-central1
cr-detonation-zzdnv  2026-10-16T09:30:40.421855Z  2026-10-16T09:32:45.922016Z  succeeded 1
cr-forge-gateway  us-central1-a  RUNNING  e2-micro  lastStart 2026-10-03T22:44:55.888-07:00
```
`gcloud logging read 'resource.type="gce_instance"' --limit 1 --freshness 3d` returned no entries. `gcloud logging read 'protoPayload.serviceName="aiplatform.googleapis.com"' --limit 1 --freshness 3d` returned no entries (data-access audit logs not present).

E6, secrets, names only:
```
gcloud secrets list: cr-deep-runner-key, cr-forge-control-key
supabase secrets list (25): CR_COMBINE CR_COMBINED_TIER CR_DEEP_RUNNER_KEY CR_DF_AGENT_ID CR_GUARD_AUDIENCE
  CR_GUARD_BUDGET_NAME CR_GUARD_PUSH_SA CR_MODEL_BACKEND CR_PROBE_KEY GCP_LOCATION GCP_PROJECT_ID GEMINI_API_KEY
  GEMINI_DEEP_MODEL GEMINI_FAST_MODEL GITHUB_TOKEN GOOGLE_SERVICE_ACCOUNT_JSON SITE_URL SUPABASE_ANON_KEY
  SUPABASE_DB_URL SUPABASE_JWKS SUPABASE_PUBLISHABLE_KEYS SUPABASE_SECRET_KEYS SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_URL VERTEX_LOCATION
```

E7, model ids in code (`grep -rhoE "(gemini|claude|text-embedding)-..." app lib supabase/functions cli | uniq -c`):
```
2 gemini-2.5-flash
2 gemini-3.1-flash-lite
supabase/functions/_shared/vertex.ts:603: `cr-fast` (gemini-3.1-flash-lite ...
supabase/functions/_shared/vertex.ts:605: `cr-deep` (gemini-2.5-flash, temperature 0.2, 8192)
```
Step 02b measured live `token_count` traffic on `gemini-3.1-flash-lite` (fast) and a 3.5-flash deep read ("The 3.5-flash deep read is 78% of deep model cost", 02b line 125). The code comment names `gemini-2.5-flash` for `cr-deep`; the live deep model id differs from the code comment.

E8, CLI and MCP packages (`grep name/version cli/package.json mcp-server/package.json`, `npm view`):
```
cli: clauderabbit 0.1.8      npm: version '0.1.8', time.modified '2026-07-11T08:41:28.987Z'
mcp-server: clauderabbit-mcp 0.1.1   npm view clauderabbit-mcp: E404 Not Found
grep StdioServerTransport: mcp-server/src/index.ts
```

### Table

| Part | What it does | Production calls it | What breaks without it |
|---|---|---|---|
| `app/page.tsx` | Home, scan entry | YES: Vercel serves it; scan entry calls `lib/scan.ts:480` -> `functions/v1/scan` (E3) | No front door |
| `app/[owner]/[repo]/page.tsx` | GitHub report page | YES: reads `reports` (E4); is-number and clawdcursor reports served in 02b | No report view |
| `app/npm/[...pkg]/page.tsx` | npm report page | YES: reads `reports` (E4); npm card shipped in 3ce1f4a | No npm reports |
| `app/badge/[owner]/[repo]/route.ts` | README badge SVG | YES: reads `reports` (E4); last-hit timestamp UNKNOWN (no Vercel log query run) | Embedded badges 404 |
| `app/api/deep/route.ts` | Deep dispatch to Cloud Run | YES: cr-detonation-zzdnv ran 2026-10-16T09:30:40Z (E5), dispatched via this route per 02b | No deep scans |
| `app/api/export/markdown/route.ts` | Markdown export | UNKNOWN: code reads `reports` (E4); no invocation log queried | Export button fails |
| `app/api/export/pdf/route.ts` | PDF export | UNKNOWN: no invocation log queried | PDF export fails |
| `app/auth/callback/route.ts` | Supabase auth callback | UNKNOWN: no auth log queried | Sign-in fails |
| `app/cli-auth/page.tsx` | CLI login handoff | UNKNOWN: no invocation log queried | `clauderabbit` CLI login fails |
| `app/mcp/route.ts` | Remote MCP (HTTP) | UNKNOWN: code path reads `scans` (E4); no invocation log queried | Remote MCP clients fail |
| `app/.well-known/oauth-authorization-server/route.ts` | OAuth metadata for /mcp | UNKNOWN: points to `functions/v1/oauth-token` (E3); no hit log | MCP OAuth discovery fails |
| `app/.well-known/oauth-protected-resource/mcp/route.ts` | Protected-resource metadata | UNKNOWN: no hit log | MCP clients cannot find the auth server |
| `app/oauth/authorize/page.tsx` | OAuth consent | UNKNOWN: no hit log | MCP OAuth flow fails |
| `app/oauth/register/route.ts` | Dynamic client registration | UNKNOWN: no hit log; `oauth_clients` has zero code refs (E4) | MCP client registration fails |
| `app/privacy/page.tsx`, `app/terms/page.tsx` | Legal pages | YES: static pages in the deployed app (E1) | Legal exposure |
| edge fn `scan` v72 | Fast scan, Vertex fast tier, writes reports | YES: deployed ACTIVE (E2), called from `lib/scan.ts:480` and CLI (E3); 02b is-number scan 09:27:29 | Product does nothing |
| edge fn `attach-forensics` v32 | Receives deep forensic record from the detonation job | YES: deployed (E2); called by the Cloud Run entrypoint (E3); deep run zzdnv succeeded (E5) | Deep results never land |
| edge fn `deep-queue` v23 | Deep scan queue ops | YES: deployed (E2), called from `lib/deep-queue-client.ts:31` (E3) | Queued deep scans stall |
| edge fn `oauth-token` v14 | MCP OAuth token endpoint | YES deployed (E2); live call count UNKNOWN | MCP auth fails |
| edge fn `billing-guard` v9 | Billing kill switch (budget push) | YES deployed 1791101200336 (E2); budget-push invocation timestamp UNKNOWN | No automatic spend cutoff |
| table `reports` | Saved reports | YES: 27 code files (E4) | All report pages empty |
| table `scans` | Scan rows | YES: 16 code files incl. `scan` fn (E4) | Scan history, rate limit lost |
| table `owners` | GitHub owner cache | YES: `scan` and `attach-forensics` (E4) | Owner reputation signals lost |
| table `deep_scan_queue` | Deep queue | YES: `app/api/deep/route.ts`, `lib/deep-queue.ts` (E4) | Deep queue lost |
| table `cli_tokens` | CLI/MCP tokens | YES: `oauth-token` fn (E4) | CLI and MCP auth lost |
| table `oauth_codes` | OAuth codes | YES: `oauth-token` fn (E4) | MCP OAuth fails |
| table `deep_dispatch_lock` | Deep dispatch lock | NO direct ref in app/lib/functions (E4); SQL-function use UNKNOWN | UNKNOWN |
| table `oauth_clients` | OAuth client registry | NO direct ref (E4); SQL-function use UNKNOWN | UNKNOWN |
| table `profiles` | User profiles | YES: `components/spa/state.tsx:818,1858` (corrected by step 5) | signed-in profile state |
| table `scan_rate_limit` | Rate-limit counters | NO direct ref by name (E4); `_shared/rate-limit.ts` references `scans` | UNKNOWN |
| table `scan_usage` | Usage counters | NO direct ref (E4) | UNKNOWN |
| `cr-detonation` Cloud Run job | Per-scan sandbox detonation (deep) | YES: last execution cr-detonation-zzdnv 09:30:40Z to 09:32:45Z, succeeded 1 (E5) | No deep detonation |
| `cr-forge-gateway` VM | Forge egress gateway, e2-micro | YES running since 2026-10-03T22:44:55-07:00 (E5); last request timestamp UNKNOWN (no gce_instance log entries in 3d) | Detonation egress control lost |
| Secret Manager | `cr-deep-runner-key`, `cr-forge-control-key` (E6) | YES: job env carries `CR_DEEP_RUNNER_KEY`, `CR_FORGE_CONTROL_KEY` (02b, gcloud run jobs describe) | Job cannot auth to deep runner or forge |
| Supabase secrets | 25 names (E6) | YES: consumed by deployed functions (E2) | Functions fail on boot |
| Vertex fast `gemini-3.1-flash-lite` | Fast verdict | YES: live `token_count` metric (02b) | No fast verdict |
| Vertex deep (3.5-flash live; code comment says `gemini-2.5-flash`) | Deep read | YES: live metric (02b) | No deep verdict |
| Deep queue (`deep-queue` fn + `deep_scan_queue`) | Serializes deep jobs | YES (E2, E3, E4) | Concurrent deep dispatch unbounded |
| CLI `clauderabbit` 0.1.8 | Terminal scanner | YES published on npm, modified 2026-07-11 (E8); calls `functions/v1/scan` (E3) | CLI users lose access |
| stdio MCP `clauderabbit-mcp` 0.1.1 | Local MCP server | NO: `npm view clauderabbit-mcp` E404 (E8); not published | Nothing in production |
| Remote `/mcp` | HTTP MCP | UNKNOWN: route deployed (E1); no invocation log queried | Remote MCP users lose access |

### UNKNOWN
1. Row counts and last-write times for all 11 tables: `execute_sql` refused with `MCP error -32600`.
2. Production use of `deep_dispatch_lock`, `oauth_clients`, `profiles`, `scan_rate_limit`, `scan_usage`: no code reference by name; SQL functions and triggers in migrations not read.
3. Last invocation timestamps for every Vercel route except the scan and deep paths; no Vercel runtime-log query fit in the time box.
4. Last invocation of `oauth-token` and `billing-guard`.
5. cr-forge-gateway last request: `gcloud logging read 'resource.type="gce_instance"' --freshness 3d --limit 1` returned nothing.
6. Vertex audit-log last call: `gcloud logging read 'protoPayload.serviceName="aiplatform.googleapis.com"'` returned nothing.
7. Values of `GEMINI_FAST_MODEL` / `GEMINI_DEEP_MODEL` (not read by rule).
