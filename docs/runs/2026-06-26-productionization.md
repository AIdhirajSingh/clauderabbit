# Run Context — Productionization Sweep (2026-06-26)

Live context record for the productionization run (aidhiraj_protocol). Updated continuously, structured by unit. Resumable cold.

## Starting state

- **Branch:** `claude/zen-merkle-43a854` (worktree), off `main`.
- **Starting commit:** `f349397` — "chore: remove 36MB Claude Design zip from the repo (keep design.md)".
- **Tree:** clean, up to date with `origin/main`.
- **Stack:** Next.js 16 (App Router) + React 19, Supabase (Postgres + Auth + Edge Functions on Deno), Gemini-via-Vertex. Node 24.16, npm 11.13.

## Environment capabilities (probed, factual)

- gcloud SDK 574 authenticated as manishpratapsingh@gmail.com; service account clauderabbit-vertex also credentialed; project gen-lang-client-0062239756. Live GCP reachable.
- supabase CLI 2.106 present.
- Node 24.16 / npm 11.13 — local build/run works.
- opencode NOT installed — hard dependency for the Phase-2 agentic sandbox. Must install/vendor.
- No secrets on disk; .gitignore covers .env*, *-key.json, *.zip.
- Dynamic Workflow: the genuine native Workflow tool IS available this session — used surgically (cold-audit gate, independent review gate, genuine parallel fan-out), minimum agents.

## Dependency-ordered phase plan

Foundation -> structure. De-fake first (Phase 1) so polish isn't wasted; then the data/scoring spine (Phase 4) the reports/board depend on; then the sandbox engine (Phase 2/3 — the moat); then surfaces (Phase 5 reports/board); then cross-cutting (6 auth, 7 caching, 8 polish); then measurement/docs/testing (9/10/11).

## Unit log

### U0 — Comprehend + baseline (DONE)
- Read CLAUDE.md, INFRASTRUCTURE.md, protocol gates, mapped repo, probed infra. Pinned fake data: lib/demo-data.ts (REPOS/LEADERBOARD/ACTIVITY — fully invented incl. "Ana Mirza"), supabase/seed.sql (seeded rows incl. 'Ana Mirza').
- Installed deps (npm ci, exit 0). Baseline GREEN: typecheck ✅ lint ✅ build ✅ test ✅ (0 tests — coverage gap to fill for new logic).
- **Live pipeline PROVEN**: curled deployed scan fn on octocat/Hello-World → real metadata + real Gemini verdict (95/Trusted), persisted + cache-served, HTTP 200 in 6.3s. So real-repo seeding (Phase 1) is unblocked.

### Key findings for later phases
- **Phase 4 (scoring):** score is MODEL-GUESSED today — `supabase/functions/scan/index.ts:728` clamps `model.score` directly. Escalation gate (`decideEscalation`) IS code-driven; rails (`enforceVerdictRails`) server-side. Need: deterministic code-computed formula from weighted inputs. Symptom seen live: model wrote account-age into `stats.created`.
- **Phase 2 (sandbox):** current form = observer/sinkhole (`sandbox/harness/*`, `sandbox/net/*`). OpenCode agentic layer not built; opencode binary not installed.
- Multi-lockfile Next warning (worktree + main both have package-lock.json) → Phase 8 `turbopack.root`.

### U1 — Phase 1 de-fake (COMMITTED on branch; independent review pending before main-merge)
- Executor (agentId a8ce50f5c89de6983) scanned 6+ REAL famous repos across multiple owners (expressjs, pallets, psf, chalk, tj, gorilla, sindresorhus) via the live fn; raw JSON proved real (real commit SHAs + star counts). Rewrote `lib/demo-data.ts` (REPOS keyed `owner/name` from real scans; ACTIVITY/SUGGESTION_IDS/DEMO_ORDER derived; **LEADERBOARD → `[]`** honest-empty — inventing malware forbidden), `supabase/seed.sql` (6 real rows), neutralized the reseed migration to no-op, de-faked decorative cards in `state.tsx`/`Orbit.tsx`, added honest empty-states to Leaderboard/Home screens.
- **Lead verification (ran MYSELF):** typecheck ✅ lint ✅ build ✅; grep → zero residual fabricated names; self-reviewed state.tsx diff = honest + consistent.
- **Stub hunt (real gaps for later):** `state.tsx:1145` exportPDF is a toast-only stub (no real PDF); `AdScreen` ad slot is a placeholder (**ads OUT of scope this run — leave**). Decorative pre-existing cards `claude-rabbit/rabbit · 24.3k★ · 99` and `AdhirajSinghEntrepreneur/pockit · 88` are aspirational/owner cards — flag for polish review (not data).
- **Pending:** independent zero-context review of the de-fake diff (spawned); address findings before main-merge.
### U1 review — DONE → fixes applied → U1 CLOSED
- Review verdict: APPROVE-WITH-FIXES 81/100 (0 crit/high; 2 med + 2 low). All addressed in commit `b22bc6f`: removed kind:'rep' endorsements from requests/mux risky[] (separation rail); trimmed REPOS to the 6 seeded repos (dropped sindresorhus/is + chalk/supports-color → were unseeded SSR-404 risk) + removed dead DEMO_ORDER; fixed stale r1–r6 comment. typecheck/lint green.
- **U1 (Phase 1 de-fake) is fully closed & mergeable.** Commits: 3d6d5bf (de-fake) + b22bc6f (review fixes).

