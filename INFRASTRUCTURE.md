# INFRASTRUCTURE.md — Claude Rabbit

This file is the single source of truth for Claude Rabbit's infrastructure: the accounts, services, projects, credentials, secrets, and the server-side secret method. It is a **factual reference**, not a rulebook — `CLAUDE.md` holds the binding rules and SOP and points here for infra facts.

These are facts to use, not re-derive. Do not guess account IDs, project IDs, regions, secret names, model strings, or endpoints — they are recorded here exactly. If something here conflicts with an assumption, this file wins on infra facts.

---

## 1. Accounts & ownership

- **Google account (GCP + Gemini):** `manishpratapsingh@gmail.com`
- **GitHub:** user `AIdhirajSingh`, repo `clauderabbit` — `https://github.com/AIdhirajSingh/clauderabbit.git`
- **Local repo path (Windows):** `C:\Users\manis\Development\clauderabbit`
- **Shell:** PowerShell 7.6.3

---

## 2. Framework & runtime

- **Web layer: Next.js (App Router).** Server-rendered report pages are the SEO surface. The same app serves the homepage, the public `/owner/repo` reports, and the API routes that orchestrate scans. This is the framework for the entire web layer — do not substitute another.
- **Edge runtime: Supabase Edge Functions run on Deno (TypeScript).** All server-side work — scanning, score blending, model/search calls, DB writes — happens here. This is why the Gemini SDK used is the **JavaScript/TypeScript** `@google/genai`, not the Python `google-genai` (see §6).
- **Local preview:** the app runs on **localhost:2311**. Derive run commands from the real `package.json` / Supabase config at the moment of use; do not pre-write a command table.

---

## 3. Supabase

- **Project:** `clauderabbit`
- **Project ref:** `mjvlczaytkhvsolnhhkz`
- **Region:** South Asia (Mumbai), `ap-south-1`
- **URL:** `https://mjvlczaytkhvsolnhhkz.supabase.co`
- **Provides:** Postgres database, Auth (Google + email), and Edge Functions.
- **Key system: the NEW Supabase key system** — publishable `sb_publishable_…` (client) + secret `sb_secret_…` (server). The legacy JWT `anon` / `service_role` keys are deprecated and are **not** used.
- **Client env holds ONLY:**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B`
- The Supabase secret key is auto-available to edge functions as `SUPABASE_SECRET_KEYS`. Do not duplicate it into a custom secret.

---

## 4. GCP (Google Cloud)

- **Project ID:** `gen-lang-client-0062239756`
- **Project display name:** ClaudeRabbit
- **Project number:** `335188180223`
- **Billing account:** `01CE66-086F73-F3E45C`, `billingEnabled: true`
- **gcloud CLI:** authenticated as `manishpratapsingh@gmail.com`
- **Enabled APIs:**
  - `aiplatform.googleapis.com` — Agent Platform API (formerly Vertex AI; same endpoint, renamed at console level). This is the Gemini-via-Vertex backend.
  - `compute.googleapis.com` — Compute Engine API, for the dynamic sandbox VMs.
- This project is Claude Rabbit's permanent GCP home: Gemini-via-Vertex now, sandbox VMs later.

### Free-trial credit
- **$300 / ₹28,710 free-trial Welcome credit, active.** Expires **24 September 2026** (90 days).
- **What the credit covers:** any GCP service, **including the Vertex AI Gemini API** and Compute Engine sandbox VMs — one pool covers both.
- **What the credit does NOT cover:** the Gemini **Developer API (AI Studio)** — that is explicitly excluded from the $300 trial. This is the core reason Gemini is called via **Vertex**, not AI Studio (see §6).
- **Free-trial restrictions in force** (non-billable trial account): no GPUs on VMs, max 8 Compute Engine cores at once, no Windows Server VM images, no quota-increase requests. None of these block the V1 sandbox (Linux, no GPU, default quota). Upgrading to a paid account lifts these and keeps the remaining credit.

---

## 5. AI models (current placeholder phase: Gemini everywhere)

The escalation logic and two-speed funnel are real and permanent; only the model identities are placeholders, sitting behind a clean swap seam so the real models drop in later without touching orchestration.

- **Fast path:** `gemini-3.1-flash-lite` — GA, cost-efficient, high-volume. (Note: the old `gemini-3.1-flash-lite-preview` string is discontinued July 9, 2026 — use the bare GA string `gemini-3.1-flash-lite`.)
- **Deep / escalated path:** `gemini-3.5-flash` — GA (released 19 May 2026), most capable Flash model, optimized for agentic + coding tasks. Default thinking effort is `medium`; for hard sandbox-adjudication cases, `high` can be set per call.
- **Two instances, real escalation gate preserved.** Gemini is the placeholder proving the end-to-end pipe. Real models (DeepSeek fast-path, Brave reputation, Kimi K2.7 + OpenCode in the sandbox) swap in later behind the same seam — swapping the model proves the wrapper; the sandbox engine is the separate, real product.

---

## 6. Gemini-via-Vertex — the backend, SDK, and auth

**Backend decision: Gemini is called through the Vertex AI backend (Agent Platform), NOT the AI Studio / Gemini Developer API.** Reason: the $300 credit pays for Vertex Gemini calls but explicitly does not pay for AI Studio Gemini calls (§4). Same models, same model strings, different backend + auth.

- **SDK in the app:** `@google/genai` (the unified JS/TS Gen AI SDK), used inside the Deno edge functions. The Python `google-genai` and the legacy `google-generativeai` / deprecated `vertexai.generative_models` modules are **not** used. (The unified SDK supports both AI Studio and Vertex backends via one flag, so the seam is a config switch.)
- **Vertex backend selection:** initialize the client for Vertex — `vertexai: true`, with project and location — rather than an AI Studio API key.
- **Endpoint:** `aiplatform.googleapis.com` (unchanged through the Vertex → Agent Platform rename).
- **Region / location:** `us-central1` (broadest Gemini model availability; stored as the `GCP_LOCATION` secret so it can change without code edits).

### Auth — two mechanisms, two contexts
- **Production (the app):** a dedicated **service account** authenticates Vertex.
  - Service account: `clauderabbit-vertex@gen-lang-client-0062239756.iam.gserviceaccount.com`
  - Role: `roles/aiplatform.user` (can call models; cannot administer the project).
  - Its JSON key is stored **only** in Supabase secrets as `GOOGLE_SERVICE_ACCOUNT_JSON` (see §7). No copy on disk, in Drive, or in the repo.
- **Local dev (developer machine only):** Application Default Credentials via `gcloud auth application-default login`. Never ships. Not used by the deployed app.

---

## 7. Secrets — server-side method (absolute)

**All model/search/cloud credentials live in Supabase Edge Function secrets, server-side. Never client-side. Never in the repo.** Every scan, score blend, and model/search call happens in edge functions where the secrets live. The client app only points at Supabase (URL + publishable key); Supabase holds the rest.

### Secrets currently set in Supabase (names only — values are encrypted, never shown)
| Secret name | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service-account JSON key for Vertex auth. The edge function parses this and feeds it to `@google/genai` as the Vertex credential. |
| `GCP_PROJECT_ID` | `gen-lang-client-0062239756` — the GCP project for the Vertex client. |
| `GCP_LOCATION` | `us-central1` — the Vertex region. |
| `GEMINI_API_KEY` | AI Studio Gemini key from the earlier placeholder phase. Retained but superseded by the Vertex path; not the production model-auth path. |

Plus Supabase's own auto-provided `SUPABASE_SECRET_KEYS` (do not duplicate).

### How the edge function uses them
The edge function reads these via the Deno env (e.g. `Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")`), parses the JSON key, and initializes `@google/genai` against the Vertex backend with `GCP_PROJECT_ID` + `GCP_LOCATION`. The client never sees any of this.

