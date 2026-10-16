# Project Koenigsegg, Phase 1: Cold Audit

Date: 2026-10-16. Branch `audit/koenigsegg-phase1`. Run as a sequential Dynamic Workflow: one Opus executor per step, the lead reviewing each step before the next started. Every number below cites the command or tool call that produced it in the section that measured it. A value is MEASURED or UNKNOWN.

## Top line

| Item | Value | Source |
|---|---|---|
| What runs | Web (clauderabbit.in, all 7 page routes HTTP 200), remote MCP `scan` tool (score 89 returned), fast path, deep path (cr-detonation execution `cr-detonation-zzdnv` succeeded), 5 edge functions ACTIVE | 03, 04, 06 |
| What fails | Web report at the typed owner `/jonschlinkert/is-odd` shows "not scanned yet" (report lives at the canonical owner `/i-voted-for-trump/is-odd`); MCP `reportUrl` points at that broken URL; CLI 0.1.8 `scan` blocks on browser sign-in with no stored token | 03 |
| Monthly cost: Vercel | $0 (Hobby plan, `costs_not_found` for Sep 1 to Oct 16) | 01, 01b |
| Monthly cost: cr-forge-gateway VM idle | $3.65 to $10.16 (e2-micro, 10 GB pd-standard, ephemeral IPv4; lower bound if it holds the free-tier slot; list rates were not fetched this session, so the dollar range is UNKNOWN until cloud.google.com/compute/vm-instance-pricing is fetched) | 01 |
| Monthly cost: GCP per service | UNKNOWN (Budget API disabled, no BigQuery export, console needs sign-in) | 01, 01b |
| Monthly cost: Supabase | UNKNOWN (MCP reaches only the Pockit org; dashboard needs sign-in) | 01, 01b |
| GCP credits remaining, burn, run-out date | UNKNOWN (billing console redirected to Google sign-in) | 01b |
| Cost per scan, cached | $0 (2.35 s, no model call) | 02 |
| Cost per scan, fast | $0.00133 (6.95 s; 2,211 tokens in, 515 out, gemini-3.1-flash-lite) | 02, 02b |
| Cost per scan, deep | $0.0454 to $0.0492 (149.87 s; models $0.0410 to $0.0449, Cloud Run $0.00434 for 197.4 vCPU-s and 394.8 GiB-s) | 02b |

## Findings that need action

1. Vertex `usageMetadata` is never persisted (`supabase/functions/_shared/vertex.ts:441`), so the product cannot report its own cost per scan. (02)
2. The deep model in production traffic is a 3.5-flash read; the code names `gemini-2.5-flash` (`vertex.ts:605`). On the vertex backend the secret `GEMINI_DEEP_MODEL` sets the model; on the dialogflow backend the `cr-deep` generator sets it. Which backend `CR_MODEL_BACKEND` selects, and the secret value, are UNKNOWN. (02b, 04)
3. Owner-rename bug: reports are keyed on the canonical owner, the typed URL 404s logically, and the MCP returns the broken URL. (03)
4. The Cloud Billing Budget API is disabled on the project, so the `clauderabbit-credit-guard` budget is unconfirmed. (01)
5. Dead weight: table `scan_usage` and RPC `check_and_increment_scan_limit` (0 callers), RPC `cleanup_oauth` (0 callers), secret `GEMINI_API_KEY` (0 refs), `cli/` deps `@modelcontextprotocol/sdk` and `zod` (0 imports), `mcp-server/` unpublished on npm (E404). (04, 05)
6. Remote `/mcp` returns a plain-JSON 401 body rather than a JSON-RPC error object. (03)

## Not reached

- GCP credit balance, 30-day burn and run-out date: need a signed-in billing console session or a billing export.
- GCP cost per service and Supabase plan/cost: same cause.
- Lighthouse scores and Core Web Vitals: PageSpeed Insights shared quota exhausted; rerun with an API key.
- Unused exported code (knip sweep) not run.
- CLI scan output: needs a signed-in CLI token on this machine.
- Last invocation of routes other than scan/deep, of `oauth-token` and `billing-guard`, and table row counts.


## 01 Money

Measured 2026-10-16 09:23 UTC (`date -u`). Every value below is MEASURED with its source, or UNKNOWN with the failed attempt.

### Scope resolution (which accounts are ClaudeRabbit)

`docs/INFRASTRUCTURE.md` redacts the GCP project id. The live project list resolves it.

```
$ gcloud projects list --format="value(projectId,name)"
gen-lang-client-0062239756	ClaudeRabbit
...
$ gcloud billing projects describe gen-lang-client-0062239756
billingAccountName: billingAccounts/01CE66-086F73-F3E45C
billingEnabled: true
$ gcloud billing accounts describe 01CE66-086F73-F3E45C
currencyCode: INR
displayName: My Billing Account
open: true
```

The gcloud default project is `reliable-brace-463907-e4` (treye), so every ClaudeRabbit call passes `--project gen-lang-client-0062239756` explicitly.

```
$ supabase projects list
{"id":"mjvlczaytkhvsolnhhkz", ... "organization_id":"jnahpffanbkulssznima","name":"clauderabbit","region":"ap-south-1", ... "status":"ACTIVE_HEALTHY"}
$ supabase orgs list
{"id":"jnahpffanbkulssznima","slug":"jnahpffanbkulssznima","name":"ClaudeRabbit"}
```

```
Vercel MCP list_teams
{"name": "Adhiraj Singh's projects", "slug": "adhiraj-singhs-projects-bda59ce5", "id": "team_V0mWomgjXnBRzYX8zHSC4JQL"}
```

### GCP cost per service, current and previous month: UNKNOWN

No billing data source is readable from this laptop.

| Attempt | Result |
|---|---|
| Cloud Billing budgets | `billingbudgets.googleapis.com` disabled on both candidate quota projects |
| BigQuery billing export | `bigquery.googleapis.com` disabled on the ClaudeRabbit project, so no export dataset exists there |

```
$ gcloud billing budgets list --billing-account=01CE66-086F73-F3E45C --billing-project=gen-lang-client-0062239756 --quiet
ERROR: (gcloud.billing.budgets.list) [manishpratapsingh@gmail.com] does not have permission to access billingAccounts instance [01CE66-086F73-F3E45C] (or it may not exist): Cloud Billing Budget API has not been used in project gen-lang-client-0062239756 before or it is disabled.
  reason: SERVICE_DISABLED

$ bq ls --project_id gen-lang-client-0062239756
BigQuery error in ls operation: BigQuery API has not been used in project gen-lang-client-0062239756 before or it is disabled.
```

gcloud has no command that returns invoiced cost per service or credit balances. Enabling either API is a config change and is out of bounds for this read-only step. Per-service GCP cost for October and September 2026 is UNKNOWN.

Finding: `docs/INFRASTRUCTURE.md` §6b describes a Cloud Billing budget `clauderabbit-credit-guard` as the kill-switch trigger. The Budget API is disabled on the ClaudeRabbit project, so this session cannot confirm that budget exists. The budget list is readable only from a project where the Budget API is enabled; that check belongs to the reliability step.

### Remaining GCP credit, burn rate, run-out date: UNKNOWN

Credit balance and promotions are visible only in the Cloud Console billing pages or the billing export. Both reads failed above. With balance UNKNOWN and daily burn UNKNOWN, the run-out date cannot be computed. The formula, for whoever reads the console:

```
run_out_date = 2026-10-16 + (remaining_credit_INR / burn_INR_per_day)
burn_INR_per_day = (credit consumed 2026-09-16 .. 2026-10-16) / 30
```

