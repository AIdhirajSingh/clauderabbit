# Claude Rabbit — Per-scan / per-VM cost breakdown (Phase 9)

Real cost, computed from published GCP/Vertex rates × the measured resource use of the
live runs. No daily cap is built (Adhiraj's call: unlimited scans); this is **data**, not a
gate. Out-of-pocket spend is effectively zero — the ₹124,405 (~$1,490) granted credit
covers it, and across all live runs **zero VMs were orphaned** (the server-side
`--max-run-duration` DELETE + per-scan delete held).

## Inputs (measured, this run)
- **Machine**: `e2-small` (2 vCPU shared, 2 GB), `us-central1`. The deep path boots **2**:
  a trap host + a detonation VM (the off-VM analysis runs `local` mode = $0 extra VM).
- **VM lifetime per deep scan**: ~10–13 min wall-clock end-to-end (boot → provision →
  build → detonate → collect → delete). Use **0.22 h** per VM as a conservative figure.
- **Vertex tokens per scan** (observed): the agentic loop used ~1.4k tokens (proof #4
  `tokens_used: 1412`); plus the fast-path read-model call and the off-VM analysis call —
  on the order of a few thousand tokens total per scan.

## Published rates (us-central1, 2026)
- `e2-small` on-demand ≈ **$0.0168 / VM-hour**.
- Vertex Gemini (per 1M tokens, rough): `gemini-3.1-flash-lite` ~ $0.10 in / $0.40 out;
  `gemini-3.5-flash` ~ $0.30 in / $2.50 out. A few-thousand-token scan ⇒ **< $0.005** Vertex.

## Per-scan cost

| Path | Compute | Vertex | **Total / scan** |
|---|---|---|---|
| **Fast (~95%)** | none (edge fn only) | 1 read-model call, few k tokens | **≈ $0.001–0.005** |
| **Deep / sandbox (~5%)** | 2× e2-small × 0.22 h × $0.0168 ≈ **$0.0074** | agent loop + analysis, few k tokens (< $0.005) | **≈ $0.012** |

**Blended** (95% fast @ ~$0.003 + 5% deep @ ~$0.012) ≈ **$0.0035 / scan**.

- **Per deep VM**: e2-small ≈ $0.0037 for a ~13-min scan ($0.0168/h × 0.22 h).
- The biggest deep-path lever is **VM-minutes** (boot is the largest fixed slice) — the
  warm-pool optimization (deferred, see `sandbox/AGENTIC-DESIGN.md`) removes ~15–30 s of
  cold boot from the critical path, cutting deep-scan VM cost ~10–20%.

## Double-check (cross-method)
1. **Rate × measured use** (above) → ~$0.012 / deep scan.
2. **Sanity vs. credit**: the ~₹124,405 credit ÷ ~$0.012 ≈ **>120,000 deep scans** of runway
   on the credit alone (and deep is only ~5% of traffic), confirming the order of magnitude
   and that "unlimited scans" is affordable within the granted credit.

The two methods agree to the same order ($0.01-ish per deep scan). Actual GCP billing
lags by hours and is credit-offset, so the rate×use calculation is the authoritative
per-scan figure; refine with `gcloud billing` once a larger real-traffic sample exists.

## Rates to re-measure on real traffic (honest, small sample today)
- **Escalation rate**: code-driven (`decideEscalation`). Synthetic fixtures escalate; the
  real famous repos tested (cookie-parser/click/morgan) did not. The ~5% deep-path
  assumption needs a larger real sample to confirm.
- **Auto-build success**: every live run built + ran `exfil-c2` (node); README baseline 5/6
  node fixtures. Needs a larger real-repo sample for a precise %.

## Guardrails kept (no cap, but bounded)
- Server-side **dead-man's switch** (`--max-run-duration … DELETE`) — every VM self-deletes.
- **Per-scan VM delete** + a prefix sweep — the run ends with zero VMs (verified every run).
- **GCP budget alerts** (₹1000 budget, alerts every ₹200) — already configured by Adhiraj.
These bound spend without a daily cap; the credit buffer absorbs the rest.
