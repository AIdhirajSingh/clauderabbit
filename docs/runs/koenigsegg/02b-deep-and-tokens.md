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