### cr-forge-gateway VM: MEASURED

```
$ gcloud compute instances list --project gen-lang-client-0062239756 --quiet
NAME              ZONE           MACHINE_TYPE  STATUS   LAST_START_TIMESTAMP           CREATION_TIMESTAMP
cr-forge-gateway  us-central1-a  e2-micro      RUNNING  2026-10-03T22:44:55.888-07:00  2026-07-03T04:05:28.385-07:00

$ gcloud compute instances describe cr-forge-gateway --zone us-central1-a --project gen-lang-client-0062239756 \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP,networkInterfaces[0].accessConfigs[0].type,scheduling.provisioningModel)"
136.71.137.241	ONE_TO_ONE_NAT	STANDARD

$ gcloud compute disks list --project gen-lang-client-0062239756 --quiet
NAME              ZONE           SIZE_GB  TYPE
cr-forge-gateway  us-central1-a  10       pd-standard

$ gcloud compute addresses list --project gen-lang-client-0062239756 --quiet
NAME                 ADDRESS      ADDRESS_TYPE  STATUS  REGION
cr-forge-gateway-ip  10.200.0.10  INTERNAL      IN_USE  us-central1
```

| Field | Value |
|---|---|
| Machine type | e2-micro |
| Zone | us-central1-a |
| Status | RUNNING |
| Provisioning | STANDARD (on-demand, not Spot) |
| Created | 2026-07-03 11:05:28 UTC |
| Last start | 2026-10-04 05:44:55 UTC |
| Uptime since last start | 12 days 3 h 38 m (12.15 days) |
| Boot disk | 10 GB pd-standard |
| External IP | 136.71.137.241, ephemeral ONE_TO_ONE_NAT (no reserved external address in the project) |
| Internal reserved IP | 10.200.0.10 (internal addresses carry no charge) |

Uptime arithmetic:

```
$ python3 -c "...n-s for 2026-10-04T05:44:55Z .. 2026-10-16T09:23:04Z"
12 days, 3:38:09 12.15
```

Idle monthly cost at published us-central1 on-demand list prices (USD, 730 h month). The rates are Google's published list rates; this session did not fetch the pricing page, so the rates are context and the arithmetic is the measured part.

| Component | Rate | Arithmetic | Monthly list |
|---|---|---|---|
| e2-micro compute | $0.008376 / h | 0.008376 x 730 | $6.11 |
| pd-standard disk | $0.04 / GB-month | 0.04 x 10 | $0.40 |
| In-use external IPv4 | $0.005 / h | 0.005 x 730 | $3.65 |
| **Total at list** | | 6.11 + 0.40 + 3.65 | **$10.16** |

```
$ python3 -c "print(0.008376*730, 0.04*10, 0.005*730, 0.008376*730+0.4+0.005*730)"
6.1144799999999995 0.4 3.65 10.16448
```

Free-tier offset: the Compute Engine free tier covers one non-preemptible e2-micro in us-central1 (730 h) and 30 GB-month of standard PD per billing account. The VM is e2-micro, STANDARD provisioning, in us-central1-a, on a 10 GB pd-standard disk, so it qualifies on every measured attribute. If it is the only e2-micro in us-central1/us-west1/us-east1 on billing account `01CE66-086F73-F3E45C`, its billed idle cost is $3.65/month (the external IPv4 alone). The other projects on that billing account were not enumerated for e2-micro instances in this session, so whether the free-tier slot belongs to this VM is UNKNOWN; the billed range is $3.65 to $10.16 per month.

### Vercel: UNKNOWN

```
Vercel MCP list_billing_charges teamId=team_V0mWomgjXnBRzYX8zHSC4JQL from=2026-09-01T00:00:00.000Z to=2026-10-16T00:00:00.000Z
{"error":{"message":"Vercel API request failed (404: costs_not_found). Costs not found", "status":404, "code":"costs_not_found", "operation":"GET /v1/billing/charges", "requestId":"iad1:sfo1::4cptw-1792142601244-c7d412e72174"}}
```

The charges endpoint returns `costs_not_found` for September 1 to October 16. That endpoint serves FOCUS charge data for teams with usage-based billing; a 404 here means the team has no charge records in the window, which is consistent with a Hobby (free) team, but the plan field itself was not read. Charges: UNKNOWN (404). Plan: UNKNOWN (not queried; `get_team` was not called inside the time box).

### Supabase: UNKNOWN

```
Supabase MCP list_organizations
{"organizations":[{"id":"skihcaqvgtrsyweugpjb","slug":"skihcaqvgtrsyweugpjb","name":"Pockit"}]}
```

The Supabase MCP connection in this session is scoped to the Pockit organization only. The ClaudeRabbit organization `jnahpffanbkulssznima` exists (CLI output above) but is not reachable through the MCP, so `get_organization` (plan) and `get_cost` were not callable for it. The Supabase CLI has no plan or invoice command. Plan and monthly cost: UNKNOWN.

Note: `get_cost` returns the price of creating a new project or branch, not current spend, so even with access it does not answer monthly cost.

### Summary table

| Item | Value | Status |
|---|---|---|
| GCP project | gen-lang-client-0062239756, billing 01CE66-086F73-F3E45C (INR) | MEASURED |
| GCP cost per service, Oct 2026 | | UNKNOWN (Budget API and BigQuery disabled) |
| GCP cost per service, Sep 2026 | | UNKNOWN (same) |
| GCP remaining credit | | UNKNOWN (same) |
| GCP burn per day, last 30 days | | UNKNOWN (same) |
| GCP credit run-out date | | UNKNOWN (inputs UNKNOWN) |
| cr-forge-gateway | e2-micro, us-central1-a, RUNNING, STANDARD, up 12.15 days | MEASURED |
| cr-forge-gateway idle cost | $10.16/month at list; $3.65/month billed if it holds the free-tier slot | MEASURED arithmetic on list rates |
| Vercel charges Sep 1 to Oct 16 | 404 costs_not_found | UNKNOWN |
| Vercel plan | | UNKNOWN |
| Supabase plan and cost | MCP scoped to Pockit org only | UNKNOWN |

### Access gaps to close before Phase 2 money numbers exist

1. A billing viewer on `01CE66-086F73-F3E45C` reads Billing > Reports (group by service, Sep and Oct 2026) and Billing > Credits in the console, or the chairman approves enabling BigQuery billing export.
2. Re-authorize the Supabase MCP connector to include the ClaudeRabbit organization `jnahpffanbkulssznima`.
3. Read the Vercel team plan with `get_team` for `team_V0mWomgjXnBRzYX8zHSC4JQL`.


## 01b Money gaps

Measured 2026-10-16 09:25 UTC (`date -u` in the Supabase CLI call below). Closes the UNKNOWNs left by `01-money.md`. Every value is MEASURED with its source, or UNKNOWN with the failed attempt. Nothing was changed: no API enabled, no setting touched, no credential entered.

### Vercel plan: MEASURED, Hobby

The Vercel MCP `get_team` response carries no billing field:

```
Vercel MCP get_team teamId=team_V0mWomgjXnBRzYX8zHSC4JQL
{"result":{"team":{"name":"Adhiraj Singh's projects","slug":"adhiraj-singhs-projects-bda59ce5","id":"team_V0mWomgjXnBRzYX8zHSC4JQL","saml":{}}}}
```

The CLI fallback named in the tool description (`vercel api /v2/teams/{teamId}`) returns the billing object:

```
$ vercel api /v2/teams/team_V0mWomgjXnBRzYX8zHSC4JQL | python3 -c "...print billing.plan, billing.status, softBlock"
{'plan': 'hobby', 'status': 'active', 'softBlock': None}
```

