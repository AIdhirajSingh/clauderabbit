# Claude Rabbit — System Design & PRD

> The execution north star. Everyone else reads the code. We run it.
> This document defines what we build and how it fits together. If a feature isn't here, it isn't in v1.

---

## 1. Product definition

Claude Rabbit is a free web tool. The first scan is free with no login and no ad. A user pastes any public GitHub repo, fork, or dependency. The system analyzes it — reading the code, checking reputation, and *running it in a sandbox when warranted* — and returns a single 0–100 safety score with a plain-language report. The report is public, permanently hosted at `/owner/repo`, shareable, and embeddable as a trust badge. After the first free scan, login is required to continue, and a rewarded ad gates each further result (fresh or cached).

**The wedge:** every other tool (Socket, static scanners, the free repo-checkers) only *reads* code. We run it. That is the one thing nobody ships to the individual developer, and it is the only feature we protect at all costs.

**Audience:** anyone about to run a stranger's code — students, hobbyists, vibe-coders, devs cloning from tutorials or take-home interview tasks, and AI coding agents that clone-and-run unattended. Individuals and companies alike; no narrowing.

**Framework:** Next.js (App Router) for the entire web layer — homepage, report pages (server-rendered for SEO), and API routes that orchestrate scans.

---

## 2. Goals & non-goals (v1)

**Goals**
- Paste-a-URL → fast safety verdict. First scan free, no login, no ad; login required after that.
- Two-speed analysis: cheap static + reputation read for most repos, dynamic sandbox execution for the suspicious minority.
- Public, SEO-indexed report per repo state, with a one-click trust badge.
- Operationally self-sustaining on ads alone (one rewarded ad gates each result after the free first scan), even at zero cache, via the escalation gate.
- Honest verdicts that never state a bare "Safe."
- Simple login plus a dashboard (scan history, profile, stats) for returning users after the first scan.

**Non-goals (not in v1 — do not build)**
- No code-quality / CodeRabbit-style review, system-design audit, or refactoring.
- No subscriptions. No accounts beyond the simple login. No elaborate dashboard beyond scan history, profile, and stats.
- No Hugging Face / model scanning.
- No leaderboard moderation tooling beyond a basic display.

These are roadmap. They live in the founder's head, not in v1 scope.

**Shipped beyond the original v1 plan (scope expansion, now real).** A **CLI** (`claude-rabbit-cli` — `scan`/`report` plus `npm-install`/`pnpm-install`/`git-clone` wrappers and opt-in shell hooks) and an **MCP server** (`scan_repo`/`get_report` tools over stdio for AI coding tools) exist in the repo (`cli/`, `mcp-server/`). They were added under a direct instruction authorizing them as the primary growth channel for a free, ad-free product. Each is a thin distribution layer over the same server-side scan pipeline — same rails, same never-a-bare-"Safe" honesty — not a separate product. (A Claude Code plugin approach was tried and dropped; the CLI and MCP server are the only supported distribution surfaces.)

---

## 3. System architecture

The system is a **two-speed funnel**. ~95% of scans resolve on the fast path; ~5% escalate to the deep path. This ratio is the load-bearing assumption behind both performance and economics.

> **Model layer, as shipped.** The component names below (DeepSeek, Brave, Kimi K2.7, OpenCode) are the *target* production models. The **current shipped** model layer is all-Gemini via Vertex AI — `gemini-3.1-flash-lite` (fast path) and `gemini-3.5-flash` (deep/agent) — behind a clean swap seam. Everything structural (the funnel, the escalation gate, the code-computed scoring, the cache) is real and does not change when the target models drop in. See §5 and `docs/INFRASTRUCTURE.md`.

