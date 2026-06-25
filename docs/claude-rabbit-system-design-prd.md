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
- No CLI or MCP product surface.
- No leaderboard moderation tooling beyond a basic display.

These are roadmap. They live in the founder's head, not in v1 scope.

---

## 3. System architecture

The system is a **two-speed funnel**. ~95% of scans resolve on the fast path; ~5% escalate to the deep path. This ratio is the load-bearing assumption behind both performance and economics.

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
        │  6. Provision GCP sandbox VM (golden image, reset每scan)          │
        │  7. OpenCode harness + Kimi K2.7 agent(s)/swarm:                  │
        │       clone → build → run → adversarial input → observe behavior  │
        │  8. Reimage sandbox to square-1 (abuse protection)               │
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

**Orchestrator (Next.js API route + queue).** Receives a scan request, runs the cache check, drives the fast path, evaluates the escalation gate, and dispatches deep scans to the sandbox pool. Returns the blended verdict.

**Static scan layer.** Off-the-shelf scanners run in the cheap environment: ClamAV (signatures), Semgrep (patterns), YARA (custom rules), plus secret/install-hook detection. Output: flagged files/regions + signal, fed to the read model. Near-zero token cost.

**Reputation layer.** DeepSeek calls **Brave Search** directly as a tool for owner history, account age, stars, and community sentiment. Results cached **by owner** so the same owner is never re-searched within the cache window.

**Read model (fast path brain).** **DeepSeek V4 Flash.** Reads only static-flagged regions, comprehends the project, folds in reputation, and emits a score *plus a confidence*. Cheap, fast, handles ~95% of scans alone.

**Escalation gate.** A rule + confidence threshold. Escalates on: obfuscation, unexplained network calls, credential/secret access, install scripts doing too much, brand-new owner, or low read-confidence. Suspicion-triggered, not time-triggered. Tuned over time — explicitly half measured, half judgment.

**Sandbox (deep path).** A pool of **Google Cloud VMs**, each booting a **golden image**: common runtimes (Node, Python, C/C++), a real terminal, and the **OpenCode** harness (MIT-licensed) pre-installed. Network egress locked down, no real credentials present, resources capped. **Reimaged to square-1 after every scan** — this reset is the abuse protection.

**Dynamic brain.** **Kimi K2.7 Code** (open-weight, latest) drives the sandbox agents through OpenCode. Parallelism (swarm-like) comes from running multiple OpenCode sessions, one terminal each. Bulk reasoning can route to DeepSeek to control output-token cost; K2.7 handles final adjudication.

**Scoring & report.** All signals blend into one 0–100 score. The report is generated on the frontend from the shipped Claude Design `design.md` spec in the repo: the frontend produces a layout that conforms to the spec while adapting to each repo's findings — not a fixed template filled with values, and not a JSON payload rendered into a shell. Common boilerplate (background, shared chrome, repeated structure) is cached so it is not regenerated per report; only the per-repo parts are produced fresh. Exports: PDF, standalone HTML, shareable link.

**Storage & cache.** Reports persisted and keyed by **commit SHA**. Cache hit on unchanged repos → instant serve. On change → pull git diff, update only the affected analysis. Reputation cached by owner.

**Ads.** AdMob + mediation. The first scan is free with no ad and no login. After that, login is required and one rewarded video ad gates each result — fresh scans and cached report views alike. Cached views cost us ~$0 in compute but still carry the ad after the first scan, making them near-pure margin. Ads are the primary, sole v1 revenue model.

---

## 4. The scan lifecycle (detailed)

1. **Submit.** User pastes URL. Next.js API route receives `{owner, repo, ref}`.
2. **Resolve + cache check.** Resolve to a commit SHA. If a report exists for that SHA and the repo is unchanged → return it instantly. Done.
3. **Rate-limit / ad gate.** The first scan is free with no login or ad. After that, each result (fresh or cached) requires login and the rewarded ad to complete, and passes a per-user/IP rate limit (generous; abuse protection, not a paywall).
4. **Fast path.** Clone metadata + run static scanners → flagged regions. In parallel, reputation lookup (owner-cached). DeepSeek reads flagged regions, comprehends, blends, emits score + confidence.
5. **Gate.** Confident clean → go to step 8. Suspicious / low-confidence → escalate.
6. **Deep path.** Pull a sandbox VM from the pool. OpenCode + K2.7 clone, build, run, probe with adversarial/synthetic input, observe behavior. Capped output per agent; right-sized agent count.
7. **Reset.** Reimage the VM to square-1. Return it to the pool.
8. **Blend & emit.** Combine code comprehension, runtime behavior, static findings, reputation, owner history → one 0–100 score and the structured findings that drive the report (reputation vs code/behavior signals separated; never a bare "Safe").
9. **Render & persist.** Generate the report on the frontend from the `design.md` spec (boilerplate cached, per-repo parts fresh). Persist keyed by SHA. Publish `/owner/repo`. Update homepage feed / leaderboard if relevant.

---

## 5. Tech stack (locked)

| Layer | Choice | Notes |
|---|---|---|
| Web framework | **Next.js (App Router)** | SSR report pages = SEO surface; API routes orchestrate |
| Fast-path brain | **DeepSeek V4 Flash** | $0.14/$0.28 per M tokens; reads flagged code, calls Brave |
| Reputation search | **Brave Search API** | ~$0.005/query, PAYG; owner-cached; own rate-limit in front |
| Dynamic brain | **Kimi K2.7 Code** | open-weight; drives sandbox; bulk → DeepSeek, adjudicate → K2.7 |
| Agent harness | **OpenCode (MIT)** | terminal + parallel multi-session = swarm; LSP self-correction |
| Sandbox | **Google Cloud VM** | golden image, all prereqs, reset every scan |
| Static scanners | ClamAV, Semgrep, YARA + secret/hook detection | off-the-shelf, near-zero cost |
| Storage/cache | keyed by commit SHA; reputation by owner | the survival mechanism |
| Monetization | AdMob + mediation, rewarded video | one ad per fresh scan |

All model and search APIs are OpenAI-compatible HTTP / PAYG. No subscriptions, no gated endpoints.

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
