# INFRASTRUCTURE.md — Claude Rabbit

This file is the single source of truth for Claude Rabbit's infrastructure: the accounts, services, projects, credentials, secrets, and the server-side secret method. It is a **factual reference**, not a rulebook — `CLAUDE.md` holds the binding rules and SOP and points here for infra facts.

These are facts to use, not re-derive. Do not guess account IDs, project IDs, regions, secret names, model strings, or endpoints — they are recorded here exactly. If something here conflicts with an assumption, this file wins on infra facts.

---

## 1. Accounts & ownership

- **Google account (GCP + Gemini):** `247739561+AIdhirajSingh@users.noreply.github.com`
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
- **Billing account:** `REDACTED-BILLING-ACCOUNT`, `billingEnabled: true`
- **gcloud CLI:** authenticated as `247739561+AIdhirajSingh@users.noreply.github.com`
- **Enabled APIs:**
  - `aiplatform.googleapis.com` — Agent Platform API (formerly Vertex AI; same endpoint, renamed at console level). This is the Gemini-via-Vertex backend.
  - `compute.googleapis.com` — Compute Engine API, for the dynamic sandbox VMs.
- This project is Claude Rabbit's permanent GCP home: Gemini-via-Vertex now, sandbox VMs later.

### Free-trial credit
- **$300 / ₹28,710 free-trial Welcome credit, active.** Expires **24 September 2026** (90 days).
- **What the credit covers:** any GCP service, **including the Vertex AI Gemini API** and Compute Engine sandbox VMs — one pool covers both.
- **What the credit does NOT cover:** the Gemini **Developer API (AI Studio)** — that is explicitly excluded from the $300 trial. This is the core reason Gemini is called via **Vertex**, not AI Studio (see §6).
- **Compute quota (VERIFIED 2026-07-02 via `gcloud compute regions describe us-east1`, NOT re-derived):** the old "max 8 Compute Engine cores" claim was STALE — the billing account is open/enabled (`billingEnabled: true`) and the real region quota in **us-east1** is **`N2_CPUS` limit = 200, `CPUS` limit = 200** (usage 0). So the detonation pool's real ceiling today is ~**50 × n2-standard-4 hosts = ~100 concurrent deep scans** (2 slots/host) with no quota-increase request. Two other real caps to respect: **`INSTANCES` limit = 24 per region** (the binding ceiling before N2_CPUS — ~24 running hosts = ~48 concurrent scans without raising it), and **`PREEMPTIBLE_CPUS` limit = 0** (spot/preemptible VMs are NOT available on this account — the sandbox must use standard N2, never spot). Reaching literal "hundreds of concurrent scans" needs a quota increase on `INSTANCES` (and eventually `N2_CPUS`) — an account-config action, not code. No GPUs / no Windows Server images still apply but don't affect the Linux/no-GPU sandbox.

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
  As of the last provision the host is in **`us-east1-b`** (us-central1 was stocked out).
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

`cr-host-build` remains the **manual single-host fallback** and honours `CR_SANDBOX_HOST` in
`/api/deep`. When that env var is set (or neither pool nor host var is set), the app dispatches
to exactly this one host at cap 2 — the original, always-working path. The on-demand pool below
is the scale-out layer that runs when `CR_POOL_MIG` is set instead.

---

## 8c. On-demand detonation compute pool (scale-out beyond one host)

One host has a hard 4-vCPU ceiling → at most **2 concurrent deep scans**. Scaling to "many
concurrent isolated runs" is a **compute-provisioning** problem, solved with a golden image + a
Managed Instance Group (MIG) with a **standby pool**. All reproducible from committed scripts in
`sandbox/microvm/`; nothing hand-tuned in the console.

- **Golden image — `bash sandbox/microvm/bake-golden-image.sh`.** Captures a fully-provisioned
  `cr-host-build` as GCE image family **`cr-detonation-golden`** (Kata + Firecracker +
  containerd/devmapper + buildkit + mitmproxy CA + deno + OpenCode + the `cr-dm-pool` /
  `cr-base-image` / `cr-idle-shutdown` units). It avoids re-running `setup-host.sh`'s slow
  install on every boot. **Compatible with the "fresh pool every boot" rule:** the baked-in
  `cr-dm-pool.service` + `cr-base-image.service` rebuild a clean loopback thin-pool and the base
  detonation image on EVERY boot regardless of source disk (VERIFIED: a pool member booted from
  the image reaches "base image present" via these services). Current image: `cr-detonation-golden-v1`.