| Field | Value |
|---|---|
| Plan | hobby |
| Billing status | active |
| softBlock | None (team is not blocked for usage) |

Vercel monthly cost: $0. Hobby is the free plan, and step 1 measured `list_billing_charges` returning `404 costs_not_found` for 2026-09-01 to 2026-10-16, which agrees with zero charges. Project usage against Hobby limits is not exposed by `get_team`; usage: UNKNOWN.

### Supabase ClaudeRabbit org: plan and cost UNKNOWN

The CLI confirms the org and its single project:

```
$ supabase orgs list
{"organizations":[{"id":"vhdctnirxlncgvfzyzdk",...,"name":"Treye"},{"id":"skihcaqvgtrsyweugpjb",...,"name":"Pockit"},{"id":"jnahpffanbkulssznima","slug":"jnahpffanbkulssznima","name":"ClaudeRabbit"}]}

$ supabase projects list
{"id":"mjvlczaytkhvsolnhhkz","ref":"mjvlczaytkhvsolnhhkz","organization_id":"jnahpffanbkulssznima","name":"clauderabbit","region":"ap-south-1","created_at":"2026-06-24T09:35:41.703067Z","status":"ACTIVE_HEALTHY","database":{...,"version":"17.6.1.127","postgres_engine":"17"}}
```

| Field | Value |
|---|---|
| Org | ClaudeRabbit `jnahpffanbkulssznima` |
| Projects in org | 1 (`clauderabbit`, `mjvlczaytkhvsolnhhkz`, ap-south-1, ACTIVE_HEALTHY, Postgres 17.6.1.127) |
| Plan | UNKNOWN |
| Monthly cost | UNKNOWN |

The CLI has no plan or invoice command. Step 1 measured the Supabase MCP scoped to Pockit only, so `get_organization` cannot reach this org. The dashboard billing page redirects to sign-in in the built-in browser:

```
Built-in browser navigate https://supabase.com/dashboard/org/jnahpffanbkulssznima/billing
get_page_text:
URL: https://supabase.com/dashboard/sign-in?returnTo=%2Forg%2Fjnahpffanbkulssznima%2Fbilling
Welcome back
Sign in to your account
```

Sign-in was recorded and not attempted.

### GCP remaining credit, 30-day burn, run-out date, cost per service: UNKNOWN

```
Built-in browser navigate https://console.cloud.google.com/billing/01CE66-086F73-F3E45C/credits
get_page_text:
URL: https://accounts.google.com/v3/signin/identifier?continue=https://console.cloud.google.com/billing/01CE66-086F73-F3E45C/credits&...&service=cloudconsole...
Sign in
to continue to Google Cloud Platform
Email or phone
```

The built-in browser holds no Google session, so the credits page and the reports page (`/billing/01CE66-086F73-F3E45C/reports?project=gen-lang-client-0062239756`, same account, same sign-in wall) are unreadable from it. Step 1 already measured both programmatic routes closed (Budget API `SERVICE_DISABLED`, BigQuery API disabled), and enabling either is a config change outside this step.

| Item | Status |
|---|---|
| Remaining GCP credit (INR) | UNKNOWN (console sign-in wall) |
| Credit consumed 2026-09-16 to 2026-10-16 | UNKNOWN (same) |
| Burn per day | UNKNOWN (no numerator) |
| Run-out date | UNKNOWN (no balance, no burn) |
| Cost per service, last 30 days and October to date | UNKNOWN (same) |

Arithmetic held ready for the first measured pair of values:

```
burn_INR_per_day = credit_consumed_2026-09-16_to_2026-10-16 / 30
run_out_date     = 2026-10-16 + floor(remaining_credit_INR / burn_INR_per_day) days
```

### Path to close the remaining gaps

Each remaining UNKNOWN needs one of these, all owned by the chairman:

1. GCP: open `console.cloud.google.com/billing/01CE66-086F73-F3E45C/credits` and `/reports` (group by service, last 30 days) in a browser already signed in as the billing account owner, or sign the built-in browser in. Reading needs no API enablement.
2. Supabase: open `supabase.com/dashboard/org/jnahpffanbkulssznima/billing` signed in, or reconnect the Supabase MCP with access to the ClaudeRabbit org so `get_organization` returns the plan.

### Summary

| Item | Value | Status |
|---|---|---|
| Vercel plan | hobby, active, not soft-blocked | MEASURED (`vercel api /v2/teams/...`) |
| Vercel monthly cost | $0 (Hobby, 0 charge records Sep 1 to Oct 16) | MEASURED (plan here + step 1 `costs_not_found`) |
| Vercel usage vs Hobby limits | | UNKNOWN (not in `get_team`) |
| Supabase ClaudeRabbit org | 1 project, ACTIVE_HEALTHY, ap-south-1 | MEASURED (`supabase projects list`) |
| Supabase plan / cost | | UNKNOWN (dashboard sign-in, MCP scoped to Pockit) |
| GCP remaining credit | | UNKNOWN (console sign-in) |
| GCP 30-day burn, burn/day | | UNKNOWN (console sign-in) |
| GCP run-out date | | UNKNOWN (no balance, no burn) |
| GCP cost per service | | UNKNOWN (console sign-in) |


## 02 Cost per scan

Measured 2026-10-16 from 09:27:29 UTC (`date -u`). Every value is MEASURED with its source, or UNKNOWN with the failed attempt.

### Code map (read from the repo at 3ce1f4a)

| Piece | Location | Finding |
|---|---|---|
| Scan API | `supabase/functions/scan/index.ts` (Supabase Edge Function, `POST /functions/v1/scan`, body `{owner, repo}`) | Pipeline: resolve SHA, cache check, static scan, model read, escalation gate, persist, NDJSON stream |
| SHA report cache | table `public.reports`, lookup `.eq("owner_login").eq("repo_name").eq("commit_sha")` at `scan/index.ts:1281-1288` | A hit returns `reshapeCached(row)` with no model call |
| Signed-in history | table `public.scans`, one insert per view (`scan_path: "cache"` at `:1302`, fresh at `:1914`) | Event log, not a read cache: the cache decision reads `reports` only |
| Vertex call | `supabase/functions/_shared/vertex.ts:310-322`, model from secret `GEMINI_FAST_MODEL` / `GEMINI_DEEP_MODEL`, backend switch `CR_MODEL_BACKEND` (vertex or dialogflow) | `usageMetadata` is returned in-process as `result.usage` (`vertex.ts:441`) and is never written to any table and never returned to the client |
| Deep path | `app/api/deep/route.ts` (Vercel) dispatches the Cloud Run job `cr-detonation`, `PER_DETONATION_MS = 90_000`, `DETONATION_MAX_WAIT_MS = 20 min` | Untrusted code runs only in that job |

Finding: token usage per scan is not persisted. `scan_usage` and `scans` carry no token columns, and the response omits `usage`. Per-scan model cost is therefore unmeasurable from product data; it needs a `usageMetadata` log line or column.

### Pinned repos and SHAs

```
$ gh api repos/jonschlinkert/is-number/commits/HEAD --jq .sha
98e8ff1da1a89f93d1397a24d7413ed15421c139
$ gh api repos/jonschlinkert/is-odd/commits/HEAD --jq .sha
a80ee0d831a8ee69f1fad5b4673491847975eb26
$ gh api repos/tj/commander.js/commits/HEAD --jq .sha
ba6d13ddb4243e5913367734f8c159089ffe7834
```

### Cache state before the runs

