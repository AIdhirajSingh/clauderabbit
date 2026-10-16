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
