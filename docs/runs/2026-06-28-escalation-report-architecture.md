# Run Context — Escalation report architecture, sandbox speed, map, real logs (2026-06-28)

> Live record for the 5-unit mandate. Push through compaction via this file.
> Prior mission (make-it-shippable + inline moat) is DONE + merged to main; the inline moat
> works and is proven in the browser. This mission fixes the architecture ON TOP of that.
> Do NOT regress: the inline moat, honest-verdict rails (never bare "Safe", reputation≠behavior),
> determinism (fresh==cached per commit SHA), containment, the de-faked shell, auth-to-Google.

## Mission — five units, each proven in the localhost browser, merged

1. **Escalation OWNS a fresh complete report** — not stage-1 + a bolted-on forensic panel. Stage-1's
   understanding (clone, file read, reputation, flagged regions) is INPUT to escalation; escalation
   PRODUCES the report: fresh, complete, same sections/layout/component as a stage-1 report but
   deeper + fully runtime-aware. FRESH blended score (run + static + reputation), not stage-1's
   score with forensics tacked on — the score shown is escalation's. **NO "build not done / not
   executed / runtime unverified / largely unverified / couldn't verify the runtime" language EVER
   on an escalated repo** — running the code is the point, not a caveat; state concrete runtime
   findings with confidence; no unverified escape hatch. The ONLY rails that remain (not hedges):
   never a bare one-word "Safe", and reputation signals visually separate from code/runtime signals.
   Forensics woven in as first-class body+verdict content, not a separate yellow section. One report,
   one verdict — badge/score/summary/sections/final-verdict all agree + reflect the escalation run.
   Determinism: persist the escalation's score/verdict/summary at attach-time -> cached==fresh per SHA.