No delete was run. The pinned repos had zero rows in the SHA report cache, so the first scan is fresh without touching production data.

```
$ curl "$U/rest/v1/reports?select=id,owner_login,repo_name,commit_sha,deep,created_at&or=(and(owner_login.eq.jonschlinkert,repo_name.eq.is-number),and(owner_login.eq.jonschlinkert,repo_name.eq.is-odd),and(owner_login.eq.tj,repo_name.eq.commander.js))" -H "apikey: <publishable>"
[]
$ curl "$U/rest/v1/reports?select=id&limit=1" -H "Prefer: count=exact"
content-range: 0-0/36
$ curl "$U/rest/v1/scans?select=id&limit=1" -H "Prefer: count=exact"
content-range: */0
```

`reports` is publicly readable (36 rows total, 0 for the pinned repos). `scans` returns 0 under RLS for the publishable key, so the history row count is UNKNOWN. The privileged read failed:

```
$ supabase db query --linked "select ... from reports r ..."
{"_tag":"Error","error":{"code":"LegacyProjectNotLinkedError","message":"Cannot find project ref. Have you run supabase link?"}}
$ curl "$U/rest/v1/reports?..." -H "apikey: <legacy anon>"
{"message":"Legacy API keys are disabled", ...}
```

Running `supabase link` writes local config, so it was not run. After-counts are UNKNOWN for the same reason; the fresh scan created one `reports` row for is-number at `98e8ff1` (the second request returned `"cached":true`).

### Runs on production

```
$ curl -X POST "$U/functions/v1/scan" -d '{"owner":"jonschlinkert","repo":"is-number"}'   (twice)
run1 http=200 wall=6.946099s
run2 http=200 wall=2.345094s
run1: "cached":false "deep":false "escalate":false "scan_path":"fast" "commit_sha":"98e8ff1da1a89f93d1397a24d7413ed15421c139"
run2: "cached":true  "deep":false  score 97 "Trusted"
```

Vertex token metric for the ten minutes covering run 1 returned no series:

```
$ curl -G https://monitoring.googleapis.com/v3/projects/gen-lang-client-0062239756/timeSeries \
    --data-urlencode 'filter=metric.type="aiplatform.googleapis.com/publisher/online_serving/token_count"' ...
{"unit": "1"}
```

No `timeSeries` key means no Vertex publisher tokens were recorded in the window: either the metric had not landed yet, or the fast tier ran on the `dialogflow` backend (`CR_MODEL_BACKEND`), which this metric does not cover. Tokens in and out are UNKNOWN.

cr-detonation resources:

```
$ gcloud run jobs describe cr-detonation --project gen-lang-client-0062239756 --region us-central1
limits: cpu: '2'  memory: 4Gi
timeoutSeconds: '1800'
$ gcloud run jobs executions list --job cr-detonation --project gen-lang-client-0062239756 --limit 3
(no output)
```

The deep scan was not run inside the 5-minute time box. Deep wall time and billable seconds are UNKNOWN.

### Per-path table

| Path | Wall time | Tokens in | Tokens out | Model cost | Cloud Run seconds | Cloud Run cost | Total |
|---|---|---|---|---|---|---|---|
| Fresh fast (is-number @ 98e8ff1) | 6.95 s | UNKNOWN | UNKNOWN | UNKNOWN | 0 (no escalation) | 0 | UNKNOWN |
| Cached (same request) | 2.35 s | 0 (cache path makes no model call, `scan/index.ts:1290-1313`) | 0 | 0 | 0 | 0 | 0 model/compute; Supabase function invocation only |
| Deep | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN (job: 2 vCPU, 4 GiB) | UNKNOWN | UNKNOWN |

Rates: no rate page was fetched in this session, so no published Vertex or Cloud Run rate is cited here. Deep cost formula for the next run: billable seconds x (2 x vCPU-second rate + 4 x GiB-second rate) from cloud.google.com/run/pricing, plus deep-tier tokens at cloud.google.com/vertex-ai/generative-ai/pricing.

### UNKNOWNs

1. Vertex tokens in/out per fresh fast scan (not persisted; monitoring returned no series).
2. Model cost per fresh scan (depends on 1, and on the model id in secret `GEMINI_FAST_MODEL`, not readable here).
3. `scans` (history) row counts before and after (RLS; CLI not linked; legacy keys disabled).
4. Deep scan: wall time, tokens, cr-detonation billable seconds, cost (not run within the time box).
5. Published rate citations (not fetched).


## 02b Deep scan and token measurement

Measured 2026-10-16, 09:28:53 to 09:36 UTC. This closes gaps 1, 2, 4 and 5 of `02-cost-per-scan.md`. Everything here comes from calls made in this session. Each value is MEASURED (with its source) or UNKNOWN (with the attempt that failed).

### 1. Picking a repo that escalates

`decideEscalation` (`supabase/functions/scan/index.ts:710-760`) checks triggers in this order: obfuscation, credential access, install-time network/shell, new owner plus any code signal, confidence below threshold, and finally the model's own `escalate`. `app/api/deep/route.ts:692-735` takes `{owner, repo, sha}`. In production it dispatches through Cloud Run REST (`handleRestDeep`), and only for a report row that the fast path has already escalated. Public `reports` rows with `deep=true` gave a candidate:

```
$ curl "$U/rest/v1/reports?select=owner_login,repo_name,commit_sha,deep,created_at&deep=eq.true&order=created_at.desc&limit=8"
{"owner_login":"AmrDab","repo_name":"clawdcursor","commit_sha":"6702020e...","deep":true,"created_at":"2026-08-04T14:19:39"}
$ gh api repos/AmrDab/clawdcursor/commits/HEAD --jq .sha
35800c629a9210e8265469623676241b9f0d90fb
```

The HEAD SHA differs from the cached row, so the scan below ran fresh.

### 2. The deep scan on production (AmrDab/clawdcursor @ 35800c6)

Stage A was the fast scan with escalation (Supabase Edge Function):

```
$ curl -X POST "$U/functions/v1/scan" -d '{"owner":"AmrDab","repo":"clawdcursor"}'   (09:30:14 UTC)
http=200 wall=17.813967s
"cached":false "commit_sha":"35800c629a9210e8265469623676241b9f0d90fb" "escalate":true
"escalationReason":"install-time network/shell activity detected on static read"
"scan_path":"deep-static" "score":33 "verdict":"High risk"
```

Stage B was the detonation dispatch (Vercel `/api/deep` to Cloud Run job `cr-detonation`):

```
$ curl -N -X POST https://clauderabbit.in/api/deep -d '{"owner":"AmrDab","repo":"clawdcursor","sha":"35800c62..."}'
start 09:30:37  end 09:32:49
http=200 wall=132.055238s
stages: Escalate > Provisioning the sandbox container (67s) > Sandbox container starting > Installing dependencies > Building the repository (`npm run build`) > Sandbox run complete
{"t":"result","persisted":true}
```

The deep path runs as a Cloud Run job execution:

```
$ gcloud run jobs executions list --job cr-detonation --region us-central1 --project gen-lang-client-0062239756 --limit 2
…  cr-detonation  cr-detonation-zzdnv  us-central1  0  0 / 1  2026-10-16 09:30:40 UTC  cr-dispatch@gen-lang-client-0062239756.iam.gserviceaccount.com
$ gcloud run jobs executions describe cr-detonation-zzdnv ... --format="value(metadata.creationTimestamp,status.startTime,status.completionTime,status.succeededCount)"
2026-10-16T09:30:40.421855Z  2026-10-16T09:31:07.204022Z  2026-10-16T09:32:45.922016Z  1
```

