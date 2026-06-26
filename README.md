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
                      → DEEP PATH (~5%): an AGENTIC analyzer on a throwaway GCP VM —
                        Gemini agents (brain OUTSIDE the blast radius) explore the whole
                        repo for what stage-1 missed, then DETONATE chosen files as a
                        non-root user under a monitored sinkhole, recording CODE-VERIFIED
                        facts (hermetic, egress-locked, no real packet leaves, reset every scan)
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
| Models | **All-Gemini via Vertex AI** — fast `gemini-3.1-flash-lite`, deep/agent `gemini-3.5-flash` (swap seam intact for a future Kimi K2.7 deep-path swap) |
| Scoring | **Code-computed** deterministic formula (`_shared/scoring.ts`) — the model feeds weighted signals; code decides the cited 0–100 |
| Sandbox | **Agentic behavioral analyzer** on Google Cloud — knowledge-graph explore + sinkhole detonate, code-verified facts (`sandbox/`) |
| Design | Faithful port of the shipped Claude Design spec (`design.md`) |

## The model swap seam

**Gemini-via-Vertex is the production model layer** (all-Gemini). The fast/deep model IDs
are read from the Supabase secrets `GEMINI_FAST_MODEL` / `GEMINI_DEEP_MODEL` and called
through `supabase/functions/_shared/vertex.ts`; the agentic sandbox tier
(`sandbox/agent/vertex_client.py`) runs `gemini-3.1-flash-lite` (explore) + `gemini-3.5-flash`
(advisor/analysis), proven live via the `global` Vertex location (decoupled through
`VERTEX_LOCATION`). The seam stays intact for a future **Kimi K2.7 Code** deep-path swap —
change the secret / that one module; orchestration, the code-computed scoring, and the
escalation gate are real and unchanged.

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