### U2 — Phase 4 code-computed scoring formula — COMMITTED `ca49051`; independent review running (agentId a8d3fdee6a25cdf5f)
- `_shared/scoring.ts` pure `computeScore` (baseline 82; code penalties dominate — obfuscation −42, credAccess −40, install-time-net −40…; reputation SEPARATE bounded [−18,+14]; cited breakdown sums exactly via `reputation_cap`; dynamic inputs ready for deep path). 7 Deno tests pass.
- `scan/index.ts`: model FEEDS signals, code DECIDES score; verdict now derives from computed band (5-level, never bare Safe, fixed an 87→"Trusted" band mismatch I caught live); `decideEscalation`→{escalate,reason}; response carries escalationReason+scoreBreakdown; "Score" log chapter.
- **VERIFIED BY ME (ran):** typecheck/lint/build green, deno tests 7/7, deno check green. **Deployed live** to `mjvlczaytkhvsolnhhkz` and **proven end-to-end**: fresh cookie-parser → 87/Likely safe (breakdown 82−6−3+8+6+4−4=87, exact); fresh morgan → 41/High risk; cached path verdict snaps to band too.
- **REAL FINDING (separate follow-up unit — static-scan precision):** `expressjs/morgan` (clean famous Express logger) scores 41/High risk because the static `obfuscation` signal fires on its legitimate `new Function()` log-format compiler → escalates → −42. Scoring formula is CORRECT; the upstream obfuscation detector in `_shared/static-scan.ts` is too broad (flags dynamic-code-eval as obfuscation) → false-HIGH-danger on clean repos. Needs detector precision tuning. **Important for credibility.**
- **CI note:** `.github/workflows/ci.yml` runs lint/typecheck/build+gitleaks but NOT tests → the new Deno scoring tests don't gate in CI. Add a `setup-deno` + `npm run test:functions` step (Phase 8/CI hardening).
- **U2 review: DONE → fixes applied → U2 CLOSED.** Verdict APPROVE-WITH-FIXES 78/100 (0 crit/high; 3 med + 2 low). All addressed in `ac29119`: clamp_floor/ceiling delta keeps citation trail EXACT (MED-1) + strict test (LOW-3); sentScore −1 unknown sentinel vs 0 negative (MED-2); auto-build +4 suppressed alongside observed malice (LOW-2); reshapeCached emits escalationReason+scoreBreakdown (MED-3); +4 tests → 11/11. Re-deployed + re-proven live (click 96/Trusted, sum exact). Commits: ca49051 + ac29119.

### U3 — static-scan precision (morgan false-positive) — COMMITTED `8a93f19`; security review running (a3349bfd287550918)
- Demoted bare `new Function('…')` from the binary `obfuscation` signal to a REGION-ONLY flag (model still inspects; no auto-escalate / −42). Real obfuscation (eval-of-decoded, 120+ base64, atob+eval, hex blobs) unchanged. +5 Deno tests (16/16 pass). **Proven live:** morgan@1.9.1 41/High-risk/escalated → 93/Trusted/cleared.
- On review return: address findings, U3 closes. (Security reviewer asked specifically whether this opens a `new Function` bypass.)

