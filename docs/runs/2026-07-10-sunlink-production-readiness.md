# Project Sunlink — production-readiness sweep (2026-07-09 → 07-10)

A full read-and-run production-readiness session. Rollback point tagged before any change
(`pre-sunlink-production-readiness-known-good` → `5aadcc2`). An "Understand" pass (12 parallel
readers) produced an 80-finding defect map; every fix below was verified by running it, and the
headline work was deployed to production (`clauderabbit.in` / Supabase `mjvlczaytkhvsolnhhkz`)
and confirmed live.

## Headline deliverables — shipped + verified on production

### 1. Real npm published-artifact scanning (was: GitHub-only, blind to the tarball)
The scanner resolved an npm name to the GitHub repo its `package.json` linked to and scanned
THAT — blind to a compromised publish whose malicious install hook / trojaned code lives only in
the tarball. New `supabase/functions/_shared/npm.ts` fetches the ACTUAL published tarball for a
resolved version, integrity-verifies it (SRI sha512 / shasum; refuses a tampered artifact 422),
unpacks it in-process (gzip + tar, native to the Deno edge runtime), and runs the real artifact
files through the same static-scan → model → scoring pipeline. It cross-checks the artifact vs
its linked source and flags an install hook present in the tarball but not the repo — the
compromised-publish shape — forcing escalation. SSRF/DoS-guarded (registry-pinned tarball host,
size-capped download, bounded file set). Wired through web (`/npm/<pkg>` route), CLI, and MCP.
**Live proof:** `left-pad` → 94/Trusted (artifact scanned, integrity sha512), `esbuild` → 37 with
its real `postinstall`/`install.js` detected from the artifact. 10 npm unit tests incl. both
divergence directions.

### 2. False-positive scoring — root-cause fix (was: the product's own repo scored Malicious)
Two real root causes, both proven and fixed:
- **Test-fixture/security-tooling context:** a credential-PATH reference inside a genuine
  test/fixture/example file (e.g. this repo's disclosed `exfil-fixture.py`) is a self-contained
  simulation, not a runtime access — surfaced as a region but not the −40 signal, ONLY when the
  file shows no harder tell (obfuscation / embedded live secret keep full weight, so a real attack
  can't hide behind a "fixture" name).
- **Private-IP + install-context:** a hardcoded loopback/RFC1918 IP (a localhost health check, an
  internal gateway) is internal infra, not internet egress; and only a real auto-running install
  hook (install/setup/bootstrap-named) — not every `.sh` — carries the −40 install-time-exfil weight.

**Live proof (both directions):** this repo went 26/Malicious → **70/Caution** on a fresh
production scan, with an honest security-tooling summary; a real attack at `tests/…-fixture.js`
stays 8/Malicious (obfuscation never downgraded). 27 static-scan tests.

### 3. Live scan-progress logs (was: "Escalate" then a stuck screen then a report)
The deep path emitted every container stage as `status:active` under one "Detonate" chapter, so
they collapsed into a single line that sat unmoving through the whole ~3-min detonation. Now each
container stage (Cloning → Installing → Agents exploring → Running → Assembling → Persisting) is a
distinct timeline chapter, and a heartbeat covers the Cloud Run cold-start gap so the timeline
never sits silent. **Live proof:** a real production detonation of `AmrDab/clawdcursor` showed the
distinct stages, completed, attached forensics, and re-blended the score 33→64 (the moat lifting a
statically-feared repo).

## Sandbox / moat criticals — fixed + tested (source-level; see deploy notes)

- **#4 moat bypass (deployed):** `attach-forensics` live-verified ANY captured host and cleared it
  if it answered HTTPS — so a real RUN-phase C2 running a web server scored clean. Now the liveness
  rescue is restricted to BUILD-phase-unrecognized hosts only (a new phase field from
  `assemble-forensics.py`); run-phase egress is never downgraded. Forward-compatible (legacy records
  keep prior behaviour, so the edge deploy is non-regressing and the fix activates when the sandbox
  image is rebuilt to emit the field). 7 Python + 14 TS tests.
- **#2/#3 forge control-plane auth:** `/register` and `/forensics` had no auth separating the trusted
  harness from the untrusted repo in the same container. Now a shared `CR_FORGE_CONTROL_KEY`
  (constant-time compare) is required; `entrypoint.sh` sends it; the provisioning script bakes it in.
  Rollout-safe (warn-and-allow until configured).
- **#1 credential in blast radius:** `detonate.py` now runs the untrusted build/run with a SCRUBBED
  environment (every harness secret — the Vertex SA credential, runner key, scan id — stripped),
  plus opt-in unprivileged-user separation (`CR_UNTRUSTED_USER`, off by default). 22 tests.

## Other production-grade fixes
- PDF export: per-instance headless-Chromium concurrency cap (429 over cap) — resource-exhaustion
  DoS bound; full `puppeteer` moved to devDependencies.
- SEO: un-scanned `/owner/repo` pages now `noindex` (soft-404 fix); real reports stay indexable.
  **Verified live.**
- CLI + MCP proven end-to-end against production (login/token persistence, an authenticated npm
  artifact scan, a GitHub deep-report scan, logout, and the login gate) — via a minted-then-deleted
  test token.

## Verification totals
118 Deno + 133 Node + 29 Python assertions pass; `npm audit` 0 vulnerabilities (root/cli/mcp);
eslint clean; `next build` green; 15-way concurrent scan load → all 200, no 5xx. Edge functions
`scan` + `attach-forensics` and the frontend deployed to production and confirmed live.

## Honest limitations (not verified in this environment)
- **Lighthouse 95+** was not run — no Lighthouse runner in this environment. Pages are
  server-rendered with minimal client JS, but the score is unmeasured here.
- **Sandbox image rebuild:** the Python/shell moat fixes (`assemble-forensics.py`,
  `forensics_api.py`, `detonate.py`, `entrypoint.sh`) are committed + unit-tested but require a
  Docker/GCP harness-image rebuild + a `CR_FORGE_CONTROL_KEY` provisioning step to fully activate —
  neither is runnable from this environment. The `attach-forensics` edge deploy is forward-compatible
  so it is safe ahead of that rebuild.
- **`/oauth/register` unbounded rows:** low-severity housekeeping (redirect_uri validation is intact);
  left as a noted follow-up rather than an untested migration.
