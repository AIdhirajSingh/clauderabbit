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
- **Next units:** U2 Phase 4 code-computed scoring formula (new `lib/scoring.ts` + wire `supabase/functions/scan/index.ts:728`, unit-tested); U3 Phase 7 caching tab-switch bug; U4 Phase 2 sandbox (install OpenCode first); U5 Phase 8 polish. Dependency order.