### U3 review — DONE → fixes `664d643` → U3 CLOSED. Security review 68/100 (0 crit/high; 2 high + 2 med). H1 (real regression: obfuscated 60-119 char literal lost hard signal) + H2 (Function(atob)/var-arg gaps) closed: added Function-of-decoded hard pattern, lowered base64 threshold 120→60, added var-arg soft region. 19/19 tests. morgan@1.10.0 re-proven 93/Trusted live.

### U4 — Phase 2 agentic OpenCode sandbox (THE MOAT, heaviest) — RESEARCH/PLAN
- Existing sandbox (3210 LoC, live-proven): golden image, deny-all VPC, trap host (dnsmasq+sinkd+squid+tcpdump), in-VM strace observer, off-VM Gemini payload analysis, verdict.py, forensics.py, orchestrate.sh, dead-man's-switch cleanup. Form = monitored-sinkhole observer.
- **KEY ARCHITECTURE INSIGHT:** detonation VM has NO external IP / NO SA / deny-all egress → Gemini-driven agents CANNOT run inside it without breaking "no real packet leaves". Correct design: **AI brain OUTSIDE the blast radius** (controller/trap with egress) driving OpenCode that reaches INTO the sealed VM via intra-VPC SSH to explore+detonate. This also IS the prompt's "external monitor sees the blast without being blasted" + survivable inside/outside split.
- Researched OpenCode (verified live facts): headless `opencode run`, Vertex provider via `@ai-sdk/google-vertex` (project/location/googleAuthOptions), models list. Vertex-direct fallback via existing `_shared/vertex.ts` if OpenCode headless is brittle.
- **Design doc written + committed** (`sandbox/AGENTIC-DESIGN.md`): brain-outside/hands-inside (invariant-preserving), knowledge graph, 3-agent team + sparing 3.5-Flash advisor (cap 3), A2A pre-tool hook cross-validation, inner=consensus/outer=15min cage, no-early-exit, never-blank (checkpoint+resume), survivable watchdog, external monitor, continuous static, warm pool, baked deps. Build order: knowledge-graph → agent loop → wire → watchdog/monitor → warm pool → ONE live GCP proof.
- **Cold-audit DONE (58/100, APPROVE-WITH-FIXES)** — found a REAL egress-leak (C1: DNAT exempts uid 0, so a root `detonate` would bypass the sink), inverted trust boundary (C3 credentialed brain ingests hostile repo text), FACT-vs-inference needs CODE enforcement (C5), budget-vs-deadman race (C4), scope 2-3× too big. Design REVISED with binding constraints + minimal core (commit after design rev). 
- **C1-compliant detonate verified against `run-harness.sh`:** untrusted code runs `sudo -u runner` under `observe.py` AFTER `sinkhole-flip.sh run` (which asserts + `exit 3` on fail). So detonate = relay a VALIDATED target through the harness run path (single chokepoint, runs-as-runner, flips+asserts+sinks) — never free-form SSH. Facts come from the merge report's `aggregate_observations` (sinkholed_attempt_count, high_value_cred_read_*, high_cpu, files_dropped, auto_build_succeeded…) + trap capture — code-verified, not model.
- **U4a knowledge graph: executor BUILDING** (agentId a46676b33201e2e16) — pure Python over the clone, reuses `static-scan` via a Deno CLI (no fork), unit-tested vs the synthetic fixtures (buried postinstall must rank high). Proves the EXPLORE half. On return: verify + commit, then build the agent-loop core (Vertex-direct, C1-C5 constrained, unit-tested mocked).

### U5 — Phase 8 polish (watermark + turbopack root) — COMMITTED `bb66ac9`
- `next.config.ts`: `devIndicators:false` (hide dev watermark) + `turbopack.root=__dirname` (silence multi-lockfile warning). Build/typecheck/lint green; warning gone. Verified Next 16.2.9 API via docs.

### Progress tally (all committed, main-green, proven)
- U0 baseline · U1 de-fake (CLOSED, reviewed) · U2 scoring formula (CLOSED, reviewed, LIVE-proven) · U3 static-scan precision (CLOSED, security-reviewed, LIVE-proven) · U5 polish. Commits: 2f8b5fd→bb66ac9.
- **Live scan fn redeployed** several times this run (current = with computed scoring + obfuscation precision). Proven repos: cookie-parser 87, click 96, morgan 93 (was 41).
- Deno test suites: 11 scoring + 8 static-scan = 19, all pass (`npm run test:functions`). CI still doesn't run them (add setup-deno step — tracked).

