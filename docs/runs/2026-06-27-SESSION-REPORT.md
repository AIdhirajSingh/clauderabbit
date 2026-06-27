# Claude Rabbit — Make-It-Shippable Run · Session Report (2026-06-27)

Honest, distilled account of this session. It is a **strong checkpoint, not a finish**: the three
most critical bug classes are fixed, proven by driving the real app in a real browser, reviewed,
and merged to `main` (the scan-limit fix is also deployed live). Significant work remains — mapped
precisely below so it resumes cold. Full per-unit reasoning is in `2026-06-27-make-it-shippable.md`.

Baseline `5a9a61e` → **`main` now `14a4f52`** · 3 squash-merged PRs (#5, #6, #7) · per-unit branch
flow · `main` green throughout · gitleaks run locally every push, never bypassed · CI stays
disabled (Actions billing) — **do not re-enable**.

---

## What the real-browser pass actually found (ground truth vs the report)

Driving the deployed app in a real browser (Claude-in-Chrome) corrected two assumptions:
- **BUG-1 (auth 404) and BUG-12 (`/owner/repo` 404) DO NOT reproduce on current code.** The real
  Google `?code=` flow works end-to-end: "Continue with Google" → `/auth/callback` →
  `exchangeCodeForSession` → session → **lands in the dashboard**, and persists across reload. The
  reported 404s were a **stale deployment**. (`/auth/callback?code=…` → 307, never 404;
  `/owner/repo` → 200 NotScanned, never `notFound()`.)
- **BUG-16 (danger-board click blanks) IS real** — and is fixed.

The **one-click confirmation for Adhiraj** (only he has the Google account): a brand-new
fresh-first-time Google sign-in. Everything around it — the OAuth front-half, the real `?code=`
exchange, session-set, dashboard landing, reload persistence — is proven.

---

## Shipped, proven, merged

### U1 — Report screen never blanks (BUG-16) · PR #5 `ea9dc49`
Clicking a danger-board row blanked the whole SPA (a real caught repo isn't in the client store →
`activeRepo` null → `ReportScreen` returned null), and the nav snapshot persisted it (blank survived
reload). Root fix (kills the class for **every** entry path — board, deep-link, rehydration): a
shared `lib/report-fetch.ts` (`fetchLatestReport` for SSR, anon-REST `fetchLatestReportRest` for the
SPA, pure `decideReportFetch`/`isValidSlug`); `ensureActiveReport(id)` loads on demand into
`liveReports` with loading/error states, ref-token dedupe, stale-resolve guard, negative cache;
`ReportScreen` renders loading/graceful-error cards, **never null**.
- **Two bugs found only by running:** the authenticated `@supabase/ssr` read of `reports` hangs
  (switched the SPA to the anon read — reports are public, matches SSR); `ensureActiveReport` read a
  stale `activeRepoId` from the effect-synced `stateRef` on the mount effect (now takes the fresh id).
- Proven live: clawdcursor renders the full report (no blank); reload self-heals. +12 tests.
- Independent security review APPROVE-WITH-FIXES 82 → the one MEDIUM (slug not validated before a
  fallback link) fixed with `isValidSlug`.

### U2a — Honest verdict, the canary (BUG-2) · PR #6 `7d895db`
**The single most serious bug.** A verdict claimed runtime sandbox observations that never
happened: clawdcursor (`deep=true`, `forensics_json=NULL` — escalated but never executed) wore a
"Sandbox run" badge and a verdict reading *"We observed active credential access… blocked outbound
attempts are the detection signal."* Lies. Root: runtime claims keyed off score/the `deep` flag,
not evidence.
- `_ranSandbox = a forensic record exists` is now the only signal for runtime language. `finalNote`/
  `notVerified` speak strictly in static terms when nothing ran (*"Static analysis flagged… not
  executed in a sandbox on this pass, not an observed detonation"*); the badge reads **"Static
  read"** unless forensics exist. Migration `…000005` (applied live): board "deep sandbox runs"
  counts genuine runs → **2 → 0** (all 3 deep-flagged repos have zero forensics; none actually ran).
- Audited every verdict/badge/summary/marker template. +5 tests. Security review APPROVE-WITH-FIXES
  82 → both findings fixed. Proven live: clawdcursor now reads "Static read" + a static-only verdict.

### U3 — De-fake the shell + UNLIMITED scans (BUG-4/7/8/9/10/19) · PR #7 `14a4f52`
- **BUG-9 was a real ship-stopper, not just copy:** the **edge function enforced 3 stage-1 + 1
  dynamic scans/day** (HTTP 429 "Daily limit reached") — scanning **broke** after the cap. Removed
  both gates + dead `enforceDailyLimit`, **deployed live**, and **proven**: scanned
  `sindresorhus/p-limit` → 95/Trusted with NO 429 despite being the 3rd+ scan of the day. UI limit
  text removed (login, profile); sign-in reframed to history + contributing to the vetted-repo DB.
- **BUG-7/8/10:** `claude-rabbit/rabbit` → `AIdhirajSingh/clauderabbit` (nav + decorative cards);
  removed the fabricated 24,318/24.3k star count (the repo has no public count → can't show real, so
  removed) + the count-up animation; dead `href=#` nav/CTA links → real
  `github.com/AIdhirajSingh/clauderabbit` (`target=_blank rel=noopener`).
- **BUG-4:** removed the fabricated "Scanning live, right now" ticker. **BUG-19:** removed "Simulate
  failure (demo)". Fabricated dashboard counts (`+5`/`+2` padding) → real ("3 scanned · 0 dangers").
  Fixed the homepage lie "Every scan you see here ran in a real sandbox."
- Security review **APPROVE 97/100** (clean). All gates green.

### BUG-14 (hydration) — verified benign
Audited all SSR-rendered paths: **zero** `Date.now`/`Math.random`/`new Date`/`toLocaleString`, and
the homepage is `"use client"`. There is no genuine SSR/client mismatch. The `fdprocessedid` warning
is injected by a browser form-filler extension and is harmless. No code change needed.

---

## Remaining work (honest — NOT done; precise next steps)

**P0 — the moat (heaviest):**
- **BUG-3 — escalation must actually run the sandbox.** Today the gate trips and logs "Queued…
  (not executed on this pass)" but never runs `sandbox/orchestrate.sh`, so `forensics_json` stays
  null. U2a makes this *honest* (no false runtime claims) but the moat isn't delivered. Next: wire
  escalation to trigger a real GCP sandbox run (10–15 min VM — must be async: escalate → background
  runner → persist forensics → report updates `deep=true` + runtime claims only then). Prove on
  clawdcursor + a synthetic `exfil-c2` fixture; release every VM; keep the dead-man's switch.

**P1 — scripted theater (honesty of the live pipeline):**
- **BUG-5** — the processing/logs screen shows a templated timeline, identical per repo. Stream the
  REAL scan (model thinking, real static-scan findings, reputation lookups, sandbox actions) into the
  vertical timeline.
- **BUG-6** — confirm cached scans return fast + labelled "cached" and don't replay the processing
  animation (the client timer should yield to a fast `runScan` resolve; verify and fix if not).

**P2 — lifecycle / interactions:**
- **BUG-17** — first-render vs cached owner/reputation determinism. U1's shared fetcher makes SSR and
  SPA reshape identically; verify the first scan and the cached re-render are byte-identical for a SHA.
- **BUG-18** — world map plots real geolocations (downstream of BUG-3; prove with a phone-home fixture).
- **BUG-11** — sign-in/ad-gate coherence: the "15-second ad" copy + AdScreen "Skip ad (demo)" are
  stale (ads abandoned). Decide a coherent non-blocking sign-in prompt; remove ad scaffolding.
- **BUG-13** — end-to-end persistence + cache proof across two repos and two sessions.

**P1 (content):**
- **BUG-20 — the copy/mission overhaul.** Kill the "everyone reads the code, we run it" comparative
  framing (still in the hero eyebrow ×3, `app/layout.tsx` description, the SSR report footer);
  replace with a declarative "we are X" production-security-product mission per
  `docs/claude-rabbit-north-star.md` (use only its real stats). Rebuild the dead "What is Claude
  Rabbit" section into the pitch using the real clawdcursor catch.

**Cross-cutting:** load test on a production build (homepage + SSR report + badge) — not run this
session. Minor: a dead `activity`/`ACTIVITY` memo in `state.tsx` (unrendered, not a shipped lie).

---

## Gates (all green locally; CI disabled by billing block)
`npm run typecheck` ✅ · `npm run lint` ✅ · `npm run build` ✅ · `node --test` → **47** ✅ ·
`deno test supabase/functions/` → **19** ✅ · **`gitleaks detect` → no leaks** every push.
- Re-enable CI when billing is restored: `git mv .github/workflows/ci.yml.disabled .github/workflows/ci.yml`

## Deploy
- **Edge function:** the no-limit `scan` function is **deployed** to `mjvlczaytkhvsolnhhkz`.
- **Vercel** (Adhiraj's trigger; secrets stay server-side in Supabase): set the 3 public
  `NEXT_PUBLIC_*` env vars; add `<prod-origin>/auth/callback` to the Supabase Auth + Google OAuth
  allowlists (so Google sign-in works off-localhost); then `vercel --prod`. The build is green;
  routes `/`, `/[owner]/[repo]`, `/badge/[owner]/[repo]`, `/auth/callback`.
- **One-click confirm for Adhiraj:** a fresh first-time Google sign-in lands in the dashboard — the
  full machinery (real `?code=` exchange, session, landing, persistence) is already proven.
