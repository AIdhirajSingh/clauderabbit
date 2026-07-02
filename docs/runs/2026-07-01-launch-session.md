# Run doc — Last session before public launch (2026-07-01)

Fresh session on a new machine. Reoriented from the run docs + the live code/DB/host
before changing anything. Every fix below is PROVEN by running (browser + real /api/deep
detonations + live DB). Six commits on `claude/gifted-davinci-86aae8`
(26c5d33 → ea6737e). Scope this session excluded, by instruction: GitHub OAuth provider
config and an actual Vercel deploy (both left to the user, documented in docs/DEPLOY.md).

## The root causes found (reorientation)
- **Host `cr-host-build` was TERMINATED** → every escalation SSHed to a dead host. Started
  it; it self-rebuilt its devmapper pool + base image on boot (pool `rw`, base present).
- **This new machine had no deep-scan `.env.local`** → `/api/deep` was inert / wrong zone /
  couldn't persist. Wrote it: `CR_ALLOW_LOCAL_DEEP=1`, `CR_SANDBOX_ZONE=us-east1-b`,
  rotated `CR_DEEP_RUNNER_KEY` to match a freshly-set Supabase secret (digest verified),
  redeployed attach-forensics.
- **`gcloud` over SSH failed with exit 49** — git-bash's extensionless `gcloud` wrapper
  shelled to `python`, which hit the Windows Store alias. Fixed via `CLOUDSDK_PYTHON` →
  the SDK's bundled interpreter (in `.env.local`, documented in `.env.example`).
- **SSH host key wasn't cached** in plink → would hang `/api/deep`'s SSH. Cached it.

## What shipped (each proven by running)

1. **#1 — escalations complete again + honest, distinct report copy** (4d09b5d).
   - Real `/api/deep` detonation of `AmrDab/clawdcursor` COMPLETED on the microVM+forge
     substrate (schema `forensic-record/microvm-1`, containment CONFIRMED, forensics
     attached) → renders **"Sandbox run"** + honest runtime verdict (64 "Caution").
   - Browser end-to-end: fresh scan of `google-labs-code/design.md` → auto-escalate →
     real detonation → **"Sandbox run"** (47→64), ~37s end-to-end.
   - The dishonest collapse is fixed: `finalNote`/`notVerified` key on `(deep, forensics)`.
     `deep=true, forensics=null` now renders "**the sandbox run did not complete on this
     pass**" + a distinct "Sandbox run incomplete" badge — it NEVER shares the
     never-escalated "Runtime was not executed in a sandbox on this pass" sentence.
     Derived at render → determinism (fresh==cached per SHA) holds. New distinctness test.

2. **#4 — warm-pool contradiction resolved (host LIFECYCLE, not isolation)** (f6aec3a).
   - The idle watchdog now **exempts the always-on production substrate host** (positive-ID
     via `cr-idle-exempt=1` metadata OR instance name `cr-host-build`; fail-safe when
     metadata is unreachable). Disposable dev/probe instances are still reclaimed; the
     prod host's cost is bounded by the 12h max-run backstop + the operator. Verified on
     the running host (dry-run: "exempt from idle-stop"; timer active).
   - microVM/forge boot is already parallel (forge∥image-build, agentic∥detonate). Measured
     real wall-clock: **35s** on a light escalating fixture, **~37s** full browser flow;
     honest split ~9s SSH/orchestrator start + ~1s parallel forge/build + ~22s microVM
     detonate + ~3s persist. clawdcursor's 80s is its own 63s npm install, reported
     separately from our ~12s overhead. (A warm microVM pool is the remaining sub-30s
     lever — the documented, deferred optimization; the isolation architecture is unchanged.)

3. **#2/#3 — real auth: profile, RLS, scoping, no phantom, survives refresh** (24705e2).
   - Real Google **avatar** (user_metadata.avatar_url → an `<img>` from
     lh3.googleusercontent.com, DOM-verified), name, and email render in sidebar + profile.
   - Removed the demo-seeded `scannedIds` (`expressjs/express` + `pallets/flask`) that
     bled phantom history into a logged-in user. History is now **hydrated from the
     user-scoped `scans` table** on sign-in (RLS `auth.uid()=user_id`), merged into
     liveReports without clobbering an in-session scan → survives refresh, correct per user.
   - SIGNED_OUT clears ALL personal state + bumps the live-scan token.
   - Proven: signed-in user sees only their 4 real DB scans (reload-persistent); profile
     shows "Static scans 2 · Sandbox runs 3". **RLS verified live**: anon REST reads of
     `scans`/`profiles` return `[]`; `reports`/`owners`/views public. RLS was already
     well-designed in the migrations — this was a verify + a client-side history/avatar fix.

