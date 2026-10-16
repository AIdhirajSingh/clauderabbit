# COST.md: ClaudeRabbit 2.0 unit economics

Every fresh 2.0 scan runs the code, so every fresh scan pays for sandbox seconds and model tokens. The numbers
below are computed from published prices (recorded with sources in `docs/2.0/DESIGN.md` section 12) and from the
limits in the code. They are labelled **computed**. Measured per-scan cost comes from the labeled-set run on key
day (`docs/runs/2.0-labeled-results.md`, which records timings per scan) and replaces these rows once it exists.

---

## 1. Revenue

Every response now carries an ad (DESIGN.md section 8.3): Google AdSense on the web (test mode until the owner
sets `NEXT_PUBLIC_ADSENSE_TEST=off` with approved IDs) and a house ad on CLI and MCP. AdSense revenue per
thousand impressions is not known until real traffic runs with test mode off, so this file states no revenue
figure. The 1.x Google Cloud credit no longer funds anything: 2.0 runs on Vercel, Supabase, E2B and OpenAI.

---

## 2. Sandbox cost per fresh scan (computed)

E2B price: $0.000014 per vCPU-second plus $0.0000045 per GiB-second. Both 2.0 sandboxes use the template default
of 2 vCPU and 4 GiB, which is $0.0000460 per sandbox-second.

| Case | Sandbox seconds | Cost |
|---|---|---|
| Detonation at the design budget (8.3 s, DESIGN.md 2.2) | 8.3 | $0.00038 |
| Analysis sandbox at its budget (4.5 s) | 4.5 | $0.00021 |
| Detonation at its total hard deadline (30 s) | 30 | $0.00138 |
| A sandbox reaped at `sandboxTimeoutMs` (90 s, `lib/engine/config.ts`) | 90 | $0.00414 |

Design-budget scan, both sandboxes: about **$0.0006**. Worst case, both sandboxes reaped at 90 s: **$0.0083**.

## 3. Model cost per fresh scan (computed)

`gpt-6-luna` price: $0.10 per 1M input tokens, $0.50 per 1M output tokens. Four calls per fresh scan: three readers
capped at 2,000 output tokens each (`READER_MAX_OUTPUT_TOKENS`) and one writer capped at 1,200
(`WRITER_MAX_OUTPUT_TOKENS`), so output is at most 7,200 tokens, $0.0036.

| Assumed tokens (in / out) | Cost |
|---|---|
| 30,000 / 4,000 | $0.0050 |
| 60,000 / 8,000 (output above the cap, upper bound) | $0.0100 |

## 4. Cached scans

A cache hit (same commit SHA, or npm version plus integrity) reads Supabase rows and replays the stored event
stream. It starts no sandbox and calls no model.

## 5. Daily spend floor

`scan_budget_charge` stops fresh scans when either daily cap is reached. At the defaults:

| Cap | Default | Cost at the cap |
|---|---|---|
| `CR_DAILY_SANDBOX_SECONDS_CAP` | 20,000 s | $0.92 |
| `CR_DAILY_MODEL_TOKENS_CAP` | 20,000,000 tokens | $2.00 if all input, $10.00 if all output |

So the default floor bounds variable spend at about $11 per day. Raise the caps in Vercel env as revenue allows.

## 6. Fixed costs

Vercel (function duration up to 120 s per scan on the configured `maxDuration`), Supabase (database, auth,
Realtime) and E2B plan fees are account-level and not per scan; they are whatever plan each account is on. E2B
Hobby allows 20 concurrent sandboxes; each fresh scan holds two, so Hobby supports 10 concurrent fresh scans
before the engine returns 503 with `retry_after`.
