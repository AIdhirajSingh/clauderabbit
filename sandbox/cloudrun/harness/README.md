# Cloud Run Job harness — the dynamic sandbox detonation image

This directory builds the container image that becomes a **Cloud Run Job
execution**: the actual "run untrusted code safely" workload for Claude
Rabbit. Each Job execution clones one pinned commit of a scanned repo,
installs + runs it, observes what happened, and reports the result back to
the app — then the container is destroyed. There is no persistent host and no
per-scan image build; the container boundary itself is the isolation.

## Architecture this replaces

The old substrate (`sandbox/microvm/`) ran detonation inside Kata + Firecracker
microVMs on a persistent GCE host, with a per-run network-namespace "forge"
intercepting egress. Cloud Run Gen2 containers get **no `CAP_NET_ADMIN`**, so
there is no netns/iptables to run inside this container. Isolation now comes
from two things working together, both **outside** this image:

1. **The Cloud Run container boundary itself** replaces the microVM.
2. **A separate, already-deployed gateway VM** (`10.200.0.10`, also reachable
   as `cr-harness.cr.internal` via a Cloud DNS private zone) in
   `cr-sandbox-vpc` / `cr-sandbox-subnet`. A GCP custom route forces **all**
   of this container's outbound traffic to that gateway, which runs mitmproxy
   in transparent mode plus a custom addon (`sandbox/cloudrun/forge/`) that
   passes real package-registry + Supabase control-plane traffic through
   untouched and forges a fake-success response for everything else. That
   gateway is built and live-tested already — this image only needs to talk
   to its small control API correctly (register / ca-cert / forensics).

## What's in this image

| File | Role |
|---|---|
| `Dockerfile` | `node:22-slim` + python3/strace/git/curl + corepack (yarn/pnpm@9 fallback) + deno + OpenCode, no per-scan build step. |
| `entrypoint.sh` | The container's `ENTRYPOINT`. Runs the whole scan sequence (see below) and exits 0/non-zero. |
| `detonate.py` | Adapted from `sandbox/microvm/guest/detonate.py`: plants credential canaries, runs the adaptive node/python build ladder, runs the built app under `strace`, runs the two containment self-checks. The only real change from the microVM version: `configure_egress()` is a documented no-op (no `resolv.conf` rewrite — DNS is real; containment is route-based, not DNS-based). |
| `assemble-forensics.py` | **Byte-identical copy** of `sandbox/microvm/assemble-forensics.py`. Schema and logic are untouched — this is the contract `lib/scan.ts`'s `normalizeForensics` depends on. |
| `agent/` | The full 3-agent OpenCode exploration pass, copied unchanged from `sandbox/agent/`: `parallel_agents.py`, `agent_loop.py`, `detonator.py`, `knowledge_graph.py`, `opencode_client.py`, `vertex_client.py`, `scan_files.ts`, `security_methodology.md`. |

## Execution sequence (`entrypoint.sh`)