4. **#5 — world map** (34b3481). The pipeline was functional; the "no dots" was data
   coverage (failed escalations → no egress geo; few located owners). Proven: `torvalds/linux`
   (Portland OR) renders a clickable green origin dot; a fresh scan of `antirez/kilo`
   captured "Catania, Sicily, Italy" → a second Italy dot appeared. Fixed a real honesty
   issue: the section was titled "Where caught code phones home / N destinations" while
   showing safe repos' origins — now "**Where scanned code comes from / N repos mapped**"
   (per-dot hover already distinguished origin vs egress).

5. **#6 — full sweep + Next.js console**. Console CLEAN across report/homepage/board
   (only dev React-DevTools + HMR; no hydration/React errors, no failed requests). Both
   themes render faithfully; all three badge states + score colors + reputation/behavior
   separation + owner avatars (github.com/{login}.png) + the Google user avatar verified.
   Fixed the escalation **timeline** which still narrated the retired two-VM
   trap/sinkhole while forensics said microVM+forge → renamed to "Bring up the forge /
   Boot the microVM / Detonate through the forge", `DEEP_RUN_CHAPTERS` kept old+new names
   for re-attach dedup, attach-forensics redeployed (9115798). Also fixed a pre-existing
   eslint failure (ignore `sandbox/**` like the other non-app trees).

6. **#7 — deploy-ready, NOT deployed** (ea6737e). Prod `npm run build` GREEN (tsc + 6/6
   static pages). Client bundle carries NO secrets — verified `.next/static` has zero
   occurrences of the runner key / `sb_secret_` / `service_role` / service-account JSON /
   `private_key` / `CLOUDSDK_PYTHON`; only the publishable key + URL. `docs/DEPLOY.md`
   documents the user's own steps: Vercel env, Supabase/Google redirect-URL allowlist,
   and the optional GitHub-OAuth provider setup. Gates: tsc 0, eslint 0, node 71/71.

## Not done (the user's own next steps, by instruction)
- `vercel deploy` (guide in docs/DEPLOY.md).
- Enabling the GitHub OAuth provider (guide in docs/DEPLOY.md).

## Discipline (aidhiraj_protocol)
- **COLD zero-context plan audit** before the non-trivial changes — caught the decisive
  fact (B1): the auto-detonation is fresh-scan-gated, not a passive loop, so the honest
  fix keys purely on the persisted `deep` flag (no schema/edge change). Also flagged the
  deep_error plumbing + attach-forensics 422 traps I would otherwise have hit.
- **INDEPENDENT zero-context review** after — NO blockers; confirmed clean: 3-state copy
  + determinism, no cross-user leak, race guarded, no XSS, watchdog fail-safe, map honest,
  no secrets leaked. Its one SHOULD-FIX + two nits were applied (commit 07fa0e3):
  `DEEP_RUN_CHAPTERS` was missing the emitted "Three agents read the code" chapter (would
  compound on re-detonation) → added + tested + redeployed; Avatar onError reset via the
  render-time prop-change pattern; loadUserHistory uses max(local, db) for the usage counts.

## Session-close hygiene
- Only instance is `cr-host-build`; no orphan dev/probe instances. Watchdog timer active,
  host `cr-idle-exempt=1`. **Host STOPPED (TERMINATED) at session end** — operator hygiene;
  the watchdog now exempts it so it will not self-stop, so the operator stops it between
  sessions and starts it with `provision-host.sh` when running deep scans. No GCP compute
  is left running; no trial credit burns idle.

## Gates (final)
- tsc 0 · eslint 0 · node 72/72 · deno _shared unchanged-logic (Set membership) · prod
  `npm run build` green · client bundle carries NO secrets. 7 commits, 26c5d33 → 07fa0e3.