| Measure | Value | Source |
|---|---|---|
| End-to-end wall time (stage A + stage B) | 17.81 s + 132.06 s = 149.87 s | curl `time_total` above |
| Queue and provisioning (created to started) | 26.8 s | execution describe |
| Execution duration (started to completed) | 98.7 s | execution describe |
| Created to completed | 125.5 s | execution describe |
| Job resources | 2 vCPU, 4 GiB | `gcloud run jobs describe` in 02 |
| vCPU-seconds (2 x 98.7) | 197.4 | derived from the rows above |
| GiB-seconds (4 x 98.7) | 394.8 | derived from the rows above |

The billing-export billable seconds are UNKNOWN because no billing export query was run. The execution duration above is the measured basis for cost. For reference, the earlier execution `cr-detonation-rp4d4` (2026-08-06) ran from 19:51:10.24 to 19:53:54.96, which is 164.7 s (`executions describe` in this session).

The job env has no model or gateway variable. The names it does carry are `CR_GCP_PROJECT`, `CR_GCP_LOCATION`, `CR_DEEP_RUNNER_KEY` and `CR_FORGE_CONTROL_KEY` (`gcloud run jobs describe --format=json`). Any cr-forge-gateway VM share per scan is UNKNOWN.

### 3. Tokens

#### Fast path, is-number@98e8ff1 (input via countTokens on the rebuilt prompt)

The system prompt was rebuilt byte for byte by evaluating `buildSystemPrompt()` (`scan/index.ts:458`). That gave 5,230 chars. The user prompt follows `buildUserPrompt` (`:565-622`), filled with live GitHub metadata (`gh api repos/jonschlinkert/is-number`, `gh api users/jonschlinkert`) and the README cut to `DECLARED_INTENT_MAX_CHARS = 2000`. Two fields were not available from GitHub and were filled in by hand: `files read this pass: 6` and `severity hint: low`. The model id comes from `vertex.ts:603`, which describes the fast tier as `gemini-3.1-flash-lite`. The `token_count` metric below confirms that the live fast-tier traffic is `gemini-3.1-flash-lite`.

```
$ POST aiplatform.googleapis.com/v1/projects/gen-lang-client-0062239756/locations/global/publishers/google/models/gemini-3.1-flash-lite:countTokens  (systemInstruction + user prompt)
"totalTokens": 2211, "totalBillableCharacters": 6924
$ ... :countTokens on the stored report text (score, verdict, summary, confidence, risky_json, logs_json of reports row id 42)
"totalTokens": 375
```

The Vertex metrics, which have reported series since 02 was written, give the real output. The invocation for the 09:27:29 is-number scan falls in the 2K to 5K input bucket and the 500 to 1K output bucket, and output `token_count` for 09:27 and 09:28 sums to 9 + 506 = 515:

```
$ curl -G monitoring.googleapis.com/v3/projects/gen-lang-client-0062239756/timeSeries filter=metric.type="aiplatform.googleapis.com/publisher/online_serving/token_count" interval 09:20-09:36 alignmentPeriod=60s ALIGN_SUM
gemini-3.1-flash-lite input   [('09:28','1003'),('09:29','2165'),('09:30','1418'),('09:31','3060'),('09:32','9784'),('09:33','30899')]
gemini-3.1-flash-lite output  [('09:27','9'),('09:28','506'),('09:30','13'),('09:31','751'),('09:32','13'),('09:33','759')]
gemini-3.5-flash input        [('09:31','16240'),('09:32','3248')]
gemini-3.5-flash output       [('09:31','480'),('09:32','190')]
$ same, metric model_invocation_count (GenerateContent only)
gemini-3.1-flash-lite  IN 5K_TO_10K  OUT 25_TO_50   [('09:32','1'),('09:33','2')]
gemini-3.1-flash-lite  IN 2K_TO_5K   OUT 500_TO_1K  [('09:28','1'),('09:31','1')]
gemini-3.5-flash       IN 10K_TO_20K OUT 500_TO_1K  [('09:31','1')]
```

Fast is-number: **2,211 in** (countTokens), **515 out** (metric, including reasoning). The 375 tokens of stored report text is the visible part of that output.

#### Deep scan, clawdcursor@35800c6 (Vertex metrics, attributed by time window)

This session issued no other scan, but the metric is project-wide, so other production traffic in the same minutes cannot be excluded.

| Call | Model | In | Out | Basis |
|---|---|---|---|---|
| Fast read (stage A, 09:30:14) | gemini-3.1-flash-lite | 3,060 | 751 | 09:31 bins; invocation bucket 2K to 5K in, 500 to 1K out |
| Deep read (stage A, `scan_path: deep-static`) | gemini-3.5-flash | 19,488 | 670 | 16,240 + 3,248 in, 480 + 190 out; one invocation, bucket 10K to 20K in, 500 to 1K out |
| Calls during the job (09:31 to 09:33) | gemini-3.1-flash-lite | 15,000 to 30,000 | 75 to 150 | 3 invocations, bucket 5K to 10K in, 25 to 50 out |

The per-minute token bins for flash-lite at 09:32 and 09:33 (40,683 in, 772 out) do not line up with the three small-output invocations. Exact per-call tokens for those three calls are UNKNOWN, and the bucket range above is what was measured.

### 4. Published rates (fetched this session)

`WebFetch` returned truncated pages for both URLs, so the same URLs were fetched with `curl -sL` and the text was extracted:

```
https://cloud.google.com/run/pricing  (section "Jobs", us-central1, Default column)
Jobs Free tier (based on us-central1 pricing): CPU - First 240,000 vCPU-seconds free per month RAM - First 450,000 GiB-seconds free per month
CPU (per vCPU-second) $0.000018 ... Memory (per GiB-second) $0.000002
https://cloud.google.com/vertex-ai/generative-ai/pricing  (redirects to /gemini-enterprise-agent-platform/generative-ai/pricing)
Gemini 3.1 Flash-Lite Input (text, image, video) Global $0.25 ... Text output (response and reasoning) Global $1.50   (per 1M tokens)
Gemini 3.5 Flash Input (text, image, video, audio) Global $1.50 ... Text output (response and reasoning) Global $9.00   (per 1M tokens)
```

### 5. Per-path table (list price, free tier not applied)

| Path | Wall time | Tokens in | Tokens out | Model cost | Cloud Run seconds | Cloud Run cost | Total USD per scan |
|---|---|---|---|---|---|---|---|
| Cached | 2.35 s (02) | 0 | 0 | $0 | 0 | $0 | $0 (Supabase invocation only) |
| Fast (is-number) | 6.95 s (02) | 2,211 (flash-lite) | 515 | $0.000553 + $0.000773 = **$0.00133** | 0 | $0 | **$0.00133** |
| Deep (clawdcursor) | 149.87 s | 3,060 flash-lite + 19,488 3.5-flash + 15,000 to 30,000 flash-lite | 751 + 670 + 75 to 150 | $0.00189 + $0.03526 + $0.0039 to $0.0077 = **$0.0410 to $0.0449** | 98.7 s execution (197.4 vCPU-s, 394.8 GiB-s) | $0.003553 + $0.000790 = **$0.00434** | **$0.0454 to $0.0492** |

The 3.5-flash deep read is 78% of deep model cost ($0.03526 of $0.0449). Cloud Run is 9% of the deep total.

### UNKNOWNs

