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

---

## Step 1 — Deploy to Vercel

Import the repo in Vercel and set exactly these **Project Environment Variables**
(client-safe; these are the only env vars the deployed app needs):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://mjvlczaytkhvsolnhhkz.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B` |
| `NEXT_PUBLIC_SITE_URL` | your final Vercel URL, e.g. `https://clauderabbit.vercel.app` |

Do **not** add `CR_*`, `CLOUDSDK_PYTHON`, or any secret to Vercel — those are for the
local deep-scan controller only and must never reach a deploy. Then deploy. Once you
know the final URL, make sure `NEXT_PUBLIC_SITE_URL` matches it and redeploy.

---

## Step 2 — Add the Vercel origin to Supabase Auth (required for sign-in)

Google sign-in redirects back to `NEXT_PUBLIC_SITE_URL`, and Supabase only honors
redirect URLs on its allowlist. In the Supabase dashboard →
**Authentication → URL Configuration**:

- **Site URL:** set to your Vercel URL (e.g. `https://clauderabbit.vercel.app`).
- **Redirect URLs:** add both
  - `https://<your-vercel-domain>/auth/callback`
  - `https://<your-vercel-domain>/**` (wildcard, so previews/paths work)
  - keep `http://localhost:2311/auth/callback` for local dev.

That's all Google sign-in needs on prod — the Google OAuth client already trusts the
Supabase callback, and Supabase forwards to whichever app URL is on this allowlist.
(If you add a custom domain later, add it here too.)

---

## Step 3 — GitHub sign-in is intentionally NOT offered (a deliberate V1 scope decision, not a TODO)

GitHub is not a configured Supabase auth provider, and — as of a bug-sweep fix this
session — the "Continue with GitHub" button no longer even attempts it: it shows an
honest "GitHub sign-in isn't available yet — use Google or email" message instantly,
rather than trying a real OAuth call that could only fail server-side. This was a real
fix, not an oversight: CLAUDE.md scopes V1 auth to Google + email only, and the button
previously produced a generic, misleading failure toast indistinguishable from a network
blip.

If GitHub sign-in is ever actually wanted, it now needs BOTH a Supabase-side provider
config (GitHub OAuth App → Supabase **Authentication → Providers → GitHub**, same as
Google) AND a client-code change (`components/spa/state.tsx`'s `signInWithGitHub` would
need to route through `signInWithProvider` again, and `signInWithProvider`'s type
signature would need to accept `"github"` again — it was deliberately narrowed to
`"google"` only so this can't silently regress). Toggling only the Supabase config, as
this step used to instruct, would NOT turn GitHub sign-in back on by itself anymore.

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
