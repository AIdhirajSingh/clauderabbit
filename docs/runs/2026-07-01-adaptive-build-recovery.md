# Run doc — Adaptive build recovery: the sandbox now builds like a developer (2026-07-01, session 3)

## The problem (stated at the root)
The entire sandbox investment — real Firecracker microVM, the deceptive forge, OpenCode agents,
proven containment — fired correctly and then died on a single fixed command:
`npm install` (with retry flags). It either worked or gave up. `react/react` proved it: the
system escalated, detonated, ran the agents, then failed the build on a plain dependency
conflict. The auto-build success rate is the number that decides whether "we run it" is real,
so the fix had to be at the root: the agentic/terminal layer must OWN build recovery — read the
real error and adapt, exactly like a developer — all INSIDE the existing containment boundary,
with no invariant weakened, and a repo that genuinely cannot build must still honestly report
"did not build to a runnable state."

## What changed (all inside containment — no rail touched)

1. **Package-manager detection** (`detonate.py` `detect_node_pm`): pnpm-lock.yaml → pnpm,
   yarn.lock → yarn, package-lock.json → npm, else the `packageManager` field. The right tool
   before adapting on error — a plain `npm install` on a yarn/pnpm repo is often already wrong.

2. **Error-driven recovery ladder** (`adaptive_node_build`) — the decision tree a developer
   runs, encoded as error→flag rules (no model egress needed; the forge still blocks everything
   but registries, so this runs with the SAME isolation):
   - native install with the repo's own PM, given the **full budget in one continuous run**
     (a hard-killed install can't be cleanly resumed; a real monorepo needs 1.5–3 min — it must
     run to the end; a timeout stops honestly rather than corrupt-retrying);
   - pnpm frozen/outdated lockfile → `pnpm install --no-frozen-lockfile`;
   - npm ERESOLVE peer conflict → `npm install --legacy-peer-deps` → `--force`;
   - universal npm fallback for repos npm *can* read from package.json.

3. **Node 20 → Node 22 + corepack in the base image** (`detonation-base.Dockerfile`) — the real
   developer environment. The old base (Debian Node 20 + one global pnpm) could not build the
   modern mainstream: repos pin their PM (`packageManager: pnpm@10/11`, `yarn@4`) and those
   versions need Node 22+, so a pinned-pnpm install *crashed* (`ERR_UNKNOWN_BUILTIN_MODULE`) and
   a plain `npm install` died on the `workspace:` protocol. corepack fetches + runs each repo's
   OWN pinned PM. Every fetch still goes through the forge's registry fast-path — **no new egress
   path, containment unchanged**. `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` so the non-interactive
   microVM never hangs on corepack's download prompt.

4. **EMFILE fix** (`orchestrate-microvm.sh`): a large monorepo opens thousands of files and died
   under the microVM's default 1024 fd cap. `ctr run --rlimit-nofile 1048576:1048576` — a
   RESOURCE limit only, no capability/privilege/egress change; every containment invariant holds.
   Build budget raised to 240s; the outer `ctr` wall-clock cap to 330s to match.

## Proven by running — real microVM detonations THROUGH the forge

Every row below is a real `/api/deep` detonation on the live host; the outcome is ground-truthed
from the in-guest `CR_HARNESS_DONE` record, and the failure *causes* from the forge's per-flow
capture (`/var/log/cr-forge/*-capture.jsonl`).

| Repo | Pinned PM | BEFORE (old fixed `npm install`) | AFTER (adaptive + Node 22/corepack) | Why |
|---|---|---|---|---|
| tj/commander.js | npm | ✅ build | ✅ npm — native (11s) | registry-only |
| expressjs/express | npm | ✅ build | ✅ npm — native (27s) | registry-only |
| unjs/ofetch | pnpm@10 | ✅ build | ✅ pnpm — native via corepack (10s) | registry-only |
| prettier/prettier | yarn-berry | ✅ build | ✅ yarn — native via corepack (44s) | registry-only |
| **TanStack/query** | **pnpm@11** | ❌ ERESOLVE | ✅ **pnpm 11 — native via corepack (127s)** | registry-only — **the new win** |
| vitejs/vite | pnpm@10 | ❌ `workspace:` | ❌ did-not-build | forge blocks **cdn.playwright.dev** |
| react/react | yarn classic | ❌ ERESOLVE / `link:` | ❌ did-not-build | forge blocks **github / sourceforge** |

**Honest auto-build rate on this varied batch: 4/7 → 5/7.** The improvement is one repo
(TanStack/query) and it comes *demonstrably* from real adaptive recovery: npm literally cannot
install it (`workspace:` protocol), and the old sandbox could not run its pinned pnpm 11 on Node
20 — corepack on Node 22 serves pnpm 11 and it builds (rc=0, 51 clean fetches from
registry.npmjs.org). No criterion was loosened; `auto_build_succeeded` is still the real install
exit code.

