# Deploying Claude Rabbit — the manual steps you do yourself

The app is deploy-ready: the production build is green, the client bundle carries
**no secrets** (only the Supabase publishable key + URL), all model/cloud credentials
live in Supabase edge-function secrets, and security headers + SSR SEO are in place.

The two things below are **yours to do** — they need your accounts and were left for
you on purpose. Everything else is done.

---

## What is already wired (nothing to do here)

- Supabase project `mjvlczaytkhvsolnhhkz`: schema, RLS, the `scan` + `attach-forensics` +
  `deep-queue` edge functions, and all secrets (`GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_*`,
  `GEMINI_*`, `GITHUB_TOKEN`, `CR_DEEP_RUNNER_KEY`, …) are set server-side.
- Google sign-in works today (the Google OAuth client + the Supabase callback
  `https://mjvlczaytkhvsolnhhkz.supabase.co/auth/v1/callback` are configured).
- The dynamic sandbox runs as Cloud Run Job executions (`cr-detonation`, region
  `us-central1`), triggered by the local `/api/deep` controller via the Cloud Run API —
  there is no per-scan host to SSH into anymore (see `docs/INFRASTRUCTURE.md` §8b).
  `/api/deep` is **inert on Vercel by default** (`CR_ALLOW_LOCAL_DEEP` unset → 403), so a
  deploy cannot trigger detonations. Deep scans keep running from your local controller
  and land in the shared DB; Vercel serves those cached deep reports to the world.
  When the website's own automatic follow-up call to `/api/deep` hits this gate (the
  normal case on Vercel), the report still renders honestly — the "Sandbox run
  incomplete" badge (tested, `tests/report-view-honesty.test.ts`) — and the toast shown
  to the visitor is a plain, real-user-facing sentence (`lib/scan.ts`'s `runDeepScan`),
  not this gate's own operator-facing error text.
- **The `scan` edge function itself never dispatches** — deciding escalation and
  triggering a real detonation are deliberately decoupled (the escalation decision is
  persisted regardless of whether a detonation ever runs). Only the website's SPA
  automatically follows up with `/api/deep` after an escalation. **The CLI and MCP
  server never call `/api/deep` at all** — by design, not an oversight — because
  neither can reach this developer-machine-only controller from wherever they actually
  run. Both surfaces are honest about it on every escalated result instead: the CLI's
  text/`--json` output and the MCP tool's response both carry `escalationDecided` /
  `sandboxActuallyRan`, and the CLI prints an explicit "flagged as ambiguous enough to
  escalate, but escalation being decided is not the same as a sandbox run happening" note
  (`cli/src/lib/format.ts`) rather than ever implying a detonation happened. A caller
  that wants the real detonation to run must do so from the machine actually operating
  the local controller (the same one this section documents) — a raw API call
  bypassing all three of these real surfaces is the only way to end up with an
  escalation decision and no path to an honest explanation of it.

---

## Step 1 — Deploy to Vercel

Import the repo in Vercel and set exactly these **Project Environment Variables**
(client-safe; these are the only env vars the deployed app needs):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://mjvlczaytkhvsolnhhkz.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B` |
| `NEXT_PUBLIC_SITE_URL` | the real production domain, `https://clauderabbit.in` |

Do **not** add `CR_*`, `CLOUDSDK_PYTHON`, or any secret to Vercel — those are for the
local deep-scan controller only and must never reach a deploy. Then deploy. Once you
know the final URL, make sure `NEXT_PUBLIC_SITE_URL` matches it and redeploy.

---

## Step 2 — Add the Vercel origin to Supabase Auth (required for sign-in)

Google sign-in redirects back to `NEXT_PUBLIC_SITE_URL`, and Supabase only honors
redirect URLs on its allowlist. In the Supabase dashboard →
**Authentication → URL Configuration**:

- **Site URL:** set to the real production domain (`https://clauderabbit.in`).
- **Redirect URLs:** add both
  - `https://<your-domain>/auth/callback`
  - `https://<your-domain>/**` (wildcard, so previews/paths work)
  - keep `http://localhost:2311/auth/callback` for local dev, and keep any prior
    `*.vercel.app` entries around during a domain transition rather than removing
    them immediately.

That's all Google sign-in needs on prod — the Google OAuth client already trusts the
Supabase callback, and Supabase forwards to whichever app URL is on this allowlist.
(If you add a custom domain later, add it here too.)

---

## Step 3 — GitHub sign-in is intentionally NOT offered (a deliberate V1 scope decision, not a TODO)

GitHub is not a configured Supabase auth provider, and there is no "Continue with GitHub"
button anywhere in the product — it was removed entirely (not disabled, not a
graceful-failure toast) since CLAUDE.md scopes V1 auth to Google + email only. Google is
the sole OAuth option on the real login screen (`components/spa/components/LoginForm.tsx`).

If GitHub sign-in is ever actually wanted, it needs to be built back from scratch: a
Supabase-side provider config (GitHub OAuth App → Supabase **Authentication → Providers →
GitHub**, same as Google) AND real client code — a `signInWithGitHub` handler
(`components/spa/state.tsx`'s `signInWithProvider` is typed to accept only `"google"`
today, deliberately, so this can't silently regress) and a real GitHub button back in
`LoginForm.tsx`. Toggling only the Supabase config would not turn GitHub sign-in back on
by itself.

---

## Step 4 — Keep the deep-scan controller running locally (unchanged)

Deep scans (the ~5% that escalate) run on your machine, not on Vercel. On the
controller machine, `.env.local` must have (this is gitignored, never committed):

```
NEXT_PUBLIC_SUPABASE_URL=…            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=…
CR_ALLOW_LOCAL_DEEP=1                 CR_RUN_JOB_NAME=cr-detonation
CR_RUN_REGION=us-central1
# Windows only, if `python` hits the Store alias:
CLOUDSDK_PYTHON=…\google-cloud-sdk\platform\bundledpython\python.exe
# Windows only, if `/api/deep` 501s with "needs gcloud on the sandbox
# controller": the Node process that runs `next dev`/`next start` may inherit a
# thinner PATH than an interactive shell (this bit a Claude Preview-launched dev
# server on one real machine — bash and gcloud were both on the interactive
# shell's PATH but not the preview tool's spawned process). Pin both explicitly:
CR_BASH=C:\Program Files\Git\usr\bin\bash.exe
CR_SANDBOX_PATH_PREPEND=/c/Users/<you>/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin
```

- No host to bring up or keep warm anymore — `/api/deep` triggers a `cr-detonation`
  Cloud Run Job execution per scan directly via the Cloud Run API (`gcloud run jobs
  execute`). The one thing that DOES need to stay running is the shared NVA gateway VM
  (`cr-forge-gateway`) every detonation's egress routes through — it's a small,
  persistent VM (not per-scan), already up; there's nothing to provision per session.
  See `docs/INFRASTRUCTURE.md` §8b for the full architecture.

---

## Quick verification after Step 1–2

- Open the Vercel URL, sign in with Google → your name, email, and Google avatar show,
  and a fresh account has an empty history.
- Open any `/{owner}/{repo}` report and the Danger Board — they render for
  logged-out visitors too (public surfaces).
- The browser console is clean (no hydration/errors).
