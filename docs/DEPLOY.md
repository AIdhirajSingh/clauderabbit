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
  `us-central1`; see `docs/INFRASTRUCTURE.md` §8b). **The deployed website itself
  triggers these executions** — `app/api/deep/route.ts` calls the Cloud Run Admin v2
  REST API directly over HTTPS (`lib/cloud-run-dispatch.ts`), authenticating with a
  dedicated least-privilege service account (`cr-dispatch@…`, `CR_RUN_SA_JSON`). There
  is no dependency on a local `gcloud` CLI or an operator machine: a real visitor's scan
  on `clauderabbit.in` that escalates gets a **real detonation, run by Vercel**, and a
  genuine "Sandbox run" badge with real forensics.
  - This is the primary path and it requires `CR_RUN_SA_JSON` (+ `CR_DEEP_RUNNER_KEY`
    for the live progress timeline) to be set as Vercel Project Environment Variables —
    see Step 1 below. When the credential is present, `/api/deep` uses the REST dispatch
    on any host.
  - The **local `gcloud` controller** (`CR_ALLOW_LOCAL_DEEP=1`, localhost-gated, spawns a
    real child process) is now only a **developer fallback**, reachable only when
    `CR_RUN_SA_JSON` is NOT configured. It is not how production detonates.
  - If NEITHER dispatch backend is configured, `/api/deep` returns an honest
    `reason: "unavailable"` and the report renders the "Sandbox run incomplete" badge
    (tested, `tests/report-view-honesty.test.ts`) rather than a fabricated result. This
    is now a genuine misconfiguration state, not the normal Vercel behavior.
- **The `scan` edge function itself never dispatches** — deciding escalation and
  triggering a real detonation are deliberately decoupled (the escalation decision is
  persisted regardless of whether a detonation ever runs). Only the website's SPA
  automatically follows up with `/api/deep` after an escalation, and on production that
  `/api/deep` call now runs a real detonation via the REST dispatch above. **The CLI and
  MCP server never call `/api/deep` at all** — by design, not an oversight — because
  they are honest about the escalation/detonation distinction in a text interface rather
  than streaming a live sandbox run. Both surfaces carry `escalationDecided` /
  `sandboxActuallyRan` on every escalated result: the CLI's text/`--json` output and the
  MCP tool's response, and the CLI prints an explicit "flagged as ambiguous enough to
  escalate, but escalation being decided is not the same as a sandbox run happening" note
  (`cli/src/lib/format.ts`) rather than ever implying a detonation happened. (A future
  CLI/MCP enhancement could trigger the same REST dispatch and poll the report; today
  they point the user to the web report, which does run it.)

---

## Step 1 — Deploy to Vercel

Import the repo in Vercel and set these **Project Environment Variables**. The three
`NEXT_PUBLIC_*` are client-safe; the two `CR_*` are **server-side secrets** (Node
runtime only, never `NEXT_PUBLIC_`, never sent to the browser) that power the real
production detonation dispatch:

| Name | Value | Scope |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://mjvlczaytkhvsolnhhkz.supabase.co` | client |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B` | client |
| `NEXT_PUBLIC_SITE_URL` | the real production domain, `https://clauderabbit.in` | client |
| `CR_RUN_SA_JSON` | the `cr-dispatch@…` service-account JSON (one line) | **server secret** |
| `CR_DEEP_RUNNER_KEY` | the deep-queue runner key (GCP Secret Manager `cr-deep-runner-key`) | **server secret** |

`CR_RUN_SA_JSON` is the dedicated, least-privilege dispatcher SA whose ONLY permissions
are `run.jobs.run` on the single `cr-detonation` job plus `actAs` on the job's runtime
SA — its entire blast radius if leaked is "can run this one sandbox job." It is what lets
the deployed website trigger real detonations (`lib/cloud-run-dispatch.ts`).
`CR_DEEP_RUNNER_KEY` is optional but recommended — without it detonations still run and
attach real forensics, but the live per-step progress timeline (Cloning… → Installing… →
Running…) degrades to just start/finish.

Do **not** add `CR_ALLOW_LOCAL_DEEP`, `CR_BASH`, `CLOUDSDK_PYTHON`, or the local-gcloud
`CR_*` vars to Vercel — those are for the developer-fallback local controller only.
Then deploy. Once you know the final URL, make sure `NEXT_PUBLIC_SITE_URL` matches it and
redeploy.

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

## Step 4 — Production detonates on its own; the local controller is now just a dev fallback

**Production does not need your machine.** With `CR_RUN_SA_JSON` set in Vercel (Step 1),
the deployed website itself triggers every `cr-detonation` Cloud Run execution via the
Cloud Run Admin REST API. A real visitor's escalated scan detonates for real with nothing
of yours switched on. The one shared piece of always-on infra is the NVA gateway VM
(`cr-forge-gateway`) every detonation's egress routes through — a small persistent VM
(not per-scan), already up; nothing to provision per session. See
`docs/INFRASTRUCTURE.md` §8b.

The **local gcloud controller** below is now only for **local development** (running
`next dev` and detonating from your own machine without deploying). It is a fallback:
`/api/deep` only uses it when `CR_RUN_SA_JSON` is NOT set. To use it, `.env.local`
(gitignored, never committed) needs:

```
NEXT_PUBLIC_SUPABASE_URL=…            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=…
CR_ALLOW_LOCAL_DEEP=1                 CR_RUN_JOB_NAME=cr-detonation
CR_RUN_REGION=us-central1
# Windows only, if `python` hits the Store alias:
CLOUDSDK_PYTHON=…\google-cloud-sdk\platform\bundledpython\python.exe
# Windows only, if `/api/deep` 501s with "needs gcloud on the sandbox
# controller": the Node process that runs `next dev`/`next start` may inherit a
# thinner PATH than an interactive shell. Pin both explicitly:
CR_BASH=C:\Program Files\Git\usr\bin\bash.exe
CR_SANDBOX_PATH_PREPEND=/c/Users/<you>/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin
```

Alternatively — and this is the recommended way to test the REAL production path
locally — set `CR_RUN_SA_JSON` (the dispatcher SA JSON) in `.env.local` instead. Then
`next dev` exercises the exact same Cloud Run REST dispatch production uses, no local
gcloud needed. That is how the production path is verified before every deploy.

---

## Quick verification after Step 1–2

- Open the Vercel URL, sign in with Google → your name, email, and Google avatar show,
  and a fresh account has an empty history.
- Open any `/{owner}/{repo}` report and the Danger Board — they render for
  logged-out visitors too (public surfaces).
- The browser console is clean (no hydration/errors).