- **The pool — `bash sandbox/microvm/create-pool.sh`.** Builds a version-stamped instance
  template from the golden image (nested-virt N2, vertex SA) and a zonal MIG
  **`cr-detonation-pool`** (us-east1-b) with `targetSize=1` running + a **stopped standby pool**
  (`--standby-policy-mode=scale-out-pool`, `--stopped-size=2`). On a resize-up the MIG **starts a
  stopped standby first** (VERIFIED live) then replenishes the pool. Stopped standbys cost **disk
  only**, not vCPU. Conservative defaults; raise via `CR_POOL_TARGET` / `CR_POOL_STOPPED`.
- **Idle reclaim in a MIG is app-driven, NOT the watchdog.** The golden image's
  `cr-idle-shutdown` watchdog reclaims the *standalone* host, but in a MIG it FIGHTS the group:
  the reconciler keeps `targetSize` members RUNNING, so a member that self-poweroffs is
  restarted within ~25s (VERIFIED live). So pool members **mask the watchdog on boot** via the
  template startup-script `sandbox/microvm/pool-member-startup.sh`, and reclaim is done by
  `/api/deep` resizing `targetSize` DOWN as scans drain (`scalePoolInIfIdle`) back to a warm
  baseline (`CR_POOL_BASELINE`, default 1). Surplus running hosts return to the disk-only stopped
  pool; an idle pool rests at (1 running + 2 stopped).
- **Benchmarks (VERIFIED 2026-07-02, wall-clock to detonation-ready = SSH + /dev/kvm +
  containerd + `cr-detonation-base` present, from the golden image):**
  **cold create-from-image ≈ 88 s · start-from-stopped ≈ 44 s · resume-from-suspended ≈ 21 s.**
  Suspend/resume **works with nested virt** on n2-standard-4 and is fastest, but keeps RAM in
  paid storage and bypasses the fresh-boot pool rebuild, so the default standby type is
  **stopped** (cheapest, always-clean); suspended standbys are opt-in via `CR_POOL_SUSPENDED`.
- **How `/api/deep` uses the pool:** with `CR_POOL_MIG` (+ `CR_POOL_ZONE`) set, it lists RUNNING
  members by name, spreads scans across them (2 slots/host, least-loaded first), and when every
  live host is full resizes the MIG up (activating a standby) and waits for it to reach
  detonation-ready before dispatching. N live hosts → **2N concurrent scans**. Soft-capped by
  `CR_POOL_MAX_HOSTS` (default 6). Env override `CR_SANDBOX_HOST` still forces the single-host
  fallback path unchanged.
- **Real ceiling today:** bound by the `INSTANCES=24`/region quota (≈24 hosts ≈ **48 concurrent
  scans**) before `N2_CPUS=200` (≈50 hosts ≈ 100 scans) binds. Literal "hundreds" needs a quota
  increase on `INSTANCES`/`N2_CPUS` — an account-config action, not code (see §4).
- **Tear the pool down:** `gcloud compute instance-groups managed delete cr-detonation-pool
  --zone us-east1-b` then delete the template + golden image if not keeping them. The pool is
  fully rebuildable from `bake-golden-image.sh` + `create-pool.sh`.

---

## 9. State at last update

- GCP project set, billing live ($300 credit, expires 24 Sep 2026), `aiplatform` + `compute` APIs enabled.
- Vertex auth fully provisioned: service account `clauderabbit-vertex` with `roles/aiplatform.user`; key generated, verified, stored in Supabase secrets; local copy deleted.
- Supabase secrets present: `GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `GEMINI_API_KEY`.
- Local dev ADC set (developer machine only).
- `design.md` is inside the Claude Design zip at the repo root; the build unzips it, places it at root, and commits it.
- Not yet exercised in code: the edge function that reads `GOOGLE_SERVICE_ACCOUNT_JSON` and calls Vertex — that is built and verified in the build session.