1. Billing-export billable seconds for `cr-detonation-zzdnv`. The execution duration of 98.7 s is used instead; no billing export was queried.
2. Exact per-call tokens for the three flash-lite calls during the job window. Only the bucket range (5K to 10K in, 25 to 50 out each) was measured.
3. Attribution of the project-wide Vertex metric to this one scan. No filter by request id exists; it was attributed by time window.
4. The cr-forge-gateway VM's share of cost per scan. It was not measured, and the job env does not name the gateway.
5. Value of the secrets `GEMINI_FAST_MODEL` and `GEMINI_DEEP_MODEL`. The model ids above come from the live metric's `model_user_id`, not from the secrets.


## Step 3: Runs today (2026-10-16), one real scan per surface

Target: `jonschlinkert/is-odd` at `a80ee0d831a8ee69f1fad5b4673491847975eb26` (pinned in 02-cost-per-scan.md). Production domain: `clauderabbit.in`, measured from the repo docs:

```
$ grep -rhoE "https://[a-z0-9.-]*clauderabbit[a-z0-9.-]*" README.md CLAUDE.md | sort | uniq -c
   6 https://clauderabbit.in
```

### Scoreboard

| Surface | Command / tool | Exit | Wall time | Verdict / score | Bare "Safe"? | Result |
|---|---|---|---|---|---|---|
| Web (owner as typed) | Browser `navigate https://clauderabbit.in/jonschlinkert/is-odd` + `get_page_text` | page loaded | UNKNOWN (browser tool reports no timing) | "This repository has not been scanned yet." | n/a | FAIL |
| Web (owner the report is stored under) | Browser `navigate https://clauderabbit.in/i-voted-for-trump/is-odd` + `get_page_text` | page loaded | UNKNOWN (browser tool reports no timing) | 89 / 100, "Likely safe", "Static read" | No | PASS |
| CLI | `npx -y clauderabbit@0.1.8 version` | 0 | 4s for the first npx fetch (measured on `--version`) | `0.1.8` | n/a | PASS |
| CLI | `npx -y clauderabbit@0.1.8 scan https://github.com/jonschlinkert/is-odd` | 144 (killed) | over 78s, blocked on browser sign-in, killed manually | no verdict: "Not signed in" | n/a | FAIL (auth-gated, no unattended path) |
| Remote MCP (connected tool) | `mcp__546d4fec-...__scan {owner: jonschlinkert, repo: is-odd}` | success | UNKNOWN (tool reports no timing) | 89 / 100, "Likely safe", `fresh:false` (cache hit) | No | PASS with defect (see 3.3) |
| Remote MCP (raw HTTP) | `curl -X POST https://clauderabbit.in/mcp` initialize + tools/list, no token | HTTP 401 | 1.33s / 0.35s | `{"error":"unauthorized"}` | n/a | PASS (auth enforced); tool list UNKNOWN unauthenticated |

### 3.1 Web

Canonical path a user types:

```
navigate https://clauderabbit.in/jonschlinkert/is-odd
get_page_text ->
Title: jonschlinkert/is-odd — ClaudeRabbit safety report
jonschlinkert/is-odd
This repository has not been scanned yet. Run a free safety scan to generate its public report ...
Scan jonschlinkert/is-odd
```

The report for the same commit exists under the GitHub-redirected owner:

```
navigate https://clauderabbit.in/i-voted-for-trump/is-odd
get_page_text ->
89
OUT OF 100
Likely safe
Likely safe
Static read
i-voted-for-trump/is-odd
...
Commit hash: a80ee0d831a8ee69f1fad5b4673491847975eb26
...
Score computed by formula: 89/100 (deterministic, code-driven)
+3 [reputation] some_stars: Some community signal (361 stars).
+4 [reputation] good_sentiment: Positive community sentiment (90/100).
Auto-published at clauderabbit.in/i-voted-for-trump/is-odd · re-checked when the repo changes
```

Verdict text is "Likely safe" with "Static read" and a "What we could not verify" list. No bare "Safe". I did not click "Scan jonschlinkert/is-odd" (a form submit that triggers a production scan); the cached report covers this step's verdict check.

Defect W1: the page at the owner the user requested (`jonschlinkert`) says "not scanned yet" while a report for the identical commit exists under the redirect target owner (`i-voted-for-trump`). A user following the MCP tool's own `reportUrl` lands on the "not scanned" page (see 3.3).

### 3.2 CLI

```
$ npx -y clauderabbit@0.1.8 --version
clauderabbit — scan a public GitHub repo or npm package for a 0-100 safety
score before you install or clone it. Requires a signed-in ClaudeRabbit account
...
  help | version
EXIT=0 WALL=4s

$ npx -y clauderabbit@0.1.8 version
0.1.8
EXIT=0

$ ls ~/.clauderabbit/
ls: /Users/adhirajsingh/.clauderabbit/: No such file or directory

$ BROWSER=echo perl -e 'alarm 25; exec @ARGV' npx -y clauderabbit@0.1.8 scan https://github.com/jonschlinkert/is-odd </dev/null
Not signed in — starting sign-in…
Opening your browser to sign in:
  https://clauderabbit.in/cli-auth?port=61770
[exited with code 144]   (process 51369 still alive at etime 01:18, killed with kill)
```

Findings:
- C1: `--version` is not a recognized flag; it prints the full help text. Only the bare `version` subcommand prints `0.1.8`.
- C2: `scan` with no credentials blocks indefinitely waiting on a localhost browser callback. With stdin closed and no TTY it does not fail fast; the node child outlived a 25s SIGALRM on its npx parent and ran past 78s until killed. No CI/headless path exists without a pre-issued `login --token`.
- No credentials were entered. Verdict via CLI: UNKNOWN.

### 3.3 Remote MCP

Connected tool call:

```
mcp__546d4fec-8493-4095-bbbb-7bd0fe1c43b8__scan {"owner":"jonschlinkert","repo":"is-odd"} ->
{"owner":"i-voted-for-trump","repo":"is-odd","score":89,"verdict":"Likely safe",
 "reportUrl":"https://clauderabbit.in/jonschlinkert/is-odd","fresh":false,
 "escalationDecided":false,"sandboxActuallyRan":false,
 "commitSha":"a80ee0d831a8ee69f1fad5b4673491847975eb26","codeBehaviorFindings":[], ...
 "notVerified":["Full runtime behavior (this repo was not executed in a sandbox on this pass)", ...]}
```

Score 89 and verdict "Likely safe" match the web report for the same commit. `sandboxActuallyRan:false` with `escalationDecided:false` is consistent. No bare "Safe".

Defect M1: `reportUrl` is `https://clauderabbit.in/jonschlinkert/is-odd`, which renders "This repository has not been scanned yet" (3.1). The response's own `owner` field is `i-voted-for-trump`, where the report actually renders. The link the MCP hands an agent is dead for transferred/renamed repos.

Raw endpoint:

```
$ curl -sS -m 20 -X POST https://clauderabbit.in/mcp -H 'content-type: application/json' \
   -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
{"error":"unauthorized"}
HTTP=401 TIME=1.330644s

$ curl ... -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
{"error":"unauthorized"}
HTTP=401 TIME=0.351966s
```

The endpoint rejects unauthenticated `initialize` and `tools/list` with HTTP 401. The 401 body is plain JSON, not a JSON-RPC error object, and carries no `WWW-Authenticate` excerpt in this capture (headers were not dumped). Unauthenticated tool list: UNKNOWN.

### UNKNOWNs

- Web page wall time (browser tool exposes no timing).
- MCP connected-tool wall time (tool exposes no timing).
- CLI scan verdict and wall time (blocked on sign-in; no credentials entered by rule).
- `/mcp` tools/list contents without a token (HTTP 401).
- Fresh-scan path on any surface: every verdict today is a cache hit (`fresh:false`); no new scan was submitted.


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