```
                    ┌─────────────────────────────┐
   Paste URL ─────► │  Next.js API route (orchestr)│
                    └──────────────┬──────────────┘
                                   ▼
                       ┌───────────────────────┐
                       │  1. CACHE CHECK        │  by commit SHA
                       │     hit → serve report │──► instant, ~$0
                       └───────────┬───────────┘
                                   ▼ miss
        ┌──────────────────────── FAST PATH (~95%) ────────────────────────┐
        │  2. Static scanners (ClamAV / Semgrep / YARA)  ── flags regions   │
        │  3. Reputation (DeepSeek calls Brave) ── owner age, stars, sentim │
        │  4. DeepSeek reads ONLY flagged regions → comprehends → scores    │
        │  5. Confidence check ─────────────────────────────────────────┐  │
        └───────────────────────────────────────────────────────────────┼──┘
                          confident clean → SHIP VERDICT                  │
                                   ▼ suspicious / "can't tell"            │
        ┌──────────────────────── DEEP PATH (~5%) ─────────────────────────┐
        │  6. Dispatch to the warm sandbox host (queue if both slots busy) │
        │  7. OpenCode harness + Kimi K2.7 agent(s)/swarm:                  │
        │       clone → build → run → adversarial input → observe behavior  │
        │  8. Reset: destroy the microVM, reimage to square-1 (abuse protect)│
        └───────────────────────────────┬──────────────────────────────────┘
                                         ▼
                       ┌───────────────────────────┐
                       │ 9. Blend → 0–100 score     │
                       │ 10. Structured findings    │
                       │ 11. Generate report        │
                       │     (frontend, design.md)  │
                       │ 12. Persist + cache by SHA │
                       │ 13. Public /owner/repo page│
                       └───────────────────────────┘
```

### Components

**Web layer (Next.js).** Homepage with the global input field, live activity feed, viral repos, and the dangerous-repos leaderboard. Server-rendered `/owner/repo` report pages (the SEO surface). API routes orchestrate scans and serve cached reports. URL trick: swapping the domain on any GitHub URL pulls up that repo's report.

**Orchestrator (Next.js API route + queue).** Receives a scan request, runs the cache check, drives the fast path, evaluates the escalation gate, and dispatches deep scans to the single warm sandbox host — queuing honestly (real FIFO, live position/wait, honest timeout) when both detonation slots are busy. Returns the blended verdict.

**Static scan layer.** Off-the-shelf scanners run in the cheap environment: ClamAV (signatures), Semgrep (patterns), YARA (custom rules), plus secret/install-hook detection. Output: flagged files/regions + signal, fed to the read model. Near-zero token cost.

**Reputation layer.** DeepSeek calls **Brave Search** directly as a tool for owner history, account age, stars, and community sentiment. Results cached **by owner** so the same owner is never re-searched within the cache window.

**Read model (fast path brain).** **DeepSeek V4 Flash.** Reads only static-flagged regions, comprehends the project, folds in reputation, and emits a score *plus a confidence*. Cheap, fast, handles ~95% of scans alone.

**Escalation gate.** A rule + confidence threshold. Escalates on: obfuscation, unexplained network calls, credential/secret access, install scripts doing too much, brand-new owner, or low read-confidence. Suspicion-triggered, not time-triggered. Tuned over time — explicitly half measured, half judgment.

**Sandbox (deep path).** A **single always-on Google Cloud VM** (`cr-host-build`, n2-standard-4), pre-loaded with the common runtimes (Node, Python, C/C++), a real terminal, and the agent harness. `app/api/deep` dispatches directly to it over `gcloud compute ssh`, capped at 2 simultaneous detonation slots (its 4-vCPU budget). A 3rd concurrent request no longer gets a flat 429: it joins a real FIFO queue (`lib/deep-queue.ts`, backed by a `deep_scan_queue` table + `deep-queue` edge function for observability and honest position reporting), sees a live "position N of M, ~X min" estimate, and is admitted the instant a slot frees, or times out honestly after 8 minutes. An on-demand golden-image + Managed Instance Group standby-pool architecture was built and benchmarked this session as a scale-out alternative but was reverted after real measurements showed its activation latency (21–88s to wake a host) didn't deliver the near-instant availability the product actually needs; it remains a documented future option if real traffic ever shows the 2-slot ceiling is the true bottleneck. Network egress locked down, no real credentials present, resources capped. **Reimaged to square-1 after every scan** — this reset is the abuse protection. Full lifecycle, the queue design, and the pool's preserved measurements are in `docs/INFRASTRUCTURE.md` §8b.

**Dynamic brain.** **Kimi K2.7 Code** (open-weight, latest) drives the sandbox agents through OpenCode. Parallelism (swarm-like) comes from running multiple OpenCode sessions, one terminal each. Bulk reasoning can route to DeepSeek to control output-token cost; K2.7 handles final adjudication.

