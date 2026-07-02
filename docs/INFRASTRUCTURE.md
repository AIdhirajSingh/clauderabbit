# INFRASTRUCTURE.md — Claude Rabbit

This file is the single source of truth for Claude Rabbit's infrastructure: the accounts, services, projects, credentials, secrets, and the server-side secret method. It is a **factual reference**, not a rulebook — `CLAUDE.md` holds the binding rules and SOP and points here for infra facts.

These are facts to use, not re-derive. Do not guess account IDs, project IDs, regions, secret names, model strings, or endpoints — they are recorded here exactly. If something here conflicts with an assumption, this file wins on infra facts.

---

## 1. Accounts & ownership

- **Google account (GCP + Gemini):** `[redacted-email]`
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

- **Project ID:** `redacted-gcp-project`
- **Project display name:** ClaudeRabbit
- **Project number:** `000000000000`
- **Billing account:** `000000-000000-000000`, `billingEnabled: true`
- **gcloud CLI:** authenticated as `[redacted-email]`
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
  - Service account: `clauderabbit-vertex@redacted-gcp-project.iam.gserviceaccount.com`
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
| `GCP_PROJECT_ID` | `redacted-gcp-project` — the GCP project for the Vertex client. |
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

## 8b. Detonation host lifecycle (the sandbox VM) — reproducible + self-cleaning

The dynamic-sandbox host is a single GCP VM (`cr-host-build`, n2-standard-4, nested-virt,
Ubuntu 24.04) running Kata + Firecracker microVMs + the deceptive forge. It is **fully
reproducible from committed code** — nothing on it is hand-tuned that isn't in a script:

- **Stand it up / resume it:** `bash sandbox/microvm/provision-host.sh` (add `--recreate`
  to delete + rebuild). Idempotent: creates the VM if absent, starts it if stopped, deploys
  `/opt/cr/{microvm,agent}` + `/opt/supabase/functions/_shared`, runs `setup-host.sh`,
  installs deno + OpenCode (+ `~/.config/opencode/opencode.json` = google-vertex@global),
  builds the base image, verifies. n2 nested-virt zones stock out transiently, so it tries a
  **zone fallback list** and prints `CR_HOST_ZONE=<zone>` at the end.
- **Set the zone to match:** put the landed zone in `.env.local` as `CR_SANDBOX_ZONE` so
  `/api/deep` SSHes to the right place (the app reaches the host over `gcloud compute ssh`).
  As of the last provision (a `--recreate` forced by a `us-east1-b` zone stockout that
  persisted for an extended period) the host landed in **`us-east4-c`**, after the
  fallback list tried `us-central1-a/c/b/f` and `us-east1-b` in turn, all stocked out
  at that moment — this is real, observed, transient GCP capacity behavior, not a fixed
  zone assignment; a future provision may land somewhere else in the list.
- **Cost rails (the host must never bleed credit unattended — it once ran ~2 days after an
  interrupted session):** an **idle auto-shutdown watchdog** (`setup-host.sh` Stage 8:
  systemd timer, `cr-idle-shutdown.sh`) powers the host **OFF after ~30 min** with no
  detonation heartbeat + nobody logged in + no detonation in flight; and a **max-run-duration
  backstop** (12h → STOP) reclaims a host even if the watchdog dies. `orchestrate-microvm.sh`
  refreshes `/run/cr-activity` each scan so a busy host never self-stops mid-work.
- **Survives its own stop/start:** an unclean poweroff corrupts the loopback devmapper
  thin-pool, so on every boot `cr-dm-pool.service` rebuilds a **fresh** pool and
  `cr-base-image.service` rebuilds the base image onto it (the pool only holds reproducible
  artifacts). A watchdog-stopped host that is later `provision-host.sh`-started (or bare
  `instances start`-ed) is detonation-ready with no manual fixups.
- **Tear it down:** `bash sandbox/microvm/teardown-host.sh [stop|delete]` at session end
  (belt to the watchdog). `stop` reclaims the running compute + keeps the disk; `delete`
  removes it (provision-host.sh rebuilds it from scratch).

### Dispatch queue — a real FIFO, not a flat 429

