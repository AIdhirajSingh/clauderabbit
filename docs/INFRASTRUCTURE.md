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
- **Edge runtime: Supabase Edge Functions run on Deno (TypeScript).** All server-side work — scanning, score blending, model/search calls, DB writes — happens here. The Deno edge functions call Gemini via Vertex with a **hand-rolled REST client** (`supabase/functions/_shared/vertex.ts`): they mint a Google OAuth token from the service-account JSON (SA JWT-bearer flow, RS256, Deno Web Crypto) and POST directly to the Vertex `:generateContent` endpoint with `fetch` — **no Gen AI SDK** in the app. (The Python `google-genai` SDK *is* used, but only in the in-sandbox agent's Vertex fallback — see §6/§8b — never in the edge functions.)
- **Scan inputs — GitHub repos AND npm packages.** A target may be a GitHub `owner/repo` or an npm package (`npm:pkg`, a bare/scoped name, or an `npmjs.com/package/...` URL — `parseNpmTarget` in `_shared/npm.ts`). npm targets are resolved against the **public npm registry** — `registry.npmjs.org` for the version manifest + published tarball, `api.npmjs.org` for last-month download counts — and the ACTUAL published tarball is integrity-verified (`dist.integrity`/`dist.shasum`) and scanned, not just the repo its `package.json` links to; a divergence (e.g. an install hook present in the tarball but not the linked source) is surfaced as a compromised-publish signal. Public npm reports live at `/npm/<pkg>` (`app/npm/[...pkg]/page.tsx`); the wiring is in `supabase/functions/scan/index.ts` + `_shared/npm.ts`.
- **Local preview:** the app runs on **localhost:2311**. Derive run commands from the real `package.json` / Supabase config at the moment of use; do not pre-write a command table.

---

## 3. Supabase

- **Project:** `clauderabbit`
- **Project ref:** `mjvlczaytkhvsolnhhkz`
- **Region:** South Asia (Mumbai), `ap-south-1`
- **URL:** `https://mjvlczaytkhvsolnhhkz.supabase.co`
- **Provides:** Postgres database, Auth (Google + email), and Edge Functions.
- **Key system:** the **client** uses only the new publishable `sb_publishable_…` key. **Server-side the edge functions accept EITHER key system:** `resolveServiceKey()` (in `scan`, `oauth-token`, `attach-forensics`, `deep-queue`) reads the auto-provided legacy `SUPABASE_SERVICE_ROLE_KEY` first and falls back to the new `SUPABASE_SECRET_KEYS` (`sb_secret_…`) — so the legacy service-role key is still honored when the runtime provides it, not removed. Either way the secret key stays server-side and never reaches the client.
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

- **Fast path:** `gemini-3.1-flash-lite` — GA, cost-efficient, high-volume. (Note: the old `gemini-3.1-flash-lite-preview` string is discontinued July 9, 2026 — use the bare GA string `gemini-3.1-flash-lite`.) The actual id is not hardcoded — it is held in the **`GEMINI_FAST_MODEL`** secret and read by `vertex.ts` `modelForTier("fast")` (see §7).
- **Deep / escalated path:** `gemini-3.5-flash` — GA (released 19 May 2026), most capable Flash model, optimized for agentic + coding tasks. Default thinking effort is `medium`; for hard sandbox-adjudication cases, `high` can be set per call. The id is held in the **`GEMINI_DEEP_MODEL`** secret and read by `vertex.ts` `modelForTier("deep")` (see §7).
- **Two instances, real escalation gate preserved.** Gemini is the placeholder proving the end-to-end pipe. Real models (DeepSeek fast-path, Brave reputation, Kimi K2.7 + OpenCode in the sandbox) swap in later behind the same seam — swapping the model proves the wrapper; the sandbox engine is the separate, real product.

---

## 6. Gemini-via-Vertex — the backend, client, and auth

**Backend decision: Gemini is called through the Vertex AI backend (Agent Platform), NOT the AI Studio / Gemini Developer API.** Reason: the $300 credit pays for Vertex Gemini calls but explicitly does not pay for AI Studio Gemini calls (§4). Same models, same model strings, different backend + auth.

- **Client in the app: NO Gen AI SDK.** The Deno edge function (`_shared/vertex.ts`) hand-rolls the call: it mints an OAuth access token from the service-account JSON via the SA JWT-bearer flow (RS256, signed with Deno Web Crypto) and POSTs to the Vertex `:generateContent` REST endpoint with `fetch`. This avoids a filesystem / `google-auth-library` dependency inside Deno. The Python **`google-genai`** SDK is used only by the in-sandbox agent fallback (`sandbox/agent/vertex_client.py`, installed in the harness image — §8b), NOT the app; the legacy `google-generativeai` / deprecated `vertexai.generative_models` modules are not used anywhere.
- **Vertex backend selection:** there is no SDK flag — the Vertex backend is selected by construction. The request targets the Vertex host with `projects/<GCP_PROJECT_ID>/locations/<location>/publishers/google/models/<model>:generateContent` in the path, authenticated by the SA OAuth token (cloud-platform scope), never an AI Studio API key.
- **Endpoint:** `aiplatform.googleapis.com` for the `global` location (the host that fronts the GA 3.x models); a regional location instead uses the `{location}-aiplatform.googleapis.com` host (`buildEndpoint()` in `vertex.ts`). Both are Vertex, unchanged through the Vertex → Agent Platform rename.
- **Region / location — two decoupled secrets.** `VERTEX_LOCATION` selects where Gemini is *served* (set to **`global`**, the endpoint that fronts the GA 3.x models in §5); it falls back to `GCP_LOCATION` when unset (`vertex.ts` `vertexLocation()`). `GCP_LOCATION` (**`us-central1`**) is the sandbox/compute zone and the Vertex fallback location. Both are stored as secrets so they change without code edits.

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
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service-account JSON key for Vertex auth. The edge function parses it and mints an OAuth token from it (JWT-bearer, RS256) to call the Vertex REST endpoint. (The sandbox harness reuses the SAME key, staged as a `GOOGLE_APPLICATION_CREDENTIALS` file for the Python `google-genai` fallback — §8b.) |
| `GCP_PROJECT_ID` | `redacted-gcp-project` — the GCP project in the Vertex request path. |
| `GCP_LOCATION` | `us-central1` — the sandbox/compute zone AND the Vertex fallback location when `VERTEX_LOCATION` is unset. |
| `VERTEX_LOCATION` | `global` — where Gemini is served (the GA 3.x global endpoint). Falls back to `GCP_LOCATION` if unset. |
| `GEMINI_FAST_MODEL` | Fast-tier model id (§5), read by `vertex.ts` `modelForTier("fast")`. |
| `GEMINI_DEEP_MODEL` | Deep-tier model id (§5), read by `vertex.ts` `modelForTier("deep")`. |
| `GITHUB_TOKEN` | *(optional)* raises the GitHub API rate limit for repo metadata / file fetches (`_shared/github.ts`). Absent → unauthenticated GitHub reads still work at the lower limit. |
| `CR_DEEP_RUNNER_KEY` | App-defined runner token authorizing the `attach-forensics` + `deep-queue` edge functions (read by both). The sandbox harness holds the same value to POST its forensic record + stage updates. |
| `CR_FORCE_DEEP_TARGETS` | *(optional operator tool)* comma-separated `owner/repo` list (case-insensitive) that the `scan` function forces down the **deep** sandbox path even when the static read alone would clear them (`scan/index.ts`, the "OPERATOR OVERRIDE" block). This is the honest way to guarantee a genuinely sandbox-verified report for a specific repo — e.g. this product's own repo for its public/marketing report. It forces the RUN only; it does **not** touch the static signals or the score, so whatever the sandbox observes is the real number, and the never-a-bare-Safe rail is unaffected. **Off by default** (unset → zero effect on every normal scan); each forced target costs one deep run per new commit SHA (cached thereafter). Set/clear with `supabase secrets set CR_FORCE_DEEP_TARGETS="owner/repo,owner2/repo2"`. |

The retired placeholder-phase `GEMINI_API_KEY` is **no longer read by any edge function** (no `Deno.env.get("GEMINI_API_KEY")` remains) — the Vertex model path is auth'd by the service account, not an AI Studio key.

Plus Supabase's own auto-provided `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, and `SUPABASE_SECRET_KEYS` (do not duplicate any of these).

### How the edge function uses them
The edge function reads these via `Deno.env.get(...)`, mints the Vertex OAuth token from `GOOGLE_SERVICE_ACCOUNT_JSON`, and calls the Vertex REST `:generateContent` endpoint built from `GCP_PROJECT_ID` + `VERTEX_LOCATION` (falling back to `GCP_LOCATION`). No Gen AI SDK is involved. The client never sees any of this.

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

### Deploying an edge function — ALWAYS `--no-verify-jwt` (binding gotcha)
Every ClaudeRabbit edge function runs with **`verify_jwt = false`** (confirmed live: `scan`, `deep-queue`, `attach-forensics`, `oauth-token` are all `false`). They each do their OWN auth internally — `scan` validates `cr_cli_…` tokens (which are NOT Supabase JWTs, so the gateway would 401 them as `UNAUTHORIZED_INVALID_JWT_FORMAT`) and anonymous web scans; `deep-queue`/`attach-forensics` gate on `CR_DEEP_RUNNER_KEY` (callers, including the sandbox container, may send it as a non-JWT bearer). The gateway JWT check must therefore stay **off**.

`supabase functions deploy <name>` defaults `verify_jwt` back to **true** and silently flips it on a plain redeploy (this repo has no per-function `config.toml` pinning it). So EVERY deploy MUST pass the flag:
```
supabase functions deploy <name> --no-verify-jwt --project-ref mjvlczaytkhvsolnhhkz
```
Omitting it breaks CLI/MCP `cr_cli_` auth and the runner-key callers in production (the web app keeps working because it sends the anon key, a valid JWT). Verify after any deploy:
```
# Management API — expect "verify_jwt": false for every function
curl -s https://api.supabase.com/v1/projects/mjvlczaytkhvsolnhhkz/functions/<name> \
  -H "Authorization: Bearer $SUPABASE_PAT" | grep -o '"verify_jwt":[a-z]*'
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
  — uses ambient Application Default Credentials, no JSON key.
- **How executions are triggered — TWO backends, same job (`app/api/deep/route.ts`):**
  - **Production (the real one): a Vercel-native REST dispatch.** The deployed website
    calls the Cloud Run Admin v2 REST API directly over HTTPS
    (`POST …/v2/…/jobs/cr-detonation:run` with per-execution `containerOverrides.env` for
    `CR_OWNER`/`CR_REPO`/`CR_COMMIT_SHA`/`CR_SCAN_ID`), authenticated by a **dedicated
    least-privilege dispatcher SA** `cr-dispatch@…` (only `run.jobs.run` on the
    `cr-detonation` job resource + `actAs` on `cr-detonation-run`). Its JSON key lives
    ONLY in the Vercel server-side env (`CR_RUN_SA_JSON`) — never the client, never the
    repo, never Supabase. Code: `lib/cloud-run-dispatch.ts` (token minted from the SA
    JSON via the JWT-bearer flow, mirroring `_shared/vertex.ts`). This is what makes a
    live visitor's escalated scan on `clauderabbit.in` detonate for real, with no
    operator machine involved. Proven live: execution `cr-detonation-54nw6` was created
    by `cr-dispatch@…` and completed with a real forensic record attached.
  - **Local dev fallback: `gcloud run jobs execute cr-detonation --update-env-vars=…`**
    spawned by `/api/deep` (localhost-gated, `CR_ALLOW_LOCAL_DEEP=1`), used only when
    `CR_RUN_SA_JSON` is not configured.
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
- **Secrets + control-plane auth on the Job/gateway:**
  - `CR_DEEP_RUNNER_KEY` (the harness's own entrypoint POSTs its forensic record to
    `attach-forensics` directly using its own copy) lives in **GCP Secret Manager**
    (`cr-deep-runner-key`), referenced via `--set-secrets` on the Job — never a plaintext
    env var.
  - `CR_FORGE_CONTROL_KEY` — a shared control key that AUTHENTICATES the gateway's mutating
    `/register` and `/forensics` endpoints, so the untrusted detonated repo (same subnet IP
    as the harness — the firewall alone can't tell them apart) cannot re-open its own egress
    passthrough or one-shot-consume/blank its own forensic evidence. Set on BOTH sides:
    baked into the gateway's `cr-forge-api` systemd unit (`provision-forge-gateway.sh`) and
    delivered to the Job, whose `entrypoint.sh` sends it as the `x-forge-key` header.
    Enforcement is **rollout-safe** — `forensics_api.py` warns-and-allows until the key is
    present on both sides (`key_authorized()`), so an un-migrated gateway never breaks. The
    hole is only truly closed once the key is set on gateway AND harness.
  - Both are disposable like every credential here: rotate (new version, don't reuse) if ever
    suspected exposed.
- **Privilege model of the untrusted build/run (be precise):** by default the detonated
  repo's own install/run executes **as root inside the Cloud Run container** — the container
  boundary is the isolation, NOT an in-container uid drop. `detonate.py` scrubs every
  secret-shaped env var (`CR_`/`GOOGLE_`/`GCP_`/`SUPABASE_`/`AWS_`/`GH_`/`GITHUB_`/`VERTEX_`
  prefixes + any `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`/`PRIVATE` name) from that
  child's environment (`_untrusted_env`), so the harness's real credentials — the Vertex SA,
  `CR_DEEP_RUNNER_KEY`, `CR_FORGE_CONTROL_KEY`, `CR_SCAN_ID` — are never in the untrusted
  blast radius. An OPTIONAL unprivileged-user drop exists via **`CR_UNTRUSTED_USER`**
  (`detonate.py` `_untrusted_user()` → `subprocess.run(user=…)`), **OFF by default** so the
  live path stays byte-identical until provisioning sets it to a real image-created user that
  owns `/repo` — defense-in-depth for the `/proc/1/environ` + SA-key-file residual, not the
  primary containment. Do NOT describe the untrusted repo as non-root unless
  `CR_UNTRUSTED_USER` is actually set.

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

**Cross-instance dispatch dedup** — because the production REST deep path runs on Vercel
(many function instances, no shared in-process state), the in-process cap/queue above cannot
stop repeated `/api/deep` calls for the SAME escalated commit from each spawning a Cloud Run
execution during the ~3-min pre-forensics window. The **`deep_dispatch_lock`** table
(migration `20260711000001`, PK `(owner,repo,sha)`) + the `deep-queue` function's `claim`/
`release` ops (SECURITY DEFINER `deep_dispatch_try_claim`/`deep_dispatch_release`, service-role
only) provide an atomic per-commit claim: `handleRestDeep` claims before dispatching, a
non-winner attaches to the in-flight run instead of dispatching again, and the claim is
TTL-stealable (420s) so a crashed controller can't wedge a commit. The claim fails CLOSED (a
DB hiccup skips dispatch rather than re-opening the flood; the client honestly degrades to
static-only, retryable).

---

## 9. State at last update

- GCP project set, billing live ($300 credit, expires 24 Sep 2026), `aiplatform` + `compute` + `run` APIs enabled.
- Vertex auth fully provisioned: service account `clauderabbit-vertex` with `roles/aiplatform.user`; key generated, verified, stored in Supabase secrets; local copy deleted.
- Supabase edge-function secrets present (per §7): `GOOGLE_SERVICE_ACCOUNT_JSON`, `GCP_PROJECT_ID`, `GCP_LOCATION`, `VERTEX_LOCATION`, `GEMINI_FAST_MODEL`, `GEMINI_DEEP_MODEL`, `GITHUB_TOKEN` (optional), `CR_DEEP_RUNNER_KEY` — plus Supabase's auto-provided `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` / `SUPABASE_SECRET_KEYS`. The retired placeholder-phase `GEMINI_API_KEY` is no longer read by any edge function.
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
- Forge control-plane auth is live: `CR_FORGE_CONTROL_KEY` gates the gateway's `/register`
  + `/forensics`, set in provisioning on BOTH the gateway (`cr-forge-api` unit) and the
  Cloud Run Job. `detonate.py` scrubs all harness secrets from the untrusted build/run
  environment, and an optional `CR_UNTRUSTED_USER` can drop that build/run to an
  unprivileged user — OFF by default, so the untrusted repo currently runs as root inside
  the container (see §8b).
- Concurrency ceiling for `/api/deep` measured and set to `MAX_CONCURRENT = 3` (§8b),
  replacing a placeholder `2` inherited from the pre-Cloud-Run architecture that was never
  re-measured after the migration.