1. **Fail fast on missing/invalid env.** Every required var is checked with
   `: "${VAR:?...}"`; `CR_OWNER` / `CR_REPO` / `CR_COMMIT_SHA` / `CR_SCAN_ID`
   are further validated against the same safe charset the rest of the app
   uses (`app/api/deep/route.ts`'s `SEGMENT_RE`/`SHA_RE`,
   `supabase/functions/attach-forensics`'s `isSegment`) **before** they touch
   any shell command, git argument, or URL.
2. **`POST /register`** to the gateway with `{"scan_id": CR_SCAN_ID}` —
   first, before any other network activity, so the gateway attributes all
   subsequent traffic from this container's source IP to this scan.
3. **`GET /ca-cert`** from the gateway, installed into the container's trust
   store (`update-ca-certificates`), plus `SSL_CERT_FILE` /
   `REQUESTS_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` exported for every child
   process — done **before** cloning or running anything untrusted.
4. Vertex/OpenCode auth staged from `GOOGLE_SERVICE_ACCOUNT_JSON` (written to
   a local file, `GOOGLE_APPLICATION_CREDENTIALS` exported) — the same
   service-account pattern the rest of the app already uses
   (`docs/INFRASTRUCTURE.md` §6/§7), not a new mechanism.
5. **Shallow clone** the repo at the pinned commit into `/repo`.
6. **3-agent OpenCode exploration pass** (`agent/parallel_agents.py
   --explore-only`) launched in the **background**, concurrent with...
7. **`detonate.py`** — builds + runs the repo under `strace`, writes its
   observation locally.
8. Join the agentic pass, then **`GET /forensics?scan_id=`** from the gateway
   (one-shot — consumed on read), reconstruct its `records` array as
   newline-delimited JSON, fold in the local observation as one more line,
   and run **`assemble-forensics.py` unchanged** against the reconstructed
   file to produce the final forensic record.
9. **`POST` the forensic record** to
   `${CR_SUPABASE_URL}/functions/v1/attach-forensics`, authenticated with
   `x-runner-key: ${CR_DEEP_RUNNER_KEY}` (plus the Supabase anon/publishable
   key if set, since the Functions gateway itself gates on that before the
   function body runs).
10. Exit 0 only if the forensics attach succeeded (even if degraded/partial
    — an honest partial report is attached and the run still exits 0). Exit
    non-zero if the attach itself failed, so the Job execution shows up as
    failed to whatever monitors Job executions. Every failure along the way
    is logged to stderr with a `[entrypoint] ERROR:` / `FAILURE:` prefix —
    nothing is swallowed silently, and a partial run is never reported as if
    it were a clean pass.

## Environment variable contract

### Required (the Job execution must be invoked with these)

| Var | Meaning |
|---|---|
| `CR_OWNER` | GitHub owner segment. Validated against `^[A-Za-z0-9._-]{1,100}$`, non-empty, not `.`/`..`. |
| `CR_REPO` | GitHub repo segment. Same validation as `CR_OWNER`. |
| `CR_COMMIT_SHA` | The pinned commit to detonate. Validated against `^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$`. |
| `CR_SCAN_ID` | Opaque per-execution id used to attribute gateway traffic to this run (`/register` + `/forensics?scan_id=`). Validated against `^[A-Za-z0-9._-]{1,200}$`. |
| `CR_SUPABASE_URL` | e.g. `https://<ref>.supabase.co` — where `attach-forensics` is POSTed. |
| `CR_DEEP_RUNNER_KEY` | Shared secret for `attach-forensics`'s `x-runner-key` header. Expected as a Cloud Run **Secret Manager–backed env var** — this script only ever reads it from `process env`, never fetches or hardcodes it. |

### Optional (sane defaults for a real deployment)

| Var | Default | Meaning |
|---|---|---|
| `CR_GATEWAY_HOST` | `cr-harness.cr.internal` | The gateway's private-DNS hostname. Falls back to `CR_GATEWAY_IP` if this doesn't resolve. |
| `CR_GATEWAY_IP` | `10.200.0.10` | The gateway's internal IP. |
| `CR_GATEWAY_PORT` | `8090` | The gateway's control-API port (register/ca-cert/forensics — not intercepted, reachable directly since it's in-subnet). |
| `CR_SUPABASE_ANON_KEY` | *(unset)* | Supabase publishable key. The Functions gateway in front of `attach-forensics` requires a valid apikey/JWT before the function runs at all (same pattern as `sandbox/run-deep-queue.sh` / `app/api/deep/route.ts`); omitting this will 401 at the gateway layer even with a correct runner key. |
| `CR_BUILD_TIMEOUT_S` | `240` | Forwarded to `detonate.py` as `CR_BUILD_TIMEOUT`. |
| `CR_RUN_TIMEOUT_S` | `25` | Forwarded to `detonate.py` as `CR_RUN_TIMEOUT`. |
| `CR_AGENT_TIME_BUDGET_S` | `90` | Forwarded to `parallel_agents.py --time-budget-s`. |
| `CR_AGENT_TOKEN_BUDGET` | `40000` | Forwarded to `parallel_agents.py --token-budget`. |
| `CR_AGENT_MAX_TARGETS` | `6` | Forwarded to `parallel_agents.py --max-targets`. |
| `CR_GCP_PROJECT` (or `GCP_PROJECT_ID`) | *(unset)* | GCP project for the OpenCode `google-vertex` provider / `vertex_client.py` fallback. |
| `CR_GCP_LOCATION` | `global` | Vertex location — the 3.x Gemini line serves only on the Vertex **global** endpoint (see `vertex_client.py`/`opencode_client.py` comments). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | *(unset)* | The same Vertex service-account JSON key already used elsewhere in this app (`docs/INFRASTRUCTURE.md` §6/§7). Written to `/tmp/cr-sa-key.json` and pointed to by `GOOGLE_APPLICATION_CREDENTIALS` so both the OpenCode provider and `vertex_client.py`'s ADC path authenticate identically. If absent or invalid, the agentic pass degrades gracefully (per its own existing "never-blank" contract) rather than failing the whole run. |

## Key adaptation decisions

- **`configure_egress()` in `detonate.py` is a documented no-op.** The old
  guest rewrote `/etc/resolv.conf` to point DNS at a per-run forge bridge IP
  (`CR_FORGE_IP`, default `169.254.0.1`). In this architecture DNS resolution
  is real and unmodified; containment comes entirely from the VPC custom
  route forcing every destination IP to the gateway. Cloud Run containers may
  not even permit rewriting `resolv.conf`, so this is removed rather than
  attempted-and-ignored.