`/api/deep` holds at most `MAX_CONCURRENT = 2` simultaneous detonations in-process (the
host's 4-vCPU budget). A 3rd concurrent request used to get a flat 429 and be dropped; it
now **queues** instead:

- **In-process FIFO authority — `lib/deep-queue.ts`.** A pure, dependency-free ordered
  list of waiter tokens. This is the sole slot arbiter: `/api/deep` runs as a single Node
  controller process, so the existing `inFlight` counter plus this in-process queue are
  race-free by construction — ordering never depends on a DB round-trip. Admission is
  strict head-of-line (`canAcquire` = this token is the head AND a slot is free), so a
  later arrival can never jump an earlier waiter.
- **`deep_scan_queue` table (migration `20260702000002`) — observability + honest
  position only, NOT the slot lock.** One row per queued request (`token`,
  owner/repo/sha, a `queued`/`active`/`done`/`failed`/`timed_out` status, `created_at` as
  the FIFO key). SECURITY DEFINER RPCs (`deep_queue_enqueue` / `_position` / `_set_status`)
  are service-role only; RLS locked, no client access.
- **`supabase/functions/deep-queue` edge function** — a thin runner-key-gated wrapper
  over those RPCs (same auth pattern as `attach-forensics`: anon key for the gateway +
  `CR_DEEP_RUNNER_KEY` for the function). `lib/deep-queue-client.ts` calls it **best
  effort** — every call fails soft, so a DB/network hiccup never stalls the queue; the
  reported position falls back to the in-process standing if the DB call fails.
- **User-facing behavior:** the streaming NDJSON response stays open and emits
  `"Queued — position N of M, ~X min"`, refreshed periodically, computed from a real
  measured ~76s-per-detonation estimate (padded to 90s for attach/reset overhead). A
  waiter that can't get a slot within an 8-minute deadline gets an honest, specific
  "sandbox was too busy" error — never a silent drop — well under the client's 20-minute
  overall timeout so the server always speaks first.

### The on-demand pool — evaluated and reverted; a documented future path, not a running system

Earlier this session an on-demand compute-pool architecture was built and measured as a
scale-out alternative to the single host: a committed golden GCE image
(`cr-detonation-golden`) driving a Managed Instance Group with a stopped/suspended
standby pool, so a scan needing capacity could wake a warm standby instead of sharing one
box. It was fully built, benchmarked live, and then **reverted** (`git revert` of
`feat(sandbox): on-demand detonation compute pool (golden image + MIG standby pool)
(#41)`) — the MIG, its instance template, and the golden image baked for it have all
been **deleted from GCP**; only `cr-host-build` remains as a real instance.

**Why it was reverted:** the real, measured problem was activation latency, not
architecture. The actual need is a host that is available near-instantly for per-scan
microVM spin-up; waking a pool member from stopped/suspended did not deliver that.

**The real numbers, measured when the pool was evaluated (worth preserving for the next
time this is revisited, not currently running):**
- Cold create-from-image: **≈88s**
- Start-from-stopped: **≈44s**
- Resume-from-suspended: **≈21s**

If real concurrent-traffic data ever shows the single host's 2-slot ceiling — now
cushioned by the real queue above, not a hard reject — is genuinely the product's
bottleneck, a fleet/pool approach remains a real, previously-prototyped option to
revisit, informed by these measured numbers rather than re-deriving them from scratch.

**Rollback point:** the git tag `single-host-dispatch-known-good` points at the exact
commit that restored this single-host state. If this architecture is ever changed again,
that tag is the real, verified place to roll back to — no need to rediscover it.

---

## 9. State at last update

- GCP project set, billing live ($300 credit, expires 24 Sep 2026), `aiplatform` + `compute` APIs enabled.
- Vertex auth fully provisioned: service account `clauderabbit-vertex` with `roles/aiplatform.user`; key generated, verified, stored in Supabase secrets; local copy deleted.
- Supabase secrets present: `GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `GEMINI_API_KEY`.
- Local dev ADC set (developer machine only).
- `design.md` is inside the Claude Design zip at the repo root; the build unzips it, places it at root, and commits it.
- Not yet exercised in code: the edge function that reads `GOOGLE_SERVICE_ACCOUNT_JSON` and calls Vertex — that is built and verified in the build session.
