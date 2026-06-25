# Claude Rabbit

> **Everyone reads the code. We run it.**

A free, no-login-for-your-first-scan web tool: paste a public GitHub repo, fork, or
dependency, and get back a single honest **0–100 safety score** with a plain-language
report. Static scanners *read* source; Claude Rabbit clones the repo into a disposable,
isolated cloud sandbox and **actually runs it**, then watches what it does. Every report
is public and permanent at `/owner/repo`, shareable, and embeddable as a trust badge.

## How it works — a two-speed funnel

```
paste URL → API/edge fn → cache check (by commit SHA)
   └─ miss → FAST PATH (~95%): static signals + reputation + a fast model reads only
             the flagged regions → score + confidence
                └─ confident clean → ship verdict
                └─ suspicious / low-confidence → ESCALATE
                      → DEEP PATH (~5%): throwaway GCP VM clones, builds, runs, and
                        observes the repo (hermetic, egress-locked, reset every scan)
   → blend → 0–100 score → report generated from design.md → persist + public /owner/repo
```

Two safety rails, always: **(1)** no surface ever states a bare "Safe" — every verdict
shows its evidence and what was *not* verified; **(2)** the sandbox is hermetic (no real
credentials, locked egress, resource caps) and **reimaged/deleted after every scan**.

## Stack

| Layer | Choice |
|---|---|
| Web | **Next.js 16 (App Router) + React 19 + TypeScript** — homepage SPA, SSR `/owner/repo` SEO pages, API |
| DB / Auth / Edge | **Supabase** (Postgres + RLS, Google/GitHub/email auth, Deno edge functions) |
| Fast-path model | **Gemini via Vertex AI** (placeholder behind a clean swap seam — see below) |
| Sandbox | **Google Cloud Compute** — golden image + ephemeral VMs, egress-locked VPC (`sandbox/`) |
| Design | Faithful port of the shipped Claude Design spec (`design.md`) |

## The model swap seam

Models are **placeholders** behind one seam. The fast/deep model IDs are read from the
Supabase secrets `GEMINI_FAST_MODEL` / `GEMINI_DEEP_MODEL` and called through
`supabase/functions/_shared/vertex.ts`. To swap in the real models (DeepSeek fast-path,
Brave reputation, Kimi K2.7 + OpenCode in the sandbox), change those secrets / that one
module — orchestration, scoring, and the escalation gate are real and unchanged.

> Note: the documented `gemini-3.1-flash-lite` / `gemini-3.5-flash` strings 404 on the live
> trial project; the working live equivalents `gemini-2.5-flash-lite` / `gemini-2.5-flash`
> are used as defaults (configurable via the secrets above).

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the Supabase URL + publishable key (public values)
npm run dev                  # http://localhost:2311
```

`npm run lint` · `npm run typecheck` · `npm run build` all run clean (also enforced in CI).

## Secrets (server-side only — never in the client or the repo)

The client holds **only** `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
Everything else lives in Supabase edge-function secrets:
`GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `GEMINI_FAST_MODEL`,
`GEMINI_DEEP_MODEL`, `GITHUB_TOKEN` (optional). See `docs/INFRASTRUCTURE.md`.

```bash
supabase db push                          # apply migrations + seed
supabase functions deploy scan --no-verify-jwt
supabase secrets set NAME="value"
```

## Deploy to Vercel

1. Import the repo into Vercel (framework auto-detected: Next.js).
2. Set the three `NEXT_PUBLIC_*` env vars (from `.env.example`) in the Vercel project.
3. Deploy. The Supabase backend (DB + edge functions) is already live and deployed
   separately via the Supabase CLI; Vercel hosts the Next.js web layer.

## Repo layout

```
app/                     Next.js routes (SPA home, /[owner]/[repo] SSR report, /badge, /auth/callback)
components/spa/          the faithful design port (8 screens + shared chrome + state machine)
lib/                     score logic, types, demo seed, supabase clients, scan client, report view
supabase/migrations/     schema + RLS + scan-limit function
supabase/functions/scan/ the fast-path orchestrator (Vertex seam, GitHub fetch, static signals)
sandbox/                 the dynamic sandbox engine (the moat) — see sandbox/README.md
docs/                    north star, system design / PRD, UX, INFRASTRUCTURE
design.md                the shipped Claude Design spec (source of truth for the UI + reports)
```

Free, source-available, ad-supported. The accumulating database of vetted repos is the asset.
