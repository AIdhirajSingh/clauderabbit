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
