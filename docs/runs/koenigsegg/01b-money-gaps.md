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