### The two that still don't build are the honest, rail-preserving edge
This is the most important finding, and it is NOT a build-logic failure. On both vite and react
the **tooling now succeeds** — corepack served the right PM and every *registry* fetch went
through (vite: 27× registry.npmjs.org; react: registry.yarnpkg.com). They fail because their
install reaches **non-registry hosts** that the containment forge correctly forges:
- **vite** → `cdn.playwright.dev` (15×) — a Playwright devDependency's postinstall downloading
  browser binaries from a CDN.
- **react** → `raw.githubusercontent.com`, `downloads.sourceforge.net`, `github.com` — deps
  fetched straight from GitHub/SourceForge, plus it's a library with no runnable entrypoint.

We do **not** open the egress allowlist to github/CDNs to make a repo build — that allowlist is
the abuse protection (an open path is an exfil / second-stage-payload channel). So these honestly
report **"did not build to a runnable state,"** and that is the *correct* outcome. Note the
sandbox still extracted real signal from them: the forge *observed* the non-registry fetch
attempts — exactly the kind of install-time behavior the product surfaces.

Structural takeaway for the moat: in a hermetic, registry-only sandbox the auto-build ceiling is
"does the repo's full install stay within package registries." Modern monorepos that download
browsers (playwright/puppeteer/cypress) or fetch deps from GitHub will hit this boundary by
design. That is the honest, rare, rail-preserving edge — not a common dependency wrinkle.

## Other proofs by running
- **pnpm was 100% broken before** (a real regression the fixed command masked): the global
  pnpm@10 crashed on Node 20 (`ERR_UNKNOWN_BUILTIN_MODULE`) on *every* invocation — the native
  pnpm path was dead for every pnpm repo. Fixed; ofetch now installs via native pnpm (10s) where
  it previously only survived via the npm fallback (31s).
- **EMFILE gone**: `CR_FDLIMIT soft=1048576->1048576 hard=1048576`, zero EMFILE on the large
  monorepo runs.
- **Full-budget native**: react's yarn now runs its full ~143s instead of being killed at a
  120s cap (a killed classic-yarn can't cleanly resume).
- **Open on GitHub button** (`ReportScreen.tsx`): a link-out beside PDF / Copy-link, new tab,
  opener-isolated, using the CANONICAL owner/name. Proven in-browser — clicking it opened
  `https://github.com/react/react` ("react/react: The library for web and native user
  interfaces.") in a new tab.
- **Honest, distinct verdicts render** (in-browser): react "The project did not build to a
  runnable state" vs clawdcursor "It built and started, then exited with an error on startup" —
  distinct build outcomes, distinct honest copy, never a bare "Safe."
- **Containment + cost rails intact**: host clean after ~15 detonations (no orphan
  firecracker/netns/containers, disk 30%); `cr-idle-exempt=1` metadata + name match → idle
  watchdog dry-run returns "exempt … cost bounded by the 12h max-run backstop"; max-run 43200s
  STOP present. The host is NOT stopped manually — only the 12h backstop may stop it.

## Discovered downstream (flagged, NOT silently changed): scoring treats benign build-time dep-fetches as "attack egress"
A correct build has a side effect worth surfacing honestly. Now that a repo's install runs far
enough to fetch its real dependencies, the sandbox *observes* fetches to non-registry hosts
(github, sourceforge) that a truncated build never reached. The forensic scorer
(`assemble-forensics.py:189`) sets `attack = cred_exfil or cred_reads > 0 or any_egress` and docks
−35 for `captured_intent`, so **any** intercepted non-registry egress — including a benign, failed
dependency fetch during BUILD — is scored as a caught attack. Effect: `react/react` (which pulls a
dep from `downloads.sourceforge.net` during `yarn install`) now scores **25 / "Malicious"** — a
false positive on the world's most-trusted UI library.

This is a real, PRE-EXISTING scoring-calibration issue the build fix made visible on a flagship
repo. It is **not changed in this commit** on purpose: it is a security-sensitive subsystem (an
install script fetching a second-stage payload from github IS a genuine supply-chain vector, so
this cannot be blindly loosened) and a severity judgment. Recommended fix (own focused session):
classify BUILD-phase dependency fetches to software-distribution hosts as a supply-chain *caution*,
reserve "caught attack" (Dangerous/Malicious) for real indicators — canary/credential exfil,
run-phase C2 beacon, refused-pinned/mTLS handshakes — and re-verify the `exfil-beacon` fixture is
STILL caught and `clawdcursor` is unchanged. Tracked as a follow-up; this local `react` report is a
dev-DB artifact, not public.

## Gates
tsc 0 · eslint 0 · node tests 72/72. Changed files: `sandbox/microvm/guest/detonate.py`,
`sandbox/microvm/orchestrate-microvm.sh`, `sandbox/microvm/detonation-base.Dockerfile`,
`components/spa/screens/ReportScreen.tsx`.