**Scoring & report.** All signals combine into one 0–100 score via a **deterministic formula computed in code** (`supabase/functions/_shared/scoring.ts`) — the model feeds weighted signals, code decides the number that is cited, so the score can be reasoned about and audited rather than trusted to a model's self-report. The formula also carries the fairness rules: a strict doc-vs-code distinction (prose that merely mentions a credential path is never scored as credential-stealing code) and an "escalated but not yet run" penalty that only applies when a real negative code/behavior signal was present, so a repo escalated purely on low read-confidence is not taxed for ambiguity. The report is generated on the frontend from the shipped Claude Design `design.md` spec in the repo: the frontend produces a layout that conforms to the spec while adapting to each repo's findings — not a fixed template filled with values, and not a JSON payload rendered into a shell. Common boilerplate (background, shared chrome, repeated structure) is cached so it is not regenerated per report; only the per-repo parts are produced fresh. Exports: PDF, standalone HTML, shareable link.

**Storage & cache.** Reports persisted and keyed by **commit SHA**. Cache hit on unchanged repos → instant serve. On change → pull git diff, update only the affected analysis. Reputation cached by owner.

**Ads.** AdMob + mediation. The first scan is free with no ad and no login. After that, login is required and one rewarded video ad gates each result — fresh scans and cached report views alike. Cached views cost us ~$0 in compute but still carry the ad after the first scan, making them near-pure margin. Ads are the primary, sole v1 revenue model.

---

## 4. The scan lifecycle (detailed)

1. **Submit.** User pastes URL. Next.js API route receives `{owner, repo, ref}`.
2. **Resolve + cache check.** Resolve to a commit SHA. If a report exists for that SHA and the repo is unchanged → return it instantly. Done.
3. **Rate-limit / ad gate.** The first scan is free with no login or ad. After that, each result (fresh or cached) requires login and the rewarded ad to complete, and passes a per-user/IP rate limit (generous; abuse protection, not a paywall).
4. **Fast path.** Clone metadata + run static scanners → flagged regions. In parallel, reputation lookup (owner-cached). DeepSeek reads flagged regions, comprehends, blends, emits score + confidence.
5. **Gate.** Confident clean → go to step 8. Suspicious / low-confidence → escalate.
6. **Deep path.** Dispatch to the single warm sandbox host (queue if both detonation slots are busy). OpenCode + K2.7 clone, build, run, probe with adversarial/synthetic input, observe behavior. Capped output per agent; right-sized agent count.
7. **Reset.** Reimage the microVM to square-1 and destroy it; the host itself stays warm for the next detonation.
8. **Blend & emit.** Combine code comprehension, runtime behavior, static findings, reputation, owner history → one 0–100 score and the structured findings that drive the report (reputation vs code/behavior signals separated; never a bare "Safe").
9. **Render & persist.** Generate the report on the frontend from the `design.md` spec (boilerplate cached, per-repo parts fresh). Persist keyed by SHA. Publish `/owner/repo`. Update homepage feed / leaderboard if relevant.

---

## 5. Tech stack (locked)

The **current shipped** model layer is all-Gemini via the Vertex AI backend, sitting behind a clean swap seam. The "target" column is the intended production swap (DeepSeek/Brave/Kimi K2.7/OpenCode) that drops in by changing one module or secret without touching orchestration, the code-computed scoring, or the escalation gate — those are real and permanent. See `docs/INFRASTRUCTURE.md` §5–§6 for the model strings and the Vertex auth.

| Layer | Shipped now | Target swap | Notes |
|---|---|---|---|
| Web framework | **Next.js (App Router)** | — | SSR report pages = SEO surface; API routes orchestrate |
| Fast-path brain | **`gemini-3.1-flash-lite` via Vertex** | DeepSeek V4 Flash | reads only static-flagged regions; emits weighted signals + confidence |
| Reputation search | Vertex-side lookup | Brave Search API (owner-cached) | owner history, account age, stars, sentiment |
| Deep / agent brain | **`gemini-3.5-flash` via Vertex** | Kimi K2.7 Code | drives the sandbox agents |
| Agent harness | agentic analyzer (explore + sinkhole detonate) | OpenCode (MIT) swarm | knowledge-graph explore, then detonate chosen files |
| Sandbox | **Google Cloud — single always-on host (`cr-host-build`) + real FIFO queue** | — | reset every scan; cap 2 concurrent detonations, 3rd queues honestly; see §8b of INFRASTRUCTURE |
| Static signals | in-house extractor (obfuscation, install-hook, cred-access, secret, typosquat, network) with a doc-vs-code distinction | ClamAV/Semgrep/YARA | near-zero cost; prose mentions never scored as code |
| Scoring | **code-computed deterministic formula** (`_shared/scoring.ts`) | — | the model feeds signals; code decides the cited 0–100 |
| Storage/cache | keyed by commit SHA; reputation by owner | — | the survival mechanism |
| Monetization | AdMob + mediation, rewarded video | — | one ad per fresh scan |