- **`--trap-ip` (parallel_agents.py) is passed the gateway's IP
  (`10.200.0.10` / `$CR_GATEWAY_IP`) but is structurally inert on this path.**
  In the old architecture it was the per-run forge bridge IP that a *real*
  per-target `detonate()` relay (`agent/detonator.py`'s
  `build_detonate_command`) would embed in an SSH command against a separate
  microVM. Here, `parallel_agents.py` is invoked with `--explore-only`, which
  substitutes `ssh_exec` with `explore_only_relay` — a pure no-op that never
  reaches `build_detonate_command`/`trap_ip` at all. The flag is still
  **required** by the CLI and is still validated by `detonator.py`'s
  `TRAP_IP_RE` (`^10\.200\.\d{1,3}\.\d{1,3}$`) even when unused, so the real
  gateway address is passed rather than a stale/fictitious one — if this code
  path is ever changed to a real per-target relay against the new gateway,
  the value would already be pointed somewhere meaningful.
- **OpenCode/Vertex auth reuses the app's existing service-account pattern**
  (`GOOGLE_SERVICE_ACCOUNT_JSON` / `GCP_PROJECT_ID` / `GCP_LOCATION`) rather
  than inventing a new mechanism — the JSON key is written to a local file at
  container start and `GOOGLE_APPLICATION_CREDENTIALS` is exported, since
  Python's `google-genai` SDK (used by both the OpenCode `google-vertex`
  provider and `agent/vertex_client.py`'s fallback) expects ADC to resolve to
  a credentials **file**, not a raw JSON string in an env var.
- **The forensic-record schema string
  (`claude-rabbit/forensic-record/microvm-1`) is deliberately left
  unchanged** even though the substrate is no longer a microVM —
  `lib/scan.ts`'s `normalizeForensics` matches on this exact string, and
  renaming it would break every existing report.

## Building and deploying (not done by this change — for the lead)

This image is not built or deployed by this change. From the repo root, once
Docker/`gcloud` are available:

```
gcloud builds submit sandbox/cloudrun/harness \
  --tag <region>-docker.pkg.dev/<project>/<repo>/cr-harness:latest

gcloud run jobs deploy cr-harness \
  --image <region>-docker.pkg.dev/<project>/<repo>/cr-harness:latest \
  --region <region> \
  --vpc-connector <connector-in-cr-sandbox-vpc> \
  --set-env-vars CR_SUPABASE_URL=...,CR_GATEWAY_HOST=cr-harness.cr.internal \
  --set-secrets CR_DEEP_RUNNER_KEY=CR_DEEP_RUNNER_KEY:latest,GOOGLE_SERVICE_ACCOUNT_JSON=GOOGLE_SERVICE_ACCOUNT_JSON:latest \
  --max-retries 0 --task-timeout <build+run+overhead budget>
```

The Job execution then needs `CR_OWNER` / `CR_REPO` / `CR_COMMIT_SHA` /
`CR_SCAN_ID` supplied per-execution (via `gcloud run jobs execute --update-env-vars`
or the Cloud Run Admin API's `overrides`), wired from `/api/deep` — that
wiring is intentionally out of scope here per the task brief.

The exact command shapes above (region, connector name, Artifact Registry
repo, secret names) depend on live infra decisions only the lead can make —
they are illustrative, not verified against a real deployment.

## What was NOT verified in this environment

- **No Docker build was run.** This dev environment has no `docker` binary
  and no real Python interpreter (only the Windows Store app-execution
  alias), so `docker build` and any `python3 -m py_compile` sanity pass could
  not be executed here. `detonate.py` and `assemble-forensics.py` were
  reviewed by hand against the original microVM versions instead (see below).
  Please do a real `docker build .` before the first deploy.
- **No live OpenCode run.** The deno/OpenCode install steps mirror
  `sandbox/microvm/provision-host.sh`'s proven install commands exactly, but
  were not executed against a real container here.
- **No live gateway round-trip.** The `/register`, `/ca-cert`, and
  `/forensics` calls are written to the contract described in the task brief
  and cross-checked against `sandbox/cloudrun/forge/forge_addon.py` /
  `forensics_api.py`'s field names (`scan_id`, `records`, `body_b64`, `host`,
  `path`, `kind`, `t`) where those files exist in the working tree; a real
  round-trip against the deployed gateway is the lead's to verify.

## Verification performed in this environment

- `bash -n entrypoint.sh` — passes (valid bash syntax).
- `assemble-forensics.py` is a byte-identical copy of
  `sandbox/microvm/assemble-forensics.py` (`diff` confirms zero output).
- Every `CR_OWNER` / `CR_REPO` / `CR_COMMIT_SHA` / `CR_SCAN_ID` use in
  `entrypoint.sh` is downstream of the charset validation in step 0 — none of
  them are interpolated into a shell command, curl URL, or git argument
  before that validation runs.
- `detonate.py`'s adaptive build ladder, strace observation, decoy-planting,
  and both containment probes are carried over verbatim from
  `sandbox/microvm/guest/detonate.py`; the only functional change is
  `configure_egress()` becoming a no-op (see "Key adaptation decisions").
