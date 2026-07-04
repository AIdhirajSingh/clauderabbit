# INFRASTRUCTURE.md — ClaudeRabbit

This file is the single source of truth for ClaudeRabbit's infrastructure: the accounts, services, projects, credentials, secrets, and the server-side secret method. It is a **factual reference**, not a rulebook — `CLAUDE.md` holds the binding rules and SOP and points here for infra facts.

These are facts to use, not re-derive. Do not guess account IDs, project IDs, regions, secret names, model strings, or endpoints — they are recorded here exactly. If something here conflicts with an assumption, this file wins on infra facts.

---

## 1. Accounts & ownership

- **Google account (GCP + Gemini):** `[redacted-email]`
- **GitHub:** user `AIdhirajSingh`, repo `clauderabbit` — `https://github.com/AIdhirajSingh/clauderabbit.git`
- **Local repo path (Windows):** `C:\Users\[redacted-name]\Development\clauderabbit` (the repo is worked in via git worktrees under `.claude\worktrees\<name>`, not always the bare root checkout)
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
  - `aiplatform.googleapis.com` — Agent Platform API (formerly Vertex AI; same endpoint, renamed at console level). This is the Gemini-via-Vertex backend, AND the harness's own in-sandbox agentic-analysis calls (see §8b — these must never be misattributed as the scanned repo's own traffic).
  - `compute.googleapis.com` — Compute Engine API, for the NVA gateway VM (`cr-forge-gateway`, §8b) — a persistent, small, shared VM, not a per-scan sandbox host.
  - `run.googleapis.com` — Cloud Run API. The actual detonation substrate (`cr-detonation` Job, §8b) — every scan's untrusted-code execution happens here, not on a Compute Engine VM.
- This project is ClaudeRabbit's permanent GCP home: Gemini-via-Vertex, the Cloud Run detonation substrate, and the shared NVA gateway all live here.

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

## 8b. Detonation substrate — Cloud Run Jobs + a shared NVA gateway (current, live)

**Superseded architecture, do not roll back to it:** an earlier phase of this project ran
detonations on a single always-on Compute Engine VM (`cr-host-build`) directly executing
Kata + Firecracker microVMs, with the git tag `single-host-dispatch-known-good` marking
that state. That VM and its microVM tooling are gone — the project migrated to the
architecture below, proven live end-to-end (a real fresh Google sign-in, a real Cloud Run
detonation, a real "Sandbox run" badge with confirmed containment). `single-host-dispatch-
known-good` is now a historical marker only; rolling back to it would undo this migration
and is not a live option.

**The substrate today:** every scan's untrusted code runs as an ephemeral **Cloud Run Job
execution** (`cr-detonation`, Gen2 — Jobs only run Gen2, there is no flag to choose
otherwise), not a persistent VM. Isolation is the container boundary itself plus forced
network egress through one shared, persistent **NVA (network virtual appliance) gateway
VM** — there is no per-scan network namespace or microVM anymore; Cloud Run's own
container sandboxing IS the per-execution isolation, and the gateway is what makes that
egress *deceptive* (real registry traffic passed through, everything else forged and
captured) rather than just blocked.

- **The Job (`cr-detonation`, region `us-central1`):** 2 vCPU / 4Gi memory per execution,
  `execution-environment: gen2`, Direct VPC Egress into `cr-sandbox-vpc`/`cr-sandbox-subnet`
  with `vpc-access-egress: all-traffic` (every packet the container sends leaves through the
  VPC, not the public internet directly) and a custom route forcing that traffic to the
  gateway. Image: `us-central1-docker.pkg.dev/redacted-gcp-project/cr-detonation/
  harness:v5`. Service account `cr-detonation-run@redacted-gcp-project.
  iam.gserviceaccount.com` (`roles/secretmanager.secretAccessor` + `roles/aiplatform.user`)
  — uses ambient Application Default Credentials, no JSON key. Triggered by
  `gcloud run jobs execute cr-detonation --update-env-vars=CR_OWNER=...,CR_REPO=...,
  CR_COMMIT_SHA=...,CR_SCAN_ID=...` from `/api/deep`.
- **The gateway (`cr-forge-gateway`, zone `us-central1-a`):** a small, persistent, SHARED
  `e2-small` VM (2 shared vCPUs, ~2GB RAM) — deliberately not per-scan, since Cloud Run
  containers have confirmed NO `CAP_NET_ADMIN` (no netns/iptables possible inside the
  container on any Cloud Run generation), so the deceptive-egress forge has to live outside
  the container. Runs mitmproxy in transparent mode (`sandbox/cloudrun/forge/
  forge_addon.py`, ported from the old per-run forge — the `Forge` class's registry-
  passthrough / forge / capture logic is unchanged) + dnsmasq (answer-all-except-allowlist,
  catch-all resolves to the gateway's own IP `10.200.0.10`) + iptables PREROUTING REDIRECT,
  re-asserted every 2 minutes by a systemd timer (`cr-forge-iptables.timer`) since this VM
  is now persistent across many scans, not reimaged per run. A Cloud DNS private zone
  (`cr-internal-zone`, `cr.internal.`) resolves `cr-harness.cr.internal` to it.
- **Forensics attribution across concurrent scans:** `sandbox/cloudrun/forge/
  forensics_api.py` runs on the gateway and is the control-plane API the harness's
  entrypoint calls. `/register` binds the CALLING connection's real source IP (never
  trusted from the request body) to a `scan_id`, closing any OLDER registration for that
  same IP first (Cloud Run reassigns IPs across executions over time, so an IP can be
  reused). `/forensics` returns only records bounded by BOTH that registration's `since`
  and `until` timestamps — an unregistered/expired `scan_id` gets an empty list, never
  another scan's data. This is what keeps concurrent detonations' captured evidence from
  cross-contaminating (see the concurrency proof below).