## 6. UI: screens, status and Lighthouse

Date: 2026-10-16. Production host: https://clauderabbit.in.

### 6.1 Route inventory

Source: `find . -path ./node_modules -prune -o -name page.tsx -print` (repo root, excluding `.claude/worktrees/*` copies) cross-checked against `04-parts-map.md` E1.

```
./app/page.tsx
./app/privacy/page.tsx
./app/terms/page.tsx
./app/cli-auth/page.tsx
./app/oauth/authorize/page.tsx
./app/[owner]/[repo]/page.tsx
./app/npm/[...pkg]/page.tsx
```

7 user-facing pages. Dynamic routes were probed with concrete values: `[owner]/[repo]` as `/i-voted-for-trump/is-odd`, `npm/[...pkg]` as `/npm/is-odd`.

### 6.2 HTTP status and response time (MEASURED)

Command:

```
for p in / /privacy /terms /cli-auth /oauth/authorize /i-voted-for-trump/is-odd /npm/is-odd; do printf '%-28s ' "$p"; curl -s -o /dev/null -m 30 -w '%{http_code} %{time_total}\n' "https://clauderabbit.in$p"; done
```

Raw output:

```
/                            200 0.272273
/privacy                     200 0.470505
/terms                       200 0.412347
/cli-auth                    200 0.167239
/oauth/authorize             200 0.608260
/i-voted-for-trump/is-odd    200 1.189230
/npm/is-odd                  200 1.066306
```

| Page file | Production URL | HTTP | time_total (s) |
|---|---|---|---|
| `app/page.tsx` | https://clauderabbit.in/ | 200 | 0.272 |
| `app/privacy/page.tsx` | https://clauderabbit.in/privacy | 200 | 0.471 |
| `app/terms/page.tsx` | https://clauderabbit.in/terms | 200 | 0.412 |
| `app/cli-auth/page.tsx` | https://clauderabbit.in/cli-auth | 200 | 0.167 |
| `app/oauth/authorize/page.tsx` | https://clauderabbit.in/oauth/authorize | 200 | 0.608 |
| `app/[owner]/[repo]/page.tsx` | https://clauderabbit.in/i-voted-for-trump/is-odd | 200 | 1.189 |
| `app/npm/[...pkg]/page.tsx` | https://clauderabbit.in/npm/is-odd | 200 | 1.066 |

7 of 7 routes return 200. Static and auth pages answer in 0.167 to 0.608 s; the two report pages (database read per request) answer in 1.066 to 1.189 s, single sample each from this laptop.

### 6.3 Lighthouse via PageSpeed Insights API (UNKNOWN)

Command (4 calls in parallel, JSON saved to the session scratchpad as `psi-{home,report}-{mobile,desktop}.json`):

```
B='https://www.googleapis.com/pagespeedonline/v5/runPagespeed?category=performance&category=accessibility&category=best-practices&category=seo'
curl -s -m 110 "$B&strategy=mobile&url=https://clauderabbit.in/" -o psi-home-mobile.json &
curl -s -m 110 "$B&strategy=desktop&url=https://clauderabbit.in/" -o psi-home-desktop.json &
curl -s -m 110 "$B&strategy=mobile&url=https://clauderabbit.in/i-voted-for-trump/is-odd" -o psi-report-mobile.json &
curl -s -m 110 "$B&strategy=desktop&url=https://clauderabbit.in/i-voted-for-trump/is-odd" -o psi-report-desktop.json &
wait
jq -c '{err:.error.message, perf:...performance.score, a11y:..., bp:..., seo:..., lcp:..., cls:..., tbt:...}' psi-*.json
```

Raw output (identical for all four files):

```
== psi-home-desktop.json
{"err":"Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'pagespeedonline.googleapis.com' for consumer 'project_number:583797351490'.","perf":null,"a11y":null,"bp":null,"seo":null,"lcp":null,"cls":null,"tbt":null}
== psi-home-mobile.json
{"err":"Quota exceeded ...","perf":null,...}
== psi-report-desktop.json
{"err":"Quota exceeded ...","perf":null,...}
== psi-report-mobile.json
{"err":"Quota exceeded ...","perf":null,...}
```

| Page | Strategy | Perf | A11y | Best practices | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|---|
| / | mobile | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| / | desktop | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| /i-voted-for-trump/is-odd | mobile | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| /i-voted-for-trump/is-odd | desktop | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

Cause: the keyless PSI endpoint shares a daily quota on consumer project 583797351490 and that quota is exhausted. Unblock path for Phase 2: rerun the same four calls with `&key=<PSI API key>` from the team's GCP project.

### 6.4 UNKNOWNs

- All Lighthouse category scores (performance, accessibility, best practices, SEO) for `/` and `/i-voted-for-trump/is-odd`, mobile and desktop: PSI quota error above.
- LCP, CLS, TBT for the same four runs: same cause.


## 07 Zero-context review

Reviewed `docs/runs/koenigsegg-audit.md` (1,049 lines) on 2026-10-16. Each number in "Top line" and "Findings that need action" was checked against the evidence block it cites lower in the same file, the arithmetic was recomputed, three live facts were rechecked, and the whole file was scanned for banned hedge words and em dashes.

### Live spot-rechecks (this session)

```
$ gcloud compute instances describe cr-forge-gateway --zone us-central1-a --project gen-lang-client-0062239756 --format='value(machineType,status)'
https://www.googleapis.com/compute/v1/projects/gen-lang-client-0062239756/zones/us-central1-a/machineTypes/e2-micro	RUNNING

$ sed -n 435,445p supabase/functions/_shared/vertex.ts
  }

  const text = (candidate.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  const result: GenerateResult = { text, usage: data.usageMetadata, calls: 1 };

  if (opts.json) {
    if (candidate.finishReason === "MAX_TOKENS") {
      throw new Error(

$ curl -s -m 15 -o /dev/null -w '%{http_code}' https://clauderabbit.in/
200
```

Line 441 is the `usage: data.usageMetadata` line, as finding 1 cites. Extra check for finding 2:

```
$ sed -n 598,608p supabase/functions/_shared/vertex.ts
// --- Conversational Agents (Dialogflow CX) generator backend ----------------
// One agent (CR_DF_AGENT_ID, location global) carries two generators whose text
// prompt is exactly "$system $prompt": `cr-fast` (gemini-3.1-flash-lite — the same
// model the direct fast read uses — temperature 0.2, 8192-token limit) fired by the
// custom event `cr_fast`, and `cr-deep` (gemini-2.5-flash, temperature 0.2, 8192)
```

Line 605 names `gemini-2.5-flash`, and it does so inside the Dialogflow CX generator comment. In that backend the generator config sets the model, not the secret.

### Arithmetic recheck

```
$ python3 -c "...rates: flash-lite $0.25/$1.50, 3.5-flash $1.50/$9.00 per 1M; vCPU-s 0.000018, GiB-s 0.000002"
fast 0.00055275 0.0007725 0.00132525
a 0.0018915 b 0.035262 c 0.0038625 0.007725 models 0.041016 0.0448785
cr 0.0035532000000000003 0.0007896 0.0043428
tot 0.0453588 0.0492213 share 0.7857214479093553 0.8597132826214161 0.08823009550743276 0.09574327363157756
149.869205 40683.0 772 19488
98.717994 26.782167 125.500161

$ python3 -c "print(0.008376*730, 0.04*10, 0.005*730, 0.008376*730+0.4+0.005*730)"   (from section 01, recomputed)
6.11448 0.4 3.65 10.16448
```

