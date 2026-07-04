# Claude Rabbit — Dynamic Sandbox Engine (the moat)

> Everyone reads the code. We run it.

This is the deep-path engine: it clones, builds, runs, and **observes** an unknown
repository, hermetically isolated and reset after every scan. The fast path (the
`scan` edge function) escalates here when it sees something it can't resolve
(obfuscation, install-time network, credential access, a brand-new owner, or low
read-confidence).

It is a **monitored sinkhole**, not a black box: it lets the code do what it would
do, watches ALL of it, but **never lets a single real packet reach a real
destination**. During BUILD the detonation may fetch declared dependencies from
package registries ONLY (through an allowlist proxy), so normal repos actually
`npm install`/`pip install` and build. During RUN every outbound call — DNS and
connections, even to a hardcoded IP — is intercepted and either forged a
fake-success response (current architecture) or redirected to a controlled trap
(legacy architecture) that records the full intent (domain, intended IP, geo, the
would-be payload captured inert). The intended destination is never reached.

## Architecture — production runs on Cloud Run Jobs (`sandbox/cloudrun/`)

**This replaced an earlier microVM-on-persistent-host substrate
(`sandbox/microvm/`, see "Superseded substrate" below) — the change is documented
in full in `sandbox/cloudrun/harness/README.md`, which this section summarizes.**
Cloud Run Gen2 containers get **no `CAP_NET_ADMIN`**, so there is no netns/iptables
to run *inside* a detonation container the way the microVM guest could. Isolation
now comes from two things working together, both outside the detonation container:

1. **The Cloud Run container boundary itself** replaces the microVM as the
   execution sandbox. Each Job execution clones one pinned commit, builds, runs,
   observes, reports, and is destroyed — no persistent host, no per-scan image
   build.
2. **A separate, always-on gateway VM** (`cr-forge-gateway`, internal IP
   `10.200.0.10`, also reachable as `cr-harness.cr.internal` via a Cloud DNS
   private zone) in `cr-sandbox-vpc`. A GCP custom route
   (`cr-detonation-force-nva`, tag `cr-sandbox`) forces **every** detonation
   container's Direct VPC Egress traffic to this one VM regardless of
   destination.

