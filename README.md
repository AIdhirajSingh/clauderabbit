# ClaudeRabbit

> **Open source ships malware, too.**

More than 454,600 new malicious open-source packages appeared in 2025 — up 75% in a
year — and the attacks that matter carry no CVE at all; they only exist at runtime.
ClaudeRabbit is a free, open-source security product for the developer community.
Paste any public GitHub repo and we clone it into an isolated sandbox, run it for real,
and hand back one honest **0–100 safety score**: what the project is, what it did when
we ran it, and what we could not verify. Every report is public and permanent at
`/owner/repo`, shareable, and embeddable as a trust badge — a public good, not a
paywalled one. Signing in only saves your own scan history; it never buys you more.

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

## Using it

**On the web** — go to the site, paste a GitHub URL (or `owner/repo`), hit scan. No
login required; signing in with Google or email just saves your scan history.

**From the terminal** — the [CLI](cli/) (`clauderabbit`) scans a repo or npm
package before you install or clone it:

```bash
cd cli && npm install && npm run build && npm link   # one-time setup
clauderabbit scan expressjs/express                  # run a real scan
```

**From an AI coding agent** — the [MCP server](mcp-server/) exposes one cache-aware `scan`
tool over stdio so an agent can check a dependency before running it (also served remotely
over Streamable HTTP at `clauderabbit.in/mcp` for claude.ai custom connectors). Build
it once (`cd mcp-server && npm install && npm run build`), then wire it into Claude Desktop
with `cd cli && npm install && npm run build && node dist/index.js mcp install` — it finds
your real `claude_desktop_config.json` (including the Windows MSIX/Store install's different
path) and adds the entry for you.

Both the CLI and the MCP server call the same public scan API the website uses and require a
signed-in ClaudeRabbit account (a real product/access decision, not because the data is
sensitive — report pages stay public either way); the first call opens your browser to sign in
once, then stays silent until you log out. See [cli/README.md](cli/README.md) and
[mcp-server/README.md](mcp-server/README.md) for the full command/tool reference.

## Stack

| Layer | Choice |
|---|---|
| Web | **Next.js 16 (App Router) + React 19 + TypeScript** — homepage SPA, SSR `/owner/repo` SEO pages, API |
| DB / Auth / Edge | **Supabase** (Postgres + RLS, Google + email/OTP auth, Deno edge functions) |
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

## Distribution surfaces (scan at the moment of install)

Beyond `scan`, the CLI also wraps `npm-install` / `pnpm-install` / `git-clone` so it can
scan the target and print the honest verdict before running the real command, with
opt-in bash/zsh/PowerShell hooks (`install-hooks`) that put that check in front of every
install/clone. Both the CLI and the MCP server honor the same rails as the web report —
reputation kept separate from code/behavior, sandbox-actually-ran reported honestly
(keyed to a real forensic record, not the escalation flag), and never a bare "Safe."

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
app/                     Next.js routes (SPA home, /[owner]/[repo] SSR report, /badge, /auth/callback, /api/deep)
components/spa/          the faithful design port (8 screens + shared chrome + state machine)
lib/                     score logic, types, demo seed, supabase clients, scan client, report view
supabase/migrations/     schema + RLS + scan-limit function
supabase/functions/scan/ the fast-path orchestrator (Vertex seam, GitHub fetch, static signals)
sandbox/                 the dynamic sandbox engine (the moat) — see sandbox/README.md;
                         sandbox/microvm/ holds the golden-image + on-demand compute-pool scripts
cli/                     the clauderabbit CLI (scan / install-clone wrappers / shell hooks)
mcp-server/              MCP server (one cache-aware scan tool over stdio for AI coding tools)
docs/                    north star, system design / PRD, UX, INFRASTRUCTURE
design.md                the shipped Claude Design spec (source of truth for the UI + reports)
```

Free and unlimited, no login or ads ever required to scan. The accumulating database of
vetted repos is the real asset — see `docs/INFRASTRUCTURE.md` for the honest current
state of the (currently unsolved) monetization question.
