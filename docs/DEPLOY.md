# Deploying Claude Rabbit — the manual steps you do yourself

The app is deploy-ready: the production build is green, the client bundle carries
**no secrets** (only the Supabase publishable key + URL), all model/cloud credentials
live in Supabase edge-function secrets, and security headers + SSR SEO are in place.

The two things below are **yours to do** — they need your accounts and were left for
you on purpose. Everything else is done.

---

## What is already wired (nothing to do here)

- Supabase project `mjvlczaytkhvsolnhhkz`: schema, RLS, the `scan` + `attach-forensics`
  edge functions, and all secrets (`GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_*`, `GEMINI_*`,
  `GITHUB_TOKEN`, `CR_DEEP_RUNNER_KEY`, …) are set server-side.
- Google sign-in works today (the Google OAuth client + the Supabase callback
  `https://mjvlczaytkhvsolnhhkz.supabase.co/auth/v1/callback` are configured).
- The dynamic sandbox runs on the GCP host `cr-host-build` (us-east1-b), driven by the
  local `/api/deep` controller. `/api/deep` is **inert on Vercel by default**
  (`CR_ALLOW_LOCAL_DEEP` unset → 403), so a deploy cannot spawn VMs. Deep scans keep
  running from your local controller and land in the shared DB; Vercel serves those
  cached deep reports to the world.

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

## Step 3 — Enable GitHub sign-in (optional, do it when you want it)

GitHub is offered as a sign-in provider in the UI but the provider is not enabled yet.
To turn it on:

1. **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   - Homepage URL: your Vercel URL
   - **Authorization callback URL:** `https://mjvlczaytkhvsolnhhkz.supabase.co/auth/v1/callback`
   - Create it, then generate a **client secret**.
2. **Supabase dashboard → Authentication → Providers → GitHub**
   - Enable it; paste the **Client ID** and **Client Secret** from step 1; save.
3. Sign-in with GitHub now works with no code change (the button already calls the
   `github` provider). Nothing to redeploy.

---

## Step 4 — Keep the deep-scan controller running locally (unchanged)

Deep scans (the ~5% that escalate) run on your machine, not on Vercel. On the
controller machine, `.env.local` must have (this is gitignored, never committed):

```
NEXT_PUBLIC_SUPABASE_URL=…            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=…
CR_ALLOW_LOCAL_DEEP=1                 CR_SANDBOX_ZONE=us-east1-b
CR_DEEP_RUNNER_KEY=<must equal the Supabase CR_DEEP_RUNNER_KEY secret>
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

- Bring the host up / keep it warm: `bash sandbox/microvm/provision-host.sh`
  (idempotent; starts it if stopped). Set `CR_SANDBOX_ZONE` to the landed zone.
- The host is **always-on by design** (the idle watchdog now exempts it; a 12h
  max-run backstop reclaims it only if truly abandoned). Stop it between work
  sessions with `bash sandbox/microvm/teardown-host.sh stop` to save credit.

---

## Quick verification after Step 1–2

- Open the Vercel URL, sign in with Google → your name, email, and Google avatar show,
  and a fresh account has an empty history.
- Open any `/{owner}/{repo}` report and the Danger Board — they render for
  logged-out visitors too (public surfaces).
- The browser console is clean (no hydration/errors).