- **`aiplatform.googleapis.com` misattribution guard:** the harness's own agentic-analysis
  fallback (when OpenCode isn't available) calls Vertex AI directly. Early on this call was
  forged like any unallowlisted domain and then misattributed in the report as the SCANNED
  REPO reaching out to Google's infrastructure. Fixed in `forge_addon.py`
  (`OWN_VERTEX_RE` + `_is_own_vertex_ip` + `_is_own_vertex_path`): passthrough requires
  BOTH a verified real Google IP (via the same kernel-routed `server_conn.address`
  primitive used for every other verified-IP category — never trusted from a client-
  supplied Host/SNI) AND the request path naming `CR_OWN_GCP_PROJECT_ID` specifically — a
  malicious repo's own Vertex project (different project ID in the path) still gets forged.
  Requires `aiplatform.googleapis.com` in the gateway's dnsmasq forward list (real DNS
  answer) — without it the verified-IP check has nothing real to check against and silently
  never passes.
- **Secrets:** `CR_DEEP_RUNNER_KEY` (the harness's own entrypoint POSTs its forensic record
  to `attach-forensics` directly using its own copy) lives in **GCP Secret Manager**
  (`cr-deep-runner-key`), referenced via `--set-secrets` on the Job — never a plaintext env
  var. Disposable like every other credential here: rotate (new version, don't reuse) if
  ever suspected exposed.

### Concurrency ceiling — proven live, not estimated (Unit 16)

Cloud Run Jobs have no `--max-instances`-style flag (that's a Services concept); the
platform default is a **1000-concurrent-executions-per-project-region quota**
(docs.cloud.google.com/run/quotas) — far higher than anything relevant here. The REAL
constraint is the single shared `e2-small` gateway VM every concurrent detonation's egress
routes through.

`app/api/deep/route.ts` enforces `MAX_CONCURRENT = 3` as an in-process throttle (the
`inFlight` counter, race-free — a single Node controller process) — raised from a
placeholder `2` inherited from the old single-host architecture, after a real test: 3
simultaneous `gcloud run jobs execute` calls, confirmed genuinely overlapping via each
execution's start/completion timestamps (not serialized), each assigned its own distinct
Cloud Run source IP (`10.200.0.192`/`.193`/`.194` in the proof run — the mechanism the
forensics-attribution guard above relies on), gateway still healthy afterward
(`cr-forge-mitm`/`cr-forge-api` both active, load average ~0.02). This is a proven floor,
not a claimed ceiling — the gateway showed comfortable headroom, not its actual limit.
Raise `MAX_CONCURRENT` again only after a fresh concurrency proof at the higher number.

Requests beyond the cap queue (not a flat 429) via the same FIFO mechanism as before —
**`lib/deep-queue.ts`** (in-process, pure, race-free ordered waiter list) + the
**`deep_scan_queue`** table (migration `20260702000002`, observability + honest position
only, not the slot lock) + **`supabase/functions/deep-queue`** (a thin, runner-key-gated
wrapper over the SECURITY DEFINER RPCs, called best-effort so a DB hiccup never stalls the
queue). The streaming response emits `"Queued — position N of M, ~X min"` while waiting; a
waiter that can't get a slot within the deadline gets an honest, specific "sandbox was too
busy" error, never a silent drop.

---

## 9. State at last update

- GCP project set, billing live ($300 credit, expires 24 Sep 2026), `aiplatform` + `compute` + `run` APIs enabled.
- Vertex auth fully provisioned: service account `clauderabbit-vertex` with `roles/aiplatform.user`; key generated, verified, stored in Supabase secrets; local copy deleted.
- Supabase secrets present: `GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `GEMINI_API_KEY`.
- Local dev ADC set (developer machine only).
- `design.md` is inside the Claude Design zip at the repo root; the build unzips it, places it at root, and commits it.
- **Detonation substrate migrated from the single-host microVM architecture to Cloud Run
  Jobs + the shared NVA gateway (§8b), proven live end-to-end**: a real fresh Google
  sign-in scanning `AmrDab/clawdcursor` produced a genuine "Sandbox run" badge with
  confirmed containment, no fabricated data. The old `cr-host-build` VM and its microVM
  tooling are gone from GCP; the git tag `single-host-dispatch-known-good` is a historical
  marker only.
- `CR_DEEP_RUNNER_KEY` lives in GCP Secret Manager (`cr-deep-runner-key`), referenced via
  `--set-secrets` on the Cloud Run Job — rotated once this session after a local
  shell-pipe corruption incident (never restored from the corrupted value, generated
  fresh).
- Concurrency ceiling for `/api/deep` measured and set to `MAX_CONCURRENT = 3` (§8b),
  replacing a placeholder `2` inherited from the pre-Cloud-Run architecture that was never
  re-measured after the migration.