The model/search seam is a single config switch; the orchestration around it does not change when the target models drop in.

---

## 6. Unit economics (the constraint v1 must satisfy)

All prices verified June 2026. The model must be operationally profitable on ads **at zero cache**, worst case.

**Fast-path scan (~95% of scans):** DeepSeek read (~$0.003) + 2 Brave queries (~$0.010) ≈ **$0.013**.

**Deep-path scan (~5%), optimized:** right-sized swarm (~12 agents), capped output (~800 tok/agent), bulk reasoning on DeepSeek, K2.7 for final adjudication, + sandbox VM compute ≈ **$0.067**. (Un-optimized — 30 fat K2.7 agents — is ~$0.65 and must be avoided; output tokens are ~74% of swarm cost, so output caps and agent right-sizing are mandatory, not optional.)

**Blended cost/scan** (95% × $0.013 + 5% × $0.067) ≈ **$0.016**.

**Revenue:** one rewarded video ad ≈ $0.008–0.025 (eCPM $8–25). At blended $0.016/scan, **one rewarded ad covers a scan** at mid eCPM, ~2 ads at low eCPM. Cached report views cost ~$0 and carry ads as near-pure margin.

**Conclusion:** sustainable on ads alone **conditional on three disciplines** — (1) escalate rarely (~5%), (2) cap swarm output + right-size agent count, (3) route bulk reasoning to the cheap model. Lose any one and the deep scan balloons past what ads can cover.

**Survival levers, in priority order:**
1. **Cache by SHA** — popular repos scanned once, served free thereafter. Turns virality from a cost into margin.
2. **Escalation gate** — keeps the expensive path at ~5%.
3. **Owner-cache reputation** — keeps Brave calls off most scans.
4. **Output caps + cheap bulk model** — keeps the rare deep scan affordable.
5. **Fresh-scan rate limit** — bounds the one action (fresh deep scan) that has cost but no matching ad revenue if abused.

"Unlimited" means unlimited *cached views* and *generously rate-limited fresh deep scans* — never unlimited unmetered deep scans.

---

## 7. Honest engineering reality

~80% of this is assembly: the Next.js app, the model/search API wiring, OpenCode install, static scanners, cache, report rendering, ad integration. Standard work.

The ~20% that is *real* engineering — and it is the whole product:

1. **Auto-build any repo.** Getting an arbitrary stranger's repo to build and run unattended in the sandbox. OpenCode + K2.7 + LSP self-correction gets most of the way (it's what coding agents do), but the long tail needs missing runtimes, env vars, keys, databases. Expect ~half the long tail to run out of the box; this success rate is the number that decides whether "we run it" is real. **Measure it on a real run before over-investing in the wrapper.**
2. **Hermetic sandbox isolation.** Egress filtering, no real credentials, resource caps, and a reset that *fully* wipes. Getting this subtly wrong turns the sandbox into a weapon. Safety-critical; deserves the most care.
3. **Escalation gate accuracy.** Not missing real malware (false "Safe") while not escalating everything (cost blowup). A calibration loop against real malicious + benign repos, run continuously. Half gut, half measured — accepted.

Point the hardest hours at these three. The rest is boring-on-purpose scaffold.

---

## 8. Two non-negotiable safety rails

1. **Never state a bare "Safe."** Reports show evidence and say what was *not* verified ("no malicious behavior observed in our tests"). A confident wrong "Safe" is the only story that can kill the product.
2. **The sandbox is hermetic and reset every scan.** No real credentials, locked egress, full reimage. A caught attack must hit an empty room.

---

## 9. Definition of done (v1 ships when)

- Paste a public GitHub URL with no login on the first scan → get a 0–100 score + readable report.
- Fast path resolves clean repos in seconds; suspicious repos escalate to a real sandbox run.
- Sandbox builds-and-runs a meaningful share of real repos, isolated and reset every scan.
- Reports are public at `/owner/repo`, exportable, with an embeddable badge.
- Cache by SHA + owner-cache reputation are live.
- First scan is free with no login or ad; after that, login plus one rewarded ad gates each result (fresh or cached).
- Verdicts never say a bare "Safe."
- Homepage shows live scans, viral repos, and the dangerous-repos leaderboard.

If it does the above, it's the product. Everything else is roadmap. Build this.
