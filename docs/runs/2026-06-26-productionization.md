# Run Context — Productionization Sweep (2026-06-26)

Live context record for the productionization run (aidhiraj_protocol). Updated continuously, structured by unit. Resumable cold.

## Starting state

- **Branch:** `claude/zen-merkle-43a854` (worktree), off `main`.
- **Starting commit:** `f349397` — "chore: remove 36MB Claude Design zip from the repo (keep design.md)".
- **Tree:** clean, up to date with `origin/main`.
- **Stack:** Next.js 16 (App Router) + React 19, Supabase (Postgres + Auth + Edge Functions on Deno), Gemini-via-Vertex. Node 24.16, npm 11.13.

## Environment capabilities (probed, factual)

- gcloud SDK 574 authenticated as [redacted-email]; service account clauderabbit-vertex also credentialed; project redacted-gcp-project. Live GCP reachable.
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
- Researching current OpenCode (install, Gemini-via-Vertex provider config, headless/programmatic run, custom exec) before writing the plan → cold-audit → build → one live GCP proof on a synthetic fixture.

### Remaining units (dependency order)
- U3 Phase 7 caching: tab-switch-loses-report-view bug (React state persistence) + multi-level data cache + prompt caching on both Gemini tiers (`_shared/vertex.ts`).
- U4 Phase 2 sandbox (HEAVIEST): install/vendor OpenCode FIRST; 3 Gemini Flash-Lite agents (lead+2) + sparing 3.5-Flash advisor (hand-built pattern, cap ~3); A2A pre-tool hook cross-validation; inner=consensus/outer=~15min hard ceiling; no-early-exit; never-blank report (checkpoint+resume); survivable watchdog; warm pool; right-sized VM; knowledge graph; continuous static scan. Re-measure auto-build + escalation rates.
- U5 Phase 3 security skill (prompt-cached methodology). U6 Phase 5 reports/danger-board/world-map/live-counts. U7 Phase 6 auth (wipe Adhiraj data, fresh fake-email Google sign-in). U8 Phase 8 polish (watermark, turbopack.root, copy rewrite, animation loop, profile icons, GH linking, native Gemini web search, skeletons). U9 Phase 9 cost measurement (no caps). U10 Phase 10 docs. U11 Phase 11 user testing via Claude-in-Chrome + load testing.
- Known stub to fix: `state.tsx:1145` exportPDF (toast-only). Ads placeholder: LEAVE (out of scope).