### Secret rules (binding)
- **Never commit** `.env`, `.env.local`, `.env*`, or `*-key.json`. Confirm `.gitignore` covers them before any commit that could touch them.
- **Never place a real key client-side or in the repo.** If about to, stop.
- Service-account keys are **disposable, not backup-worthy**: if one is lost or exposed, rotate (generate a new key, delete the old) rather than restoring a backup. The key lives in exactly one place — Supabase secrets.

### Setting / updating a secret (reference)
From the repo root, linked to the Supabase project:
```
supabase secrets set NAME="value"
supabase secrets list      # shows names + digests only, never values
```

---

## 8. Tooling around the build (context, not app infra)

- **Build environment:** Claude Code (YOLO / bypass-permissions), Opus 4.8, via the Claude Desktop Code tab + the Claude Code CLI (shared `~/.claude/` config).
- **Installed globally:** ECC, Superpowers, the `aidhiraj_protocol` skill, official Anthropic skills, Context7 (live library docs MCP).
- **UI verification:** Claude in Chrome (drives localhost:2311 — console/DOM/network read; connect from the CLI if the desktop app fails to connect).
- **Version control:** GitHub; committed docs are the source of truth.

---

## 9. State at last update

- GCP project set, billing live ($300 credit, expires 24 Sep 2026), `aiplatform` + `compute` APIs enabled.
- Vertex auth fully provisioned: service account `clauderabbit-vertex` with `roles/aiplatform.user`; key generated, verified, stored in Supabase secrets; local copy deleted.
- Supabase secrets present: `GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `GEMINI_API_KEY`.
- Local dev ADC set (developer machine only).
- `design.md` is inside the Claude Design zip at the repo root; the build unzips it, places it at root, and commits it.
- Not yet exercised in code: the edge function that reads `GOOGLE_SERVICE_ACCOUNT_JSON` and calls Vertex — that is built and verified in the build session.