| Piece | File | Role |
|---|---|---|
| Detonation image | `cloudrun/harness/Dockerfile`, `entrypoint.sh` | `node:22-slim` + python3/strace/git/curl + corepack + deno + OpenCode. `entrypoint.sh` runs the whole scan sequence per Job execution and exits 0/non-zero — no per-scan build step. |
| Detonate | `cloudrun/harness/detonate.py` | Adapted from `microvm/guest/detonate.py`: plants credential canaries, runs the adaptive node/python build ladder, runs the built app under `strace`, runs both containment self-checks. The only functional change: `configure_egress()` is a documented no-op — DNS is real inside the container; containment is route-based, not DNS-rewrite-based. |
| Agentic exploration | `cloudrun/harness/agent/` | The same 3-agent OpenCode pass as `sandbox/agent/`, copied unchanged, run concurrently with `detonate.py` in the container. |
| Gateway: transparent forge | `cloudrun/forge/provision-forge-gateway.sh`, `forge_addon.py` | mitmproxy in transparent mode + a local iptables PREROUTING REDIRECT (everything except the control-API port) delivers every arriving flow to `forge_addon.py`. That addon is **the same Forge logic as the old per-run-netns host version, unchanged** — it never depended on netns, only on `SO_ORIGINAL_DST` (which REDIRECT preserves) and the machine's DNS resolver. It proxies real package registries / the app's own exact Supabase project ref / Vertex AI / a time-boxed GitHub "clone window" through untouched, and forges a fake-success TLS/HTTP response for everything else. A cert pinning/mTLS/custom-crypto connection aborts instead of being defeated — that abort is itself a reportable signal, never a false clean. |
| Gateway: DNS | `provision-forge-gateway.sh`'s dnsmasq config | Answers **every** query with the gateway's own IP by default, except an explicit allowlist (registries, `supabase.co`'s project, GitHub, `aiplatform.googleapis.com`) which forwards to real DNS. This restores the property route-forcing alone doesn't give: a genuinely non-existent/sinkholed C2 domain fails DNS *before* any connection is attempted, so the sample goes silently dormant rather than reaching the forced route at all. |
| Gateway: control API | `cloudrun/forge/forensics_api.py` | Stdlib-only HTTP API on a port excluded from the REDIRECT (since the gateway is now **shared** across many concurrent detonations, unlike the old one-netns-per-run). `POST /register` binds the caller's real source IP to a `scan_id` (closing any older registration for a reused IP, and opening a short GitHub "clone window"); `GET /forensics?scan_id=` returns only that scan's own captured records, bounded by the registration window, one-shot; `GET /ca-cert` serves the mitmproxy CA so the container can trust it before running anything untrusted. |
| Gateway: containment | `provision-forge-gateway.sh`'s iptables + systemd timer | `FORWARD` policy DROP — guest traffic is REDIRECTed to the *local* mitmproxy (→ INPUT), registry passthrough originates from the gateway's own outbound connection (→ OUTPUT), nothing should ever transit FORWARD. Since this VM is long-lived (not torn down every scan the way the netns was), a systemd timer reasserts the iptables rules every 2 minutes so a manual debugging session that flushes them self-heals within minutes instead of leaving containment down indefinitely. |
| Forensics | `cloudrun/harness/assemble-forensics.py` | **Byte-identical** to `microvm/assemble-forensics.py`. The entrypoint reconstructs the gateway's captured records (fetched via `/forensics`) plus the container's own local `strace` observation into one NDJSON file and runs this unchanged script against it — the schema string `claude-rabbit/forensic-record/microvm-1` is deliberately kept as-is (`lib/scan.ts`'s `normalizeForensics` matches on it exactly) even though the substrate is no longer a microVM. |
| Verdict | `verdict.py` | Honest dynamic verdict, substrate-agnostic. **Never a bare "Safe."** A caught (sinkholed/forged) exfil/beacon is scored maximally dangerous with the captured destination named; a merely-blocked attempt is still flagged; a clean run is "no malicious behavior observed", never "Safe". |

Deploying and wiring the Cloud Run image (build command, `gcloud run jobs deploy`,
the env var contract, and the `/api/deep` → `gcloud run jobs execute` trigger) is
covered in full in `sandbox/cloudrun/harness/README.md` — that file is the
authoritative reference for this path; this section only summarizes the
containment model.

### Superseded substrate: `sandbox/microvm/` (kept for reference, not what runs in production)

The original substrate ran detonation inside Kata + Firecracker microVMs on a
**persistent** GCE host, with a **per-run** network-namespace "forge" (its own
iptables/netns, torn down after every run) intercepting egress, and DNS inside the
guest rewritten to point at that per-run forge bridge IP. The outer layer was a VPC
firewall deny-all egress + no external IP on the detonation VM itself. This is the
architecture the tables in the rest of this document (Bulletproof cleanup, Double
containment, the live-run proof, and the `orchestrate.sh` commands below) describe
— all still real, working code, kept because it's a genuine, differently-shaped
proof of the same containment philosophy, but it is **not** the path production
scans take today. The Forge egress logic itself (registry passthrough vs. deceptive
forgery) carried forward essentially unchanged into the Cloud Run gateway above;
what changed is *where* that logic runs (inside a per-run netns vs. on a shared,
always-on gateway VM) and how a detonation environment is provisioned and destroyed
(a booted/deleted GCE VM vs. a Cloud Run Job execution).

## Bulletproof cleanup — how each substrate ends with nothing left running

**Cloud Run Jobs (current):** there is no VM to leak. Cloud Run manages the
container's lifecycle itself — each Job execution is destroyed when
`entrypoint.sh` exits (0 or non-zero), with no bash trap or ledger required on the
app side to guarantee it. The shared gateway VM (`cr-forge-gateway`) is
intentionally long-lived rather than reset per scan (see "Gateway: containment"
above for how it self-heals instead), and its captured forensics data is
time-bounded by `forensics_api.py`'s own cleanup loop rather than tied to a VM's
process lifetime.

**microVM (superseded, still real code in `sandbox/microvm/` /
`sandbox/orchestrate.sh`):** Bash traps do **not** run on SIGKILL/power-loss — the
likely cause of an early orphaned VM. So every detonation VM was booted with
**`--max-run-duration=30m --instance-termination-action=DELETE`**: a server-side
dead-man's switch that deletes the VM even if the orchestrator process dies. VM
names were recorded to a ledger **before** create, an EXIT/INT/TERM trap deleted
every recorded VM and verified it was gone, and a final prefix sweep
(`cr-sbx-`/`cr-trap-`/`cr-analysis-`) removed any straggler. A microVM run ends
with `gcloud compute instances list` **empty**.

## Double containment — the network invariant, on each substrate

> Never let a single real packet reach a real destination — as absolute as "never a bare Safe."

**Cloud Run Jobs (current):**

- **Layer 1 (forced route):** a GCP custom route forces every detonation
  container's Direct VPC Egress traffic to the gateway VM regardless of
  destination IP — there is no path out of the VPC that doesn't pass through it.
- **Layer 2 (gateway decision):** on the gateway, iptables REDIRECTs every
  arriving flow to a local mitmproxy; `forge_addon.py` proxies an exact allowlist
  (registries, the app's own Supabase project, Vertex, a time-boxed GitHub window)
  untouched and forges everything else. `FORWARD` is DROP — nothing the gateway
  doesn't itself originate ever leaves it.
- **Proof:** a beacon to a genuinely non-existent/sinkholed domain fails DNS
  resolution before any connection is even attempted (dnsmasq resolves it to the
  gateway's own IP, which `forge_addon.py`'s public-IP check then refuses to treat
  as a verified real destination); a beacon to a real-but-unlisted host completes
  DNS but gets forged at the TLS/HTTP layer instead.

**microVM (superseded):**

- **Layer 1 (VPC firewall, fail-closed):** the detonation VM had no external IP
  and a deny-all egress rule (pri 1000) to `0.0.0.0/0`; the only egress allowed
  was the pri-800 subnet rule to the trap.
- **Layer 2 (in-VM DNAT):** every outbound TCP/UDP from the untrusted code was
  DNAT'd to the trap's private IP before it left the NIC, so even a hardcoded-IP
  connect was redirected. The trap terminated locally and never forwarded
  (`ip_forward=0`, `FORWARD` DROP, no MASQUERADE).
- **Proof:** a control probe to a real host (`https://example.com`) from the
  detonation VM had to NOT succeed; the trap's capture + pcap independently
  showed the attempt was absorbed.

## The two safety rails (both enforced on either substrate)

1. **Hermetic + reset every scan.** No real credentials (only decoys), egress
   contained (forced-route + forge on Cloud Run; firewall + DNAT on the microVM),
   resource caps, and the detonation environment itself — a Cloud Run Job
   execution's container, or a GCE VM — is destroyed after every scan. A caught
   attack hits an empty room about to be demolished.
2. **Never a bare "Safe."** Every verdict shows the evidence and a `not_verified`
   list. Code that stayed dormant (suspecting a trap, or condition-gated) is
   reported as **UNVERIFIED**, never clean — absence of captured malice is not a
   clean bill.

## Synthetic fixtures (removed 2026-07-04 — pending redesign)

`sandbox/fixtures/` and `sandbox/microvm/fixtures/` were deleted from the repo:
shipping deliberately malicious-looking code (even synthetic, never-published,
attack-*shape*-only code) in-tree meant this repo's own self-scan through
ClaudeRabbit scored itself "Malicious" — a static reader has no way to tell
"test fixture used to prove our own detector" from real product behavior. The
proof runs below are real and stay as the historical record; the fixture
*files* themselves are gone and will be redesigned/restored later (likely
synthesized on demand or kept outside the main repo tree, not checked in
as-is). `sandbox/agent/test_knowledge_graph.py`'s fixture-dependent tests are
skipped (not failing) until then — see that file's module docstring.

All emulated attack *shapes*; none was real malware.

| Fixture (removed) | Source | Emulated |
|---|---|---|
| `fixtures/exfil-c2` | `index.js` | RUN-phase credential exfil: resolves `exfil.evil-c2.example` and HTTPS-POSTs decoy "loot". The sinkhole/forge proof. |
| `fixtures/cred-stealer` | `scripts/postinstall.js` | Install-time supply-chain exfil (postinstall reads creds + exfils + `eval(atob())` obfuscation). |
| `fixtures/miner` | `index.js` | Crypto-miner: pins CPU + beacons a mining pool. |
| `fixtures/benign-deps` | `package.json` deps | A genuinely benign repo with a real npm dependency — proves the registry-allowlist path actually installs deps and builds, then runs clean. |

## Proven live — on the microVM substrate (project `redacted-gcp-project`, us-central1-a)

These runs validate the containment *philosophy* (sinkhole a real exfil attempt,
build a real benign dependency through an allowlist proxy, never claim bare
"Safe") and predate the Cloud Run migration — they were run against
`sandbox/microvm/` / `sandbox/orchestrate.sh`, not the current production path.
The Cloud Run gateway's own equivalent proof (a real deployed round-trip against
`forge_addon.py`/`forensics_api.py`) is called out as not yet performed in
`sandbox/cloudrun/harness/README.md`'s own "What was NOT verified" section.

| Fixture | Build | Verdict | What the sinkhole proved |
|---|---|---|---|
| `exfil-c2` | ok | **0 / Dangerous** | Control probe to `https://example.com` from the detonation VM **timed out (`000 rc=28`) — contained**. The trap intercepted the HTTPS POST, captured SNI/Host `exfil.evil-c2.example`, path `/collect?id=victim-001`, and the would-be payload **inert** (decoded to the decoy canary creds). The Gemini-via-Vertex analysis correctly called it credential exfiltration. **No packet reached the real destination.** |
| `benign-deps` | ok (`npm install leftpad` via the registry proxy) | **100 / Clean run** | Deps fetched + built through the allowlist proxy, then ran clean under the sinkhole. Verdict is honest "no malicious behavior observed" — never "Safe"; the build-phase package-manager connections are noted as dependency-fetch, not flagged as malice. |

Both runs ended with the detonation VM deleted mid-run and the trap deleted at the
end — `gcloud compute instances list` **empty**. Double containment held both
times (deny-1000 firewall + iptables DNAT to the trap, trap `ip_forward=0`/FORWARD
DROP/no NAT).

**Measured auto-build success:** **5/6** node fixtures/repos built unattended on
live runs (the controlled-build proxy is what lets dependency-fetching repos like
`benign-deps` build — under the old full-lockdown they could not). Honest, small
sample; the proxy raises this number without weakening isolation.
**Escalation rate** is determined by the fast-path gate (separate edge function);
the deep sinkhole is the ~5% escalated path. Measure both on larger real samples
before over-investing — and re-measure both once meaningful volume runs through
the Cloud Run path specifically, since the substrate change can shift auto-build
success (registries/hosts the gateway allowlists vs. what the old trap proxy
allowlisted may not be identical).

## Run it — microVM path (the commands below target the superseded substrate)

```bash
# synthetic exfil fixture (the sinkhole proof)
bash sandbox/orchestrate.sh --zone us-central1-a --tarball ./sandbox/fixtures/exfil-c2.tar.gz --name exfil
# benign dependency-fetching repo (the controlled-build proof)
bash sandbox/orchestrate.sh --zone us-central1-a --tarball ./sandbox/fixtures/benign-deps.tar.gz --name benign
# a real public repo
bash sandbox/orchestrate.sh --zone us-central1-a --github sindresorhus/yocto-queue --name yocto
```

Every VM is deleted on exit (success, failure, interrupt, or even SIGKILL — via the
server-side `--max-run-duration … DELETE`). Run artifacts (`results/`, `.work*/`,
staged `*.tar.gz`) are gitignored.

**The Cloud Run path is not invoked this way** — it's a deployed Job
(`gcloud run jobs deploy cr-harness ...`) triggered per-scan by `/api/deep` via
`gcloud run jobs execute --update-env-vars`, not a script you run by hand against
a target repo. See `sandbox/cloudrun/harness/README.md`'s "Building and deploying"
section for the exact deploy commands and the required `CR_OWNER`/`CR_REPO`/
`CR_COMMIT_SHA`/`CR_SCAN_ID` env var contract.
