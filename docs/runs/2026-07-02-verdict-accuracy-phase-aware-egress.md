# Run doc — Verdict-accuracy fix: phase-aware egress classification (2026-07-02)

## The bug
The forensic scorer treated ANY intercepted non-registry network attempt identically —
`sandbox/microvm/assemble-forensics.py` (~line 189, pre-fix) set
`attack = cred_exfil or cred_reads > 0 or any_egress`, docking the score −35 whenever
`captured_intent` was non-empty. Because the containment forge intercepts EVERY
non-registry destination by design, this made "any captured host at all" read identically
to a genuine credential-theft or C2 event. It just produced a real false positive: the
prior session's fix to run builds to completion (see
`2026-07-01-adaptive-build-recovery.md`) made `react/react`'s real `yarn install`
dependency fetch to `downloads.sourceforge.net` observable — and it scored **25/"Malicious"**
for a completely ordinary supply-chain fetch, no credential access, no exfiltration.

## The fix — phase-aware classification, not weaker detection
Added a HOST-CLOCK phase boundary and used it to split "any captured host" into two
genuinely different things:

1. **`sandbox/microvm/guest/detonate.py`** — `emit_phase_marker("run_start")`, a new
   best-effort beacon to the existing telemetry channel (`PHASE_MARKER_PATH =
   "/cr-phase-marker"`, distinct from the main observation POST), fired at the exact
   moment the install finishes and the run is about to start. The forge stamps it with
   its OWN wall clock (`forge_addon.py`'s `_emit()`, the same clock every captured line
   already gets) — no guest/host clock-skew risk, since every comparison stays on the
   host's clock. A lost beacon (network hiccup) just means "phase unknown."

2. **`sandbox/microvm/assemble-forensics.py`** — `load()` now extracts that beacon's
   timestamp as `phase_boundary_t`. Each captured attempt is classified: a BUILD-phase
   fetch (`t < phase_boundary_t`) to a recognized software-distribution host
   (`github.com`, `githubusercontent.com`, `sourceforge.net`, `gitlab.com`,
   `bitbucket.org`), with NO credential involvement, becomes a supply-chain CAUTION
   (`verdict.supply_chain_egress`, −10 to the dynamic score) instead of an attack
   (`verdict.captured_network_intent` / `attack_egress_intercepted`, −35). Everything
   else keeps FULL weight, unconditionally: a credential/canary exfil at any phase, an
   actual credential-file read, ANY run-phase attempt, a build-phase fetch to an
   UNRECOGNIZED host, or a refused pinned/mTLS handshake. A missing phase marker (older
   capture, lost beacon) fails toward the STRONGER classification — never softer. The
   containment narrative (a neutral fact, not a verdict) still lists every captured
   host regardless of classification; `network_intent.attempts` stays full and
   unfiltered for transparency — only the ATTACK-GRADE signal is narrowed.

3. **`supabase/functions/attach-forensics/index.ts`** — `extractRuntime` reads the new
   `supply_chain_egress` field (`RuntimeFacts.supplyChainHost`); `caughtAttack` itself
   needed NO logic change (it already derives from `captured_network_intent` /
   `intended_destinations`, both now attack-grade-only at the source). `buildRuntimeSummary`
   gets a third branch: when there's no caught attack but a supply-chain host was
   observed, the summary says *"Its install reaches `<host>` for dependencies — a
   supply-chain note, not an attack"* instead of silently omitting the real signal.
   `rewriteEscalatedLogs`'s "Sandbox run" chapter mirrors this (a `warn` chapter, not
   `bad`, with the same honest line) so the full-logs view agrees with the summary.

4. **`supabase/functions/_shared/scoring.ts`** — no functional change (the module was
   already correctly agnostic — it just consumes a `caughtAttack` boolean). Documented
   the now-critical PHASE-AWARE contract on `ScoringEscalatedInputs.caughtAttack` and
   `ScoringDynamicOutcome.egressIntercepted` explicitly, since getting this field's
   semantics wrong either lets a real attack score clean or false-flags a benign repo —
   exactly the bug this whole fix exists to prevent.

## Proven — real detonations, before/after, in the browser

