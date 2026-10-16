## 05. Dead weight

Measured 2026-10-16 in this session, read only, grep sweep (knip not run: 3 minute box; a grep sweep replaces it). Builds on `04-parts-map.md` (E4 tables, E6 secret names). Every `grep` below excludes `node_modules .next .git .claude koenigsegg` unless stated. Never in scope for removal: the forge, the per-scan sandbox reset, the never-a-bare-"Safe" rail.

### Verdict table

| Item | Status | Evidence |
|---|---|---|
| Table `scan_usage` | DEAD: only writer is RPC `check_and_increment_scan_limit`, which has zero callers | D5, D6 |
| RPC `check_and_increment_scan_limit` (initial_schema.sql:287) | DEAD: zero callers in app, lib, components, functions, cli, mcp-server | D6 |
| RPC `cleanup_oauth` (20260710120000:49) | No code caller; no `cron.schedule` in any migration; runs only if invoked by hand | D5, D6 |
| Table `deep_dispatch_lock` | LIVE via RPCs `deep_dispatch_try_claim` / `deep_dispatch_release` in `supabase/functions/deep-queue/index.ts` | D6 |
| Table `oauth_clients` | LIVE via RPC `register_oauth_client` in `app/oauth/register/route.ts` | D6 |
| Table `scan_rate_limit` | LIVE via RPC `check_scan_rate_limit` in `supabase/functions/_shared/rate-limit.ts` | D6 |
| Table `profiles` | LIVE: `components/spa/state.tsx:818,1858` (04 grep omitted `components/`) | D6 |
| Supabase secret `GEMINI_API_KEY` | ZERO code refs | D7 |
| Supabase secrets `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS` | ZERO code refs (platform-injected names) | D7 |
| GCP secrets `cr-deep-runner-key`, `cr-forge-control-key` | ZERO literal refs; consumed by mounted env (`CR_DEEP_RUNNER_KEY` 9 files, forge-control in 5 `sandbox/cloudrun` files) | D7, D8 |
| Root devDep `critters` | No import; named in a `next.config.ts:11` comment as required by an optimizer setting | D3 |
| Root devDep `world-atlas` | No import; read as a file by `scripts/gen-world-map.mjs:20` (build-time generator) | D3 |
| `cli` deps `@modelcontextprotocol/sdk`, `zod` | DEAD: zero matches in `cli/src` | D4 |
| Ad-era leftovers in code | NONE: 7 matching files, all docs or CLAUDE.md history notes | D1 |
| Shell-hook leftovers in code | NONE functional: 1 code hit, a removal comment at `cli/src/index.ts:20-21` | D2 |
| Duplicate scan paths | 3 clients, 1 backend: web `lib/scan.ts:480`, CLI `cli/src/lib/client.ts:128,144`, MCP package `mcp-server/src/claude-rabbit-client.ts:105,120` each POST to `functions/v1/scan`; remote MCP `app/mcp/route.ts:93,119` calls `runScan` from `lib/scan.ts`. CLI and MCP package carry parallel `scanRepo` client copies | D9 |

### Evidence

D1, ad-era (`grep -rniE 'adsense|rewarded|skip ad|ad-gate|adgate|watch ad' .`), file count 7, all prose:
```
CLAUDE.md:111:**Login / limits / monetization:** scanning is free and unlimited, no login or ad ever required
docs/claude-rabbit-system-design-prd.md:138:| Monetization | AdMob + mediation, rewarded video | — | one ad per fresh scan |
docs/COST.md:14:Per `docs/INFRASTRUCTURE.md` §9 and CLAUDE.md: the originally planned ad-gated revenue
docs/claude-rabbit-ux.md:25:- **Scanning is free and unlimited, no login or ad ever required.**
docs/runs/2026-06-27-SESSION-REPORT.md:104:- **BUG-11** — sign-in/ad-gate coherence: ... AdScreen "Skip ad (demo)"
count:        7
```
Stale doc: `docs/claude-rabbit-system-design-prd.md:138,154` still tabulates AdMob revenue as a model row.

D2, shell hooks (`grep -rniE 'install-hooks|uninstall-hooks|npm-install|pnpm-install|git-clone' .`), 4 files:
```
CLAUDE.md:113 ...  docs/claude-rabbit-system-design-prd.md:38 ...  docs/runs/2026-06-27-make-it-shippable.md:70 ...
cli/src/index.ts:20: * An earlier opt-in shell-hook feature (`install-hooks`/`uninstall-hooks`,
cli/src/index.ts:21: * `npm-install`/`pnpm-install`/`git-clone`) was built and then removed: it
```

D3, root deps (importer count, `grep -rlF '"<dep>' app lib components proxy.ts next.config.ts scripts tests`):
```
@modelcontextprotocol/sdk 1   @sparticuz/chromium 2   @supabase/ssr 3   @supabase/supabase-js 7
puppeteer-core 1   zod 2   critters 0   d3-geo 1   topojson-client 1   world-atlas 0
```
`grep -rnE 'critters|world-atlas' app lib components scripts next.config.ts`:
```
scripts/gen-world-map.mjs:20:  readFileSync("node_modules/world-atlas/countries-110m.json", "utf8"),
next.config.ts:11:  // ~460ms of simulated-mobile LCP). Requires the `critters` devDependency.
```

D4, sub-package deps (`grep -rlE "from .<dep>" cli/src | wc -l`, same for `mcp-server/src`; `grep -rnE "modelcontextprotocol|zod" cli/src` returned nothing):
```
== DEPS cli/src            == DEPS mcp-server/src
@modelcontextprotocol/sdk 0   @modelcontextprotocol/sdk 2
boxen 1                       zod 1
chalk 1
zod 0
```

