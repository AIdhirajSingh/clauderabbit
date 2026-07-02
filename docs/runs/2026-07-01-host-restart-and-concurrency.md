# Run doc — Host restart (regression fix) + concurrency proof (2026-07-01, session 2)

## The regression
The host `cr-host-build` was manually STOPPED at the end of the prior session "for cost
hygiene" — the exact failure the watchdog re-scope was built to prevent, done by hand.
Consequence: the next user signed in fresh, scanned `AmrDab/clawdcursor`, and the moat
could not reach the sandbox → honest "Sandbox run incomplete" but no real detonation.
"Always-on" means smallest-viable-machine-kept-warm, not a big instance — but it must
NEVER be stopped manually; only the 12h max-run backstop may ever stop it.

## Fixed + proven by running

1. **Host back up, staying up.** Started `cr-host-build`; its boot services rebuilt the
   devmapper pool (`rw`) + base image automatically. Verified `cr-idle-exempt=1` and the
   watchdog dry-run: *"'cr-host-build' is the production substrate host — exempt from
   idle-stop (cost bounded by the 12h max-run backstop)"*, timer active. The ONLY thing
   that may stop this host is the instance 12h `max-run-duration=STOP` backstop. It will
   not be stopped manually this session or any future one.

2. **Machine type.** `n2-standard-4` (4 vCPU, nested-virt). The absolute smallest
   nested-virt-capable types are smaller (n1-standard-1 / n2-standard-2), but they can't
   hold the host workload (containerd + buildkit + the forge + 3 OpenCode agents) PLUS
   two parallel microVMs — the concurrency requirement below. 4 vCPU is the smallest that
   comfortably sustains it (measured: 2 parallel detonations with zero slowdown). Left
   as-is; not destabilizing a working host to chase a smaller type.

3. **Real clawdcursor detonation → earned "Sandbox run".** Via the browser + /api/deep:
   clawdcursor (commit e6585f17) detonated in 76s on the microVM+forge substrate (build
   rc=0, code ran + crashed on startup, `connect_count 0`), forensics attached,
   containment CONFIRMED (`no_real_packet_reached_destination: true`, `egress_control_probe:
   contained`) → renders "Sandbox run" (64 Caution), not "incomplete".

4. **Concurrency — audited + proven; real ceiling = 2 (matched to 4 vCPU).**
   - **Audit (no accidental serialization):** every per-scan resource is uniquely
     namespaced by the unique `$ID` (buildSlug = base + timestamp + random). Orchestrator:
     scratch `/tmp/cr-scan-$ID`, image `cr-det-$ID`, container `det-$ID`, netns
     `cr-run-$ID`, logs, capture — all per-`$ID`; no global lock. Forge: netns
     `cr-forge-$ID`/`cr-run-$ID` (bridge/GW/port live INSIDE the netns → isolated); veth
     created directly into the netns; the registry-uplink veth + its /30 subnet are a
     hash of `$ID` over ~16k distinct subnets (a prior review-HIGH#3 fix explicitly to
     stop concurrent runs cross-wiring MASQUERADE/containment). Only intentional serial
     point: the in-process `MAX_CONCURRENT=2` cap — a 3rd concurrent deep gets an honest
     429 "sandbox at capacity", never a silent queue.
   - **2 concurrent DEEP (proven):** fired /api/deep for clawdcursor + cr-fixtures/exfil-
     beacon simultaneously. B (beacon) persisted at +42s WHILE A (clawdcursor) ran to +76s
     — genuinely parallel (serial would be ~118s). Distinct isolated forensics, no
     cross-contamination: A `target=AmrDab/clawdcursor caught=false`, B `target=cr-fixtures/
     exfil-beacon caught=true` (B's forge caught its C2, A's didn't) — two isolated capture
     pipelines. Both `contained=true`. A took 76s solo AND concurrent → no slowdown on 4 vCPU.
   - **2 concurrent stage-1 (proven):** psf/requests + tj/commander.js simultaneously →
     both correct (87 / 96) in 7s total (parallel, not ~14s serial). Edge fn is stateless
     per-request with idempotent upserts → no shared-state race.
   - **Browser two-tab (proven):** chalk/chalk (clean) in one tab + facebook/react
     (escalating) in another, fired together → chalk completed (98 Trusted) while react
     detonated live in parallel, fully independent.
   - **Real ceiling: 2 truly-parallel deep detonations** on this host (the policy cap,
     matched to 4 vCPU with no measured slowdown). A 3rd is honestly rejected (429). The
     1000-user fleet remains documented future scope, not built.

5. **Found + fixed a real moat bug (bonus, at the cause).** While proving concurrency,
   facebook/react showed "incomplete" despite a clean detonation. Cause: GitHub redirects
   facebook/react → react/react, so the fast path stored the report under the CANONICAL
   `react/react`, but the inline deep block passed the USER-TYPED `facebook/react` to
   runDeepScan + the read-after-write re-fetch → attach-forensics 404 "Report not found"
   → every redirected/renamed repo silently never earned "Sandbox run". Fix (commit
   e088546, merged to main): pass `report.owner`/`report.name` (canonical) to both calls.
   Proven: facebook/react now detonates and renders "Sandbox run" (64 Caution, containment
   confirmed, honest "did not build to a runnable state" — react's npm install hits an
   ERESOLVE peer-dep conflict, correctly reported, no malice observed). Non-redirected
   repos unaffected. tsc 0, eslint 0, node 72/72.

## State at session end (host left RUNNING, by instruction)
- `cr-host-build`: RUNNING, n2-standard-4, exempt from the idle watchdog, 12h max-run STOP
  backstop as the sole stop path. NOT stopped manually. Pool `rw`, base image present.
- main @ e088546. Dev server up on localhost:2311 (main checkout).