| Repo | Before | After | Why |
|---|---|---|---|
| **react/react** | **25 / "Malicious"** (false positive) | **64 / "Caution"** — *"The project did not build to a runnable state... Its install reaches downloads.sourceforge.net for dependencies — a supply-chain note, not an attack. Its score is held down by install-time script execution."* | its `yarn install` fetches a dep from sourceforge during BUILD, no credential involvement |
| **cr-fixtures/exfil-beacon** (the check that matters most) | 25 / "Malicious" | **25 / "Malicious", unchanged** — *"We caught it attempting to reach drop.evil-c2.example."* | genuine RUN-phase C2 beacon + canary credential exfil — full weight, not softened |
| **AmrDab/clawdcursor** | 64 / "Caution" | **64 / "Caution", unchanged** — identical summary | untouched by this fix; re-verified in-browser as a non-regression baseline |

react's score (64) lands exactly at `ESC_INCOMPLETE_RUN_CEILING` in `scoring.ts` — the
SAME ceiling clawdcursor hits for the same reason (a run that didn't fully build+execute
cleanly) — once `caughtAttack` is correctly false, the escalated scorer's existing
exercise-gating logic does the rest; no new scoring weight had to be invented for this
case.

## Test coverage locking this in
- **`sandbox/microvm/test_assemble_forensics.py`** (new) — 22 checks, end-to-end against
  the REAL `assemble-forensics.py` CLI (writes a synthetic capture.jsonl, invokes the
  actual subprocess, asserts on the parsed record): canary exfil stays attack-grade
  regardless of phase; the react-mirroring build-phase distribution-host fetch is
  downgraded; the SAME kind of host fetched RUN-phase is NOT downgraded (phase-awareness
  cuts both ways); a build-phase fetch to an unrecognized host stays attack-grade; a
  refused pinned handshake stays attack-grade even at build-phase; a MISSING phase
  marker fails toward full weight (conservative default); the containment narrative and
  `network_intent.attempts` transparency are preserved. All 22 pass.
- **`supabase/functions/attach-forensics/index.test.ts`** (new) — 7 Deno tests against
  `extractRuntime`/`buildRuntimeSummary` (exported for testability): the false-positive
  case reads as non-attack with an honest note; a real caught attack is unaffected;
  `intended_destinations`'s defensive fallback still works; a plain clean run has no
  supply-chain text bleeding in. All 7 pass.
- **`scoring.test.ts`** (pre-existing, 17 tests) — unchanged, still green (no functional
  change to `scoring.ts`).
- Full `_shared` suite: 33/33 pass. `deno lint`: 0 problems. `deno check`: clean on
  `scoring.ts`, `attach-forensics/index.ts`, `scan/index.ts` (each function's own
  `deno.json` import map, matching how Supabase actually resolves them).

## Deployed
- `attach-forensics` edge function: `supabase functions deploy attach-forensics` (bundles
  the updated `scoring.ts` + `run-timeline.ts` automatically).
- `assemble-forensics.py` copied to `/opt/cr/microvm/` on `cr-host-build` (host-side, no
  rebuild needed — it runs directly, not baked into the microVM image).
- `detonate.py` copied to `/opt/cr/microvm/guest/` and the detonation base image
  rebuilt (`CR_BASE_IMAGE_BUILT cr-detonation-base:latest`) — it IS baked in.

## Incidental fix (environment, not the bug)
The long-running dev server's inherited PATH didn't carry the gcloud SDK bin dir (stale
process from earlier in the session), so `/api/deep`'s `hasGcloud()` check failed
("deep path needs gcloud on the sandbox controller") when re-proving this fix. Set
`CR_SANDBOX_PATH_PREPEND` in `.env.local` (gitignored, local-only) to the gcloud bin dir
— the route already supported this exact env var for precisely this class of problem —
and restarted the dev server. Also removed one pre-existing, unrelated dead import
(`LogKind`, unused since before this session) from `attach-forensics/index.ts` while
already touching that file, surfaced by `deno lint`.

## Cost/containment rails — unchanged, reconfirmed
`cr-host-build`: RUNNING, `cr-idle-exempt=1` metadata present, idle-watchdog dry-run
confirms *"exempt from idle-stop (cost bounded by the 12h max-run backstop)"*, timer
active. Not stopped manually. No containment invariant touched — the forge still
intercepts every non-registry destination exactly as before; this fix only changes how
the SCORER interprets an already-fully-intercepted attempt.

Gates: tsc 0 · eslint 0 · node tests 72/72 · deno lint 0 · Python tests 22/22 · Deno tests
40/40 (33 pre-existing + 7 new).