2. **Real designed frontend from `design.md`** (exists at repo root — use it, don't recreate). Render
   the report, esp. the escalated one, as real designed frontend per design.md (frontend-design skill
   + impeccable plugin). Escalated report = a deeper member of the same family, not a panel glued on.
3. **Sandbox speed ~2 min typical / ~5 min rare** (was ~15, ~10 pure overhead). Boot fast (pre-baked
   golden image / warm pool / faster machine+disk; kill SSH-wait/staging dead time); PARALLELIZE
   trap + sinkhole + detonation provisioning (total=max not sum); REUSE stage-1's pinned clone +
   comprehension (no re-clone/re-derive); real three-agent OpenCode (lead + parallel workers)
   parallelizing the analysis. Keep EVERY containment invariant. Prove the new seconds in the browser.
4. **World map — a dot for EVERY scanned repo by geographic origin** (owner location / repo origin /
   resolved geo), not just malware egress. Accurate political-map placement; egress plotted too when
   captured, else fall back to the repo's own location so the map is always alive. Hover = repo name;
   dot is clickable -> opens that repo's report in a new tab. New repos blink/pulse for ~10 min then
   settle. No invented locations (resolve honestly, exhaust real resolution first).
5. **Real logs** — kill the canned/incomplete timeline + the stale "Queued… not executed" line.
   OpenCode is the PRIMARY log source: stream the real agent thinking + responses live (like Claude
   Code's streamed output) + stage-1's real model reasoning, parsed into clean typography in a proper
   vertical chapter-wise timeline (same design language), resolving into the finished report. PERSIST
   the FULL end-to-end log (stage-1 + escalation + OpenCode) so "view logs" shows the complete real
   record. No stale/contradictory lines.

## Comprehension map (from 4 parallel Explore agents — key conclusions)

- **U1 seam:** `attach_forensics` RPC (migration `20260626000001_forensics.sql`) writes ONLY
  `forensics_json + deep=true`; `score/verdict/summary` stay STAGE-1. Render patches prose
  (`report-view.ts` summaryForView/finalNote) but the SCORE stays stage-1; forensic section is a
  separate amber `<ForensicSection>` card (`ReportBody.tsx:320`, def ~407–694). `verdict.py`
  (sandbox/verdict.py) emits dynamic_score/one_word/headline/code_behavior_findings AND the
  "Inconclusive / not_verified / did not run to completion" hedge that must go for escalated repos.
  `forensics.py` builds `honesty.notes` + `possibly_dormant_unverified` (also hedge). Stage-1 score
  = `_shared/scoring.ts computeScore()` (baseline 82 ± deltas). DB write at scan/index.ts ~1005–1037.
- **U3 timing:** orchestrate.sh boots TRAP then DETONATION SEQUENTIALLY (~85s+105s); base-image
  fallback when no golden; re-clones the repo (lines ~202–230) instead of reusing stage-1; agentic
  pass is a SINGLE-lead serial Vertex loop (agent_loop.py ~706–799), parallel peers DEFERRED, NOT
  real OpenCode. Levers: parallel `gcloud instances create` (background+wait), mandatory golden image,
  reuse stage-1 clone, real parallel OpenCode. Invariants to keep: no external IP/SA, deny-egress,
  sinkhole DNAT+DNS, trap assert, per-scan reset, dead-man's-switch, ledger+straggler sweep.
- **U4 map:** dots come ONLY from `v_board_dots` = `forensics_json.network_intent.geolocations[]`
  where score<60. GitHub `/users/{owner}` returns a free-text `location` we DON'T fetch
  (`_shared/github.ts ownerSignal`). `owners` table has NO geo columns. WorldMap.tsx has hover (SVG
  `<title>`) but NO click; `lib/world-geo.ts centroidForCountry` ≈60 countries, country-centroid only.
  Need: fetch+resolve owner/repo origin -> geo, store, UNION into v_board_dots, click->report new tab,
  pulse new repos.
- **U5 logs:** fast-path stages are mostly REAL except the stale line `"Queued for dynamic sandbox
  run (not executed on this pass)"` at scan/index.ts:924 (baked into `logs_json`). Deep-path
  milestones (`app/api/deep/route.ts milestone()`) are 15 CANNED templates mapped from orchestrate
  stderr (infra states). OpenCode/agent is batch Vertex (no streaming). logs_json persists fast-path
  only; deep milestones not persisted. Need: real agent stream -> route -> client timeline + persisted
  logs_json (stage-1 + escalation + OpenCode), kill the stale line.

## Unit plan (dependency order) + status

- **U1 — Escalation owns a fresh complete report** — ✅ DONE + MERGED (PR #18), proven in browser (clawdcursor 28->49 "High risk", hedge-free, coherent), reviewed SHIP.
- **U5a — Kill the stale "Queued… not executed" line** — LARGELY SUBSUMED by U1 (escalated reports get rewritten logs). Minor residual cleanup for the transient pre-detonation/cached state — QUEUED low-pri.
- **U2 — Report rendered as real designed frontend from design.md; forensics woven in first-class** — ✅ DONE (branch claude/report-design): the forensic evidence is re-woven as a first-class "What running it revealed" section in design.md's language (no amber panel, no duplicate verdict), proven in browser, independent design review SHIP.
- **U3 — Sandbox speed** — ✅ DONE (branch claude/sandbox-speed): PARALLEL trap+detonation VM boot
  (background+wait, max not sum) + 5s SSH polling + ASYNC detonation-VM teardown (overlaps analysis/
  verdict). **MEASURED on a real clawdcursor detonation: boot/setup overhead 4.5min -> ~50s** (START
  15:15:02 -> both VMs RUNNING 15:15:52; was ~4.5min sequential) — a 5x cut of the exact boot+setup
  overhead the brief flagged. Containment UNCHANGED (detonation idle until BUILD, gated behind the trap
  assert; deny-egress from boot; zero orphan VMs; re-blended clawdcursor 49 "High risk" cleanly). The
  clawdcursor TOTAL stays ~10min because its npm install is genuinely heavy (legitimate build work, the
  rare/heavy case), not overhead. REMAINING last-mile levers for ~2min on a typical repo (documented,
  larger infra): golden TRAP image (bake squid/sinkd to remove the ~40s trap provision), warm VM pool
  (boot in seconds), faster machine for heavy builds, real parallel OpenCode (currently OFF in the inline
  path — CR_AGENTIC unset — so not in the critical path). Commits b36f258 (parallel boot) + f5a08ee (async teardown).
- **U5b — Real OpenCode/AI stream surfaced live + full log persisted** — QUEUED (pairs with U3).
- **U4 — World map: a dot per repo by origin, click->report, pulse new** — QUEUED (standalone).

Per-unit aidhiraj_protocol (research -> plan -> COLD zero-context audit -> execute -> per-file rigor ->
self-review + INDEPENDENT zero-context review for any sandbox/VM/credential/routing change -> act +
re-test -> close). One-unit git, main green, gitleaks never bypassed, prove in the localhost UI.

## Unit log

### U1 — Escalation owns a fresh complete report — DONE + PROVEN IN BROWSER + reviewed SHIP (branch claude/escalation-owns-report off main)
**PROVEN:** re-detonated clawdcursor through the real /api/deep route; attach computed the fresh blend +
persisted it; the browser report (localhost:2311/AmrDab/clawdcursor) re-rendered fully coherent:
score **28 -> 49 "High risk"** (the escalation's blended score, NOT stage-1's 28), runtime-first
HEDGE-FREE summary ("We ran AmrDab/clawdcursor, a node project, in an isolated sandbox. It built and
started, then exited with an error on startup. We observed no malicious behavior, credential access, or
outbound exfiltration. Its score is held down by post-install script execution."), **NO** "what we could
not verify" list, **NO** hedge anywhere (logs rewritten — the stale "Queued… not executed" chapter gone),
ONE coherent verdict (card==hero). Zero orphan VMs. Independent review SHIP. Gates: tsc/61 node/17 deno/
18 verdict/lint/gitleaks all green. Commits 3c59ce5,2ae6fb2,b7fc34d,8518f3d,d59dfa8,b541bcb,a0c0d5a,d7d66a4.
Follow-ups (non-blocking, deferred): M1 non-atomic SELECT-then-UPDATE; L1 log degraded read; L2 unused
_possiblyDormant/_notVerified fields; L3 clawdcursor's persisted summary keeps minor wording (fixed at
source for future runs). NEXT: PR -> merge -> U5a (kill any residual stale lines) / U2 (design.md render).

(superseded status line below)
### U1 (was) — CODE DONE + DEPLOYED, browser proof next (branch claude/escalation-owns-report off main)
**Status:** all code landed + committed (3c59ce5 score, 2ae6fb2 attach+blend, b7fc34d frontend hedge-free,
8518f3d verdict.py, d59dfa8 direct-update). attach-forensics DEPLOYED with the blend. Gates: tsc clean,
node tests 61/61, deno scoring 17/17, verdict.py 18/18. NOTE: dropped the RPC migration — the edge fn
persists via a direct service-role `db.from('reports').update()` (bypasses RLS, no DB-password-gated
db push, columns already exist), so audit required-change #3 (drop+recreate RPC) is N/A. REMAINING:
restart dev on this branch + re-run clawdcursor in the browser to prove the fresh coherent report
(expect ~34 "High risk", runtime-first hedge-free summary, ONE verdict card==hero, NO "what we could not
verify"), confirm cache==fresh, then INDEPENDENT zero-context security/correctness review of the U1
diff (sandbox/credential/routing touched: attach-forensics direct write), then PR -> merge.

**INDEPENDENT REVIEW (zero-context, security+correctness): SHIP** — no CRITICAL/HIGH. Validated: the
direct service-role `db.from('reports').update().eq(owner).eq(repo).eq(sha)` is provably SINGLE-ROW via
the `uq_reports_owner_repo_sha` unique constraint (initial_schema.sql:117) — equivalent to the old RPC,
auth-first (runner-key constant-time), no injection (PostgREST .eq params), no wrong-row overwrite; blend
ceilings can't whitewash (caught-attack 25 < Malicious-split 30; crash/build-fail cap 64; static residual
neg-only; clean-exercised is the only path to green); determinism preserved (all rendered fields persisted
at attach); rails intact (never bare Safe, caught-attack never softened, reputation separate, hedge-removal
escalation-ONLY, containment-failure warning kept); malformed-forensic-record safe (asNum/asObj/asArr
guards + Deno.serve catch; summary strings render as escaped React text). 3 NON-BLOCKING follow-ups:
M1 SELECT-then-UPDATE not atomic (near-impossible race given runner-gate + 1/day deep; worst case = stale
residual term; future single-statement RPC); L1 read `error` dropped silently (behavior correct, log it);
L2 `_possiblyDormant`/`_notVerified` now unused on ForensicsView (dead-ish). Deferred (don't churn the
deployed fn mid-proof).

RE-DETONATION in flight (curl /api/deep clawdcursor, ~12min) to prove the FRESH blend persists + the report
re-renders coherently in the browser (cache blocks browser auto-retrigger of a forensics-present repo, so
the re-detonation is triggered via the real /api/deep route; the coherent RESULT is verified in the browser).
NEXT after re-blend lands: verify browser (score 28->~34 High risk, runtime-first summary, clean logs, one
verdict) -> commit any L1 fix -> PR claude/escalation-owns-report -> merge -> mark U1 DONE -> start U5a/U2.

(original cold-audit notes below)
### U1 cold-audit detail (branch claude/escalation-owns-report off main)
COLD AUDIT verdict: **GO-WITH-CHANGES**. Plan at scratchpad/u1-plan.md. The 7 REQUIRED changes (all adopted):
1. `computeEscalatedScore` EXERCISE-GATES the clean-run lift: caughtAttack→min(dyn,25); !exercised
   (`!auto_build_succeeded||!ran_without_crash`)→cap 64, static+rep may only LOWER; clean-exercised→
   dyn + static residual [-18,0] (neg-only) + rep [-18,+14]. Stops whitewashing a crash into green. **[DONE in `_shared/scoring.ts`]**
2. Persist a FRESH "Score" log chapter on attach — `logs_json` still bakes the stage-1 Score chapter
   (`buildScoreChapter` scan/index.ts:352-364) + the "escalation_pending"/"Queued… not executed on
   this pass" (scan/index.ts:932) lines, rendered verbatim (page.tsx ServerLogs + LogsOverlay). Rewrite
   the Score + Escalation chapters on attach with the blended values; persist via the RPC. **[TODO]**
3. RPC migration must `drop function attach_forensics(text,text,text,jsonb)` THEN create the new 7+arg
   version (create-or-replace can't change signature) + re-`revoke`/`grant` for the new sig. Update the
   `db.rpc("attach_forensics",…)` call in attach-forensics/index.ts. **[TODO]**
4. Drive `<ForensicSection>` verdict word/band/color from the BLENDED score (or hide its one-word
   badge) so card + hero never show two different verdicts. report-view.ts:393 `_verdictWord` is from
   `dynamic_score`; ReportBody.tsx:451-467. **[TODO]**
5. `summaryForView` returns the stored summary VERBATIM when ranSandbox (`if(ranSandbox) return staticSummary;`) — the stored summary is now the final hedge-free string. report-view.ts:188-197. **[TODO]**
6. test_verdict.py:53-57 assertion: drop "did not run to completion"/"largely unverified", keep "crash".
   KEEP the score caps (verdict.py:262 `if score>64: score=64`) — that cap protects the rail + the test.
   Reframe is LANGUAGE-ONLY. **[TODO]**
7. Hide the top-level "What we could not verify" block when its list is empty. ReportBody.tsx:339-349
   wrap in `{r._notVerified.length>0 && (…)}`. notVerified() returns [] for ranSandbox. **[TODO]**
RECOMMENDED (adopted): 8. DEFER weaving code_behavior_findings into the Code&Behavior column to U2.
9. add a determinism test (fresh==cached, no hedge regex in _finalNote/summary/_notVerified for
   ranSandbox, forensic card verdict==hero). 10. backfill: only clawdcursor is an existing escalated
   row; re-run it as the proof (don't leave other old escalated rows un-re-run).

Remaining U1 edits after scoring.ts: the attach-forensics edge fn (read row+owner, extract runtime
primitives from forensics_json: dynamic_score, exercised=auto_build_succeeded&&ran_without_crash,
caughtAttack=attack_egress_intercepted||cred_reads>0||captured hosts; compute blended score+verdict via
enforceVerdictRails; build a runtime-first HEDGE-FREE summary; rewrite Score+Escalation log chapters;
call extended RPC) → migration → verdict.py language reframe + test → report-view.ts (summaryForView
no-op, notVerified [] , finalNote hedge-free when ranSandbox) → ReportBody.tsx (hide empty
could-not-verify, ForensicSection verdict from blended, drop forensic card hedge sub-block) → tests →
deploy scan+attach-forensics → re-run clawdcursor in the browser to prove fresh coherent report.
Clawdcursor expected: dyn=64 (crashed on startup, !exercised → cap 64), static residual ~-18, new-owner
-12 → ~34 "High risk", runtime-first summary, NO hedge, one coherent verdict.