D5, migration functions and triggers (`grep -nE "create (or replace )?function|create trigger|cron.schedule" supabase/migrations/*.sql`), excerpt; zero `cron.schedule` lines:
```
20260625000001_initial_schema.sql:287:create or replace function public.check_and_increment_scan_limit(
20260702000001_scan_burst_rate_limit.sql:77:create or replace function public.check_scan_rate_limit(
20260704000002_oauth_for_remote_mcp.sql:78:create or replace function public.register_oauth_client(p_redirect_uris text[])
20260710120000_oauth_cleanup_bounded_growth.sql:49:create or replace function public.cleanup_oauth()
20260711000001_deep_dispatch_lock.sql:73:create or replace function public.deep_dispatch_try_claim(
20260711000001_deep_dispatch_lock.sql:124:create or replace function public.deep_dispatch_release(
```
`grep -lw scan_usage supabase/migrations/*.sql`: `20260625000001_initial_schema.sql`, `20260702000001_scan_burst_rate_limit.sql` (line 285 comment: function writes scan_usage).

D6, callers (`grep -rl <name> app lib components supabase/functions sandbox scripts cli/src mcp-server/src`):
```
rpc check_and_increment_scan_limit:
rpc check_scan_rate_limit: supabase/functions/_shared/rate-limit.test.ts supabase/functions/_shared/rate-limit.ts
rpc deep_dispatch_try_claim: supabase/functions/deep-queue/index.ts
rpc deep_dispatch_release: supabase/functions/deep-queue/index.ts
rpc register_oauth_client: app/oauth/register/route.ts
rpc create_oauth_code: app/oauth/authorize/page.tsx
rpc cleanup_oauth:
profiles: components/spa/state.tsx   (818: .from("profiles"), 1858: .from("profiles"))
deep_dispatch_lock / oauth_clients / scan_rate_limit / scan_usage direct refs: (none)
```

D7, secret names (`grep -rlw <name> app lib components supabase/functions sandbox scripts cli/src mcp-server/src proxy.ts | wc -l`, names from 04 E6):
```
CR_COMBINE 1  CR_COMBINED_TIER 1  CR_DEEP_RUNNER_KEY 9  CR_DF_AGENT_ID 1  CR_GUARD_AUDIENCE 1
CR_GUARD_BUDGET_NAME 1  CR_GUARD_PUSH_SA 1  CR_MODEL_BACKEND 2  CR_PROBE_KEY 2  GCP_LOCATION 3
GCP_PROJECT_ID 5  GEMINI_API_KEY 0  GEMINI_DEEP_MODEL 1  GEMINI_FAST_MODEL 1  GITHUB_TOKEN 1
GOOGLE_SERVICE_ACCOUNT_JSON 6  SITE_URL 8  SUPABASE_ANON_KEY 2  SUPABASE_DB_URL 0  SUPABASE_JWKS 0
SUPABASE_PUBLISHABLE_KEYS 0  SUPABASE_SECRET_KEYS 4  SUPABASE_SERVICE_ROLE_KEY 5  SUPABASE_URL 12
VERTEX_LOCATION 4  cr-deep-runner-key 0  cr-forge-control-key 0
```

D8, forge key consumers (`grep -rliE "forge.control|FORGE_CONTROL|deep-runner-key" ... sandbox`):
```
sandbox/cloudrun/harness/detonate.py sandbox/cloudrun/harness/entrypoint.sh
sandbox/cloudrun/harness/test_privilege_separation.py sandbox/cloudrun/forge/provision-forge-gateway.sh
sandbox/cloudrun/forge/forensics_api.py
```

D9, scan entry paths (`grep -rnoE "functions/v1/scan|runScan\(|scanRepo\(" app/mcp/route.ts mcp-server/src cli/src lib/scan.ts`):
```
app/mcp/route.ts:93:runScan(            app/mcp/route.ts:119:runScan(
cli/src/lib/client.ts:128:functions/v1/scan   cli/src/lib/client.ts:144:functions/v1/scan
lib/scan.ts:480:functions/v1/scan       lib/scan.ts:488:runScan(
mcp-server/src/claude-rabbit-client.ts:105:functions/v1/scan   mcp-server/src/claude-rabbit-client.ts:120:functions/v1/scan
```
All four surfaces converge on the one `scan` edge function; the duplication is in client code (`cli/src/lib/client.ts` and `mcp-server/src/claude-rabbit-client.ts` both define `scanRepo`), not in scan logic. 04 E8: `clauderabbit-mcp` returns E404 on npm, so the `mcp-server/` package is unpublished duplicate client code next to the live remote MCP at `app/mcp/route.ts`.

### Unused code (exported symbols, files)

UNKNOWN. knip was not run inside the 3 minute box; no exported-symbol sweep completed. Command for the next pass: `npx -y knip@5 --no-progress --reporter compact`.

### Removal candidates (never the forge, the per-scan sandbox reset, or the never-a-bare-"Safe" rail)

1. `scan_usage` table plus `check_and_increment_scan_limit` RPC (login-wall era limiter, zero callers).
2. `cli/package.json` deps `@modelcontextprotocol/sdk` and `zod` (zero imports in `cli/src`).
3. Supabase secret `GEMINI_API_KEY` (zero refs; model traffic goes through Vertex per `_shared/vertex.ts`).
4. `mcp-server/` package (unpublished per 04 E8, duplicates the remote MCP), or publish it.
5. `cleanup_oauth`: schedule it or drop it; today nothing invokes it.
6. AdMob rows in `docs/claude-rabbit-system-design-prd.md:138,154`.
