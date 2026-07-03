# COST.md — Claude Rabbit unit economics

Real numbers, computed from real measured usage this session plus current, publicly
verified GCP/Vertex pricing — not projections carried over from before the Cloud Run
migration (that model, still described in parts of the PRD as a historical estimate,
used DeepSeek/Brave/K2.7 pricing for a different, not-yet-shipped stack). Where a number
below is measured, it says so; where it's estimated, it says that too and states the
assumption — never presented as more certain than it is.

---

## 1. The headline: currently $0 revenue against a real, ticking cost clock

Per `docs/INFRASTRUCTURE.md` §9 and CLAUDE.md: the originally planned ad-gated revenue
model was built, then deliberately removed as fake scaffolding (a demo ad, not a real
integration) that contradicted the product's own no-fabricated-data rail. **There is
currently no monetization mechanism in the shipped product.** Every number below is pure
cost, offset by nothing. This is the real, open gap in "self-sustaining without debt" —
stated plainly, not papered over.

**The credit runway:** $300 GCP free-trial credit, active, expires **2026-09-24**. After
that date, every dollar below is real out-of-pocket spend with zero revenue against it.

---

## 2. Real measured Cloud Run detonation cost (the deep path)

**Measured directly from this session's real `cr-detonation` Job executions** (17 real
executions, `gcloud run jobs executions list`, start/completion timestamps):

| | Value |
|---|---|
| Executions measured | 17 |
| Shortest | 78.0s |
| Longest | 159.6s |
| **Average duration** | **116.9s** (~117s) |
| Resources per execution | 2 vCPU, 4 GiB memory (Gen2) |

**Real, current Cloud Run pricing** (Tier 1 region `us-central1`, "CPU always
allocated" — the correct tier for Jobs, which bill for the full task duration
regardless of request activity, not the cheaper "allocated only during request
processing" tier services can use): **$0.000018 / vCPU-second**, **$0.000002 /
GiB-second** (cloud.google.com/run/pricing, verified July 2026).

**Cost per detonation at the measured 117s average:**
- CPU: 2 vCPU × 117s × $0.000018 = **$0.00421**
- Memory: 4 GiB × 117s × $0.000002 = **$0.00094**
- **Total: ≈ $0.0051 per deep-path scan**

**Real finding: this session's actual Cloud Run compute cost was $0.** Cloud Run's free
tier is 180,000 vCPU-seconds and 360,000 GiB-seconds per project per month. This
session's real total: 17 × 117s × 2 vCPU ≈ **3,978 vCPU-seconds** and 17 × 117s × 4 GiB ≈
**7,956 GiB-seconds** — both well under 3% of the free monthly allowance. At the volumes
seen so far, Cloud Run detonation compute is effectively free. The $0.0051/scan figure
above is what it becomes once volume clears the free tier, not what was actually billed.

---

## 3. Real measured shared-gateway cost (fixed, not per-scan)

The NVA gateway (`cr-forge-gateway`, `e2-small`, us-central1-a) runs continuously —
every concurrent detonation's egress routes through it, so its cost doesn't scale
per-scan the way Cloud Run compute does. It's a **fixed monthly cost regardless of scan
volume**, real and running today.

**Real, current e2-small on-demand pricing:** ≈ **$0.02/hour** → **≈ $12.23/month**
continuous (economize.cloud, verified July 2026; Compute Engine's automatic Sustained
Use Discounts could reduce this somewhat for a VM running the full month — not verified
exactly, so treat $12.23/month as a conservative upper bound, not a floor).

This is the real structural cost of the current architecture: **~$12/month whether the
product scans 10 repos or 10,000**, on top of whatever the Cloud Run compute and Vertex
AI usage costs at that volume.

---

## 4. Estimated Vertex AI (Gemini) cost — labeled estimate, not measured

Real token-usage numbers were **not** captured this session (the scan edge function's
Vertex wrapper, `supabase/functions/_shared/vertex.ts`, does surface real
`usageMetadata` per call, but nothing currently logs or persists it — a real
instrumentation gap, noted below as a concrete next step rather than something to
estimate around forever). The figures below are estimates from typical input/output
sizes at real, current Vertex pricing, not measured actuals.

**Real, current Vertex Gemini pricing** (verified July 2026):
- `gemini-3.1-flash-lite` (fast path): $0.25 / 1M input tokens, $1.50 / 1M output tokens.
- `gemini-3.5-flash` (deep-path agentic read): $1.50 / 1M input tokens, $9.00 / 1M output
  tokens.

**Fast-path estimate** (~95% of scans): the fast path reads only static-flagged regions,
not the whole repo — assume ~4,000 input tokens (flagged code + prompt) and ~500 output
tokens (structured JSON verdict):
- Input: 4,000/1,000,000 × $0.25 = $0.0010
- Output: 500/1,000,000 × $1.50 = $0.00075
- **≈ $0.0018 per fast-path scan**

**Deep-path estimate** (~5% of scans, the 3-agent harness read + agentic fallback):
assume ~30,000 input tokens across the install/runtime/payload agents and ~3,000 output
tokens for their combined analysis:
- Input: 30,000/1,000,000 × $1.50 = $0.0450
- Output: 3,000/1,000,000 × $9.00 = $0.0270
- **≈ $0.072 per deep-path scan (Vertex only, before Cloud Run compute)**

**Recommended next step, not done here:** log `usageMetadata` from every real Vertex
call (the data is already returned, just not persisted) so this section can be replaced
with real measured token counts instead of estimates.

---

## 5. Blended real + estimated cost per scan

| Path | Share | Cloud Run (real, current volume) | Vertex (estimated) | Total |
|---|---|---|---|---|
| Fast path | ~95% | $0 (no detonation) | ~$0.0018 | **~$0.0018** |
| Deep path | ~5% | $0 (within free tier at current volume) | ~$0.072 | **~$0.072** |

**Blended, at current volume:** 0.95 × $0.0018 + 0.05 × $0.072 ≈ **$0.0053 per scan** —
plus the fixed ~$12.23/month gateway cost, independent of scan count.

Once Cloud Run's free tier is exhausted (a real future point, not reached yet), add
~$0.005/deep-path scan for compute: blended cost per scan rises to ≈ **$0.0056**.

---

## 6. What this means, honestly

- **Per-scan cost is genuinely tiny** — fractions of a cent, even before any caching
  benefit (a cache hit on an already-scanned, unchanged repo costs $0 in compute — see
  `docs/claude-rabbit-north-star.md`'s "never do the same work twice" section).
- **The real structural cost is the fixed ~$12/month gateway**, not per-scan compute —
  this holds even at zero traffic.
- **There is no revenue offsetting any of this.** At the volumes exercised this session,
  the $300 credit comfortably covers everything through its 2026-09-24 expiry. The open
  question this doc does not resolve — because it's a product decision, not a cost
  calculation — is what happens after that date, or if real traffic (the stated "then
  viral" goal) pushes past free-tier and credit coverage before a monetization mechanism
  exists. See CLAUDE.md's "Login / limits / monetization" section for the current,
  explicit status of that gap.
