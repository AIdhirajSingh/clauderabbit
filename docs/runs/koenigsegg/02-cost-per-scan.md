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