### U4a knowledge graph — COMMITTED `9746d13` (verified myself: 22 tests pass; cred-stealer buried postinstall ranks #1). Explore half proven.
### U6 CI deno-gating — COMMITTED `1f2175a` (edge-tests job runs the 19 Deno tests; verified green).
### GCP prereqs CONFIRMED READY for live proof: golden image cr-sandbox-golden-20260625 exists; cr-sandbox-vpc + 5 firewall rules present; zero leftover VMs.
### U4b agent-loop core — COMMITTED `fc4a0ec` (24 tests pass, C1 self-reviewed). SECURITY REVIEW running (agentId ab9be1ba9a1d51c4f) = the merge gate.
- Files: detonator.py, agent_loop.py, vertex_client.py, test_agent_loop.py, run-harness.sh (run-target), orchestrate.sh (CR_AGENTIC=1 opt-in). C1 verified myself: run-target validates runtime allowlist + path (abs/../symlink/realpath under $WORK) + re-asserts containment (exit 3) + runs as `sudo -u runner` (non-root). 
- **LIVE-PROOF PREPPED:** ADC OK, deno 2.8.3, fixtures built (exfil-c2/cred-stealer/miner/benign-deps .tar.gz), google-genai installing. Golden image + network + firewalls ready, no leftover VMs. On security-review clear: address findings → attempt ONE live agentic proof `CR_AGENTIC=1 bash sandbox/orchestrate.sh --zone us-central1-a --tarball sandbox/fixtures/exfil-c2.tar.gz --name agentic-exfil`. Flagged integration gaps to close first: dynamic_outcome→verdict/forensics wiring; ssh readback parse on noisy IAP.

### U4b SECURITY: 2nd review (62/100) → ALL 9 findings fixed `4f8c410` (39 tests). HIGH-3 controller-injection + CRIT-1 path-bypass + MED-4 tool-call dispatch closed, re-reviewed by me. Two audit + two security rounds applied.
### VERTEX PATH PROVEN LIVE: vertex_client smoke test → real Gemini 'PONG' + a real `detonate` tool_call normalized correctly (location=global). The riskiest untested piece works.
### LIVE AGENTIC PROOF LAUNCHED (bg bdamrblzf): `CR_AGENTIC=1 CR_VERTEX_LOCATION=global orchestrate.sh ... exfil-c2`. Capstone integration of all proven components. Result pending; robust cleanup (dead-man's switch) = no orphan risk.

### (build-detail note moved up; original below)
### U4b agent-loop core — executor BUILDING (agentId ab3c3426305ccf775)
- Vertex-direct explore/detonate loop with C1-C5 hard constraints + run-harness `run-target` extension + detonator.py + agent_loop.py + comprehensive unit tests (mocked model + mocked ssh). NO live GCP (lead runs the one proof).
- **On return (lead, security-critical):** verify tests MYSELF, INDEPENDENT SECURITY REVIEW (the gate that matters most — catch any C1-C5 violation), then attempt ONE live GCP proof on exfil-c2 (infra ready), then commit. Knowledge-graph review folded into this review.

### Remaining units (dependency order)
- U3 Phase 7 caching: tab-switch-loses-report-view bug (React state persistence) + multi-level data cache + prompt caching on both Gemini tiers (`_shared/vertex.ts`).
- U4 Phase 2 sandbox (HEAVIEST): install/vendor OpenCode FIRST; 3 Gemini Flash-Lite agents (lead+2) + sparing 3.5-Flash advisor (hand-built pattern, cap ~3); A2A pre-tool hook cross-validation; inner=consensus/outer=~15min hard ceiling; no-early-exit; never-blank report (checkpoint+resume); survivable watchdog; warm pool; right-sized VM; knowledge graph; continuous static scan. Re-measure auto-build + escalation rates.
- U5 Phase 3 security skill (prompt-cached methodology). U6 Phase 5 reports/danger-board/world-map/live-counts. U7 Phase 6 auth (wipe Adhiraj data, fresh fake-email Google sign-in). U8 Phase 8 polish (watermark, turbopack.root, copy rewrite, animation loop, profile icons, GH linking, native Gemini web search, skeletons). U9 Phase 9 cost measurement (no caps). U10 Phase 10 docs. U11 Phase 11 user testing via Claude-in-Chrome + load testing.
- Known stub to fix: `state.tsx:1145` exportPDF (toast-only). Ads placeholder: LEAVE (out of scope).