### Verdict table

| Claim | Location | Verdict | Correct value with source |
|---|---|---|---|
| All 7 page routes HTTP 200 | Top line, What runs | MATCH | 7/7 = 200, section 6.2 raw output; live `/` = 200 this session |
| MCP `scan` returned score 89 | Top line, What runs | MATCH | `"score":89`, section 3.3 |
| `cr-detonation-zzdnv` succeeded | Top line, What runs | MATCH | `succeededCount` 1, section 02b.2 |
| 5 edge functions ACTIVE | Top line, What runs | MATCH | scan, attach-forensics, deep-queue, oauth-token, billing-guard ACTIVE, section 04 E2 |
| Typed owner page says "not scanned yet"; report under `/i-voted-for-trump/is-odd`; MCP `reportUrl` points at typed URL | Top line, What fails | MATCH | section 3.1 and 3.3 raw output |
| CLI 0.1.8 `scan` blocks on browser sign-in, no stored token | Top line, What fails | MATCH | `ls ~/.clauderabbit/` no such dir; "Not signed in", exit 144 after kill, section 3.2 |
| Vercel $0, Hobby, `costs_not_found` Sep 1 to Oct 16 | Top line | MATCH | `{'plan': 'hobby', 'status': 'active'}` and 404 `costs_not_found`, sections 01 and 01b |
| VM idle $3.65 to $10.16 (e2-micro, 10 GB pd-standard, ephemeral IPv4) | Top line | MATCH on arithmetic and resource facts; UNSUPPORTED on rates | 6.11 + 0.40 + 3.65 = 10.16 recomputed; e2-micro RUNNING rechecked live. Section 01 states the three rates were not fetched this session, so under the evidence rule the dollar figures rest on unmeasured inputs |
| GCP per service UNKNOWN (Budget API disabled, no BigQuery export) | Top line | MATCH | `reason: SERVICE_DISABLED`; BigQuery API disabled, section 01 lines 85 to 89 |
| Supabase UNKNOWN (MCP reaches Pockit org only) | Top line | MATCH | `list_organizations` returns only Pockit, section 01 |
| GCP credits UNKNOWN (sign-in wall) | Top line | MATCH | section 01b, credits and reports pages behind Google sign-in |
| Cached $0, 2.35 s | Top line | MATCH | run2 `wall=2.345094s`, `"cached":true`, section 02 |
| Fast $0.00133, 6.95 s, 2,211 in, 515 out, gemini-3.1-flash-lite | Top line | MATCH | 0.00055275 + 0.0007725 = 0.00132525; `totalTokens: 2211`; 9 + 506 = 515; run1 `wall=6.946099s` |
| Deep total $0.0454 to $0.0492 | Top line | MATCH | 0.0453588 to 0.0492213 |
| Deep wall 149.87 s | Top line | MATCH | 17.813967 + 132.055238 = 149.869 |
| Deep models $0.0411 to $0.0449 | Top line; also 02b.5 table | MISMATCH | Low end is 0.0018915 + 0.035262 + 0.0038625 = 0.041016, so **$0.0410**. The 0.0411 comes from summing already-rounded parts |
| Cloud Run $0.00434 for 197.4 vCPU-s and 394.8 GiB-s | Top line | MATCH | 98.717994 s x 2 and x 4; 0.0035532 + 0.0007896 = 0.0043428 |
| 3.5-flash read 78% of deep model cost; Cloud Run 9% of deep total | 02b.5 | MATCH | 0.7857 at the upper bound; Cloud Run 8.8% to 9.6% |
| `usageMetadata` never persisted, `vertex.ts:441` | Finding 1 | MATCH | line 441 rechecked live; section 02 code map: never written to a table nor returned |
| Deep model in production traffic is 3.5-flash | Finding 2 | MATCH | `gemini-3.5-flash input [('09:31','16240'),('09:32','3248')]`, section 02b.3 |
| Code names `gemini-2.5-flash` at `vertex.ts:605` | Finding 2 | MATCH | line 605 rechecked this session |
| "The secret `GEMINI_DEEP_MODEL` decides it" | Finding 2 | UNSUPPORTED | Line 605 is the Dialogflow CX `cr-deep` generator comment; that backend takes its model from the generator, not the secret. The backend switch `CR_MODEL_BACKEND` value and the secret value were never read (02b UNKNOWN 5) |
| Owner-rename bug; MCP returns broken URL | Finding 3 | MATCH | section 3.1 and 3.3 |
| Budget API disabled; `clauderabbit-credit-guard` unconfirmed | Finding 4 | MATCH on fact; banned word | text uses "could not be confirmed" |
| `scan_usage` and `check_and_increment_scan_limit` 0 callers; `cleanup_oauth` 0 callers; `GEMINI_API_KEY` 0 refs; `cli/` `@modelcontextprotocol/sdk` and `zod` 0 imports; `clauderabbit-mcp` E404 | Finding 5 | MATCH | section 05 D4 to D7 (`GEMINI_API_KEY 0`, `@modelcontextprotocol/sdk 0`, `zod 0`), section 04 E8 `E404 Not Found` |
| `/mcp` 401 body is plain JSON, not JSON-RPC | Finding 6 | MATCH | `{"error":"unauthorized"}` `HTTP=401`, section 3.3 |

### Banned words and em dashes

```
$ grep -niwE 'likely|probably|may|might|could|seems|appears|roughly|I believe|should be' docs/runs/koenigsegg-audit.md
25:4. The Cloud Billing Budget API is disabled on the project, so the `clauderabbit-credit-guard` budget could not be confirmed. (01)
85:ERROR: (gcloud.billing.budgets.list) ... (or it may not exist) ...           [raw output]
564, 567, 590, 591, 603, 642, 649: "Likely safe" / "What we could not verify"     [quoted product text]
$ grep -n '—' docs/runs/koenigsegg-audit.md
577, 611, 625, 858, 861   [all inside raw output blocks]
```

One violation outside quoted output: line 25 ("could"). No em dash outside raw output.

### Consistency note

Section 3 scoreboard (line 563) labels `jonschlinkert/is-odd` "Web (canonical GitHub path)", while the Top line and finding 3 call `i-voted-for-trump` the canonical owner. GitHub redirects to `i-voted-for-trump`, so the Top line usage is the correct one and the scoreboard label is the outlier.

### Corrections

1. Top line, deep row, and 02b.5 table: replace `$0.0411 to $0.0449` with `$0.0410 to $0.0449`.
2. Finding 2: replace "The secret `GEMINI_DEEP_MODEL` decides it." with "On the vertex backend the secret `GEMINI_DEEP_MODEL` sets the model; on the dialogflow backend the `cr-deep` generator sets it. Which backend `CR_MODEL_BACKEND` selects, and the secret's value, are UNKNOWN."
3. Finding 4: replace "so the `clauderabbit-credit-guard` budget could not be confirmed." with "so the `clauderabbit-credit-guard` budget is unconfirmed."
4. Top line, VM row: replace the value with "$3.65 to $10.16 (e2-micro, 10 GB pd-standard, ephemeral IPv4; lower bound if it holds the free-tier slot; rates are unfetched list rates, so the dollar range is UNKNOWN until cloud.google.com/compute/vm-instance-pricing is fetched)".
5. Line 563 scoreboard label: replace "Web (canonical GitHub path)" with "Web (owner as typed)".

Lead applied all five corrections above (rounding, GEMINI_DEEP_MODEL attribution, VM rate provenance, banned word, scoreboard label).
