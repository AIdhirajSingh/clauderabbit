# ClaudeRabbit 2.0: unit economics per scan

Goal: every scan earns about 1 paisa for each second it runs. A scan costs about 0.4 paise a second.

## What is measured, per scan

`v2.scan_economics` (migration `20261022000001_v2_scan_economics.sql`), one row per run:

| column | meaning |
|---|---|
| `seconds` | the run's wall time, `finished_at - started_at` |
| `cost_paise` | the run's cost ledger (`v2.scan_runs.cost.total_inr`) × 100: models, sandbox, search |
| `ads_shown` | GPT impressions rendered on that run's scan screen (fresh, stored or replayed), reported by `POST /api/scan/ads`, at most one per 10 s per run |
| `ecpm_inr` | the estimate's eCPM, `v2.ad_settings.ecpm_inr`, default ₹100 per 1,000 impressions (change the row to change every estimate) |
| `est_earnings_paise` | `ads_shown × ecpm_inr / 10` (₹100 eCPM = 10 paise an impression) |
| `est_paise_per_second` | `est_earnings_paise / seconds` |

Ads are Google Publisher Tag through Google's published sample units, so impressions are real GPT renders but no
money is earned; the earnings column is an estimate at the configured eCPM, not revenue.

## How the slot earns

The scan screen's slot is a GPT standalone display slot refreshed every 10 s (`lib/ads-config.ts` `refreshMs`) for as
long as the scan screen is open. At ₹100 eCPM one impression is 10 paise, so one every 10 s is 1 paisa a second, the
goal, against a cost of about 0.4 paise a second. The counter takes at most one impression per run every 8 s.

10 s is faster than Google Ad Manager's guidance (refresh no faster than 30 s, and declare refreshed inventory). Before
real units go live, the slot must be declared as refreshed inventory in Ad Manager, and the realised eCPM on refreshed
impressions should be checked against the ₹100 assumption in `v2.ad_settings`. A refresh faster than about 10 s is
not used: an impression needs time in view to count as viewable, and faster refresh reads as invalid traffic.

## Totals (preview, 2026-10-22, all v2 runs in the last 30 days)

170 runs, 7,096.8 s of scanning, 3,002.6 paise of cost (0.42 paise a second on average), 6 ads counted, 60 paise
estimated. Ads were counted only from 2026-10-22 11:22 IST (this change); every earlier run shows 0 ads, so the
earnings side of the totals is not yet meaningful. Per-scan numbers for this round's scans are in
`docs/runs/2.0-keyday.md` step 29.

Query:

```sql
select count(*), sum(seconds), sum(cost_paise), sum(ads_shown), sum(est_earnings_paise),
       sum(est_earnings_paise) / nullif(sum(seconds), 0) as paise_per_second
from v2.scan_economics where started_at > now() - interval '30 days';
```
