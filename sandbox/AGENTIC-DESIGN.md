# Agentic Sandbox Upgrade — Design (Phase 2, the moat)

Upgrades the existing **monitored-sinkhole observer** into a **cross-validating agentic
behavioral analyzer** that both **explores** the whole repo (finding dangerous code the
stage-1 flagged-region scan missed) and **detonates** it under the existing hermetic
sinkhole. This doc is the plan; it is cold-audited before any build.

---

## ⚠ COLD-AUDIT REVISIONS (binding — supersede anything below that conflicts)

The cold audit (58/100) found real flaws. These corrections are BINDING and the V1 build
follows them. The single riskiest assumption it named: *"outside the VM" ≠ "safe"* — the
brain has Vertex credentials + real egress the sealed VM never had, and it ingests hostile
repo content. Every constraint below flows from closing that.

**SECURITY CONSTRAINTS (non-negotiable):**
- **C1 — `detonate()` is NOT free-form SSH.** Untrusted code runs ONLY through
  `run-harness.sh run` as the non-root **`runner`** uid (the sinkhole DNAT exempts uid 0,
  so root traffic would BYPASS the sink — an egress leak). `detonate()` is a fixed-grammar
  tool that invokes the harness run path, and re-runs `sinkhole-flip.sh assert` immediately
  before each detonation, refusing if the assert fails. No arbitrary/root command relay.
- **C2 — detonation state machine.** Build phase closes after the first flip-to-RUN and
  cannot be re-entered on the same VM (no re-opened squid proxy on a dirty VM). The agent
  may only request RUN-phase detonations after flip. A fresh build = a fresh VM. Scan still
  ends in VM deletion.
- **C3 — repo content is untrusted DATA, never instructions.** All repo bytes and all
  VM-authored output (`cr-report.json` etc.) are wrapped in delimited, escaped context and
  never placed in a system/instruction position. The controller's own egress is locked to
  the Google/Vertex API endpoints only. `detonate`'s fixed grammar means an injected "run
  this" cannot become arbitrary execution.
- **C4 — AI budget < cage, fixed.** The hard cage is the VM `--max-run-duration … DELETE`.
  The AI working budget is a FIXED fraction (≤60% of the cage) with a reserved finalize/
  persist/delete margin, and is NEVER adjustable up toward the cage. "Extension" = spend
  remaining pre-budgeted time, never raise the ceiling. Cage and AI budget are two distinct
  numbers, AI provably strictly less. A hard per-scan TOKEN budget rides alongside.
- **C5 — FACT is code-verified, the deterministic verdict stays authoritative.** A finding's
  `fact` field is populated ONLY from non-model evidence (trap `capture.jsonl` line, strace
  event from `observe.py`, resolved-IP record) and validated by code. The model may write
  only the `inference` field (hedged). The score still comes from deterministic
  `scoring.ts`/`verdict.py` over observed evidence — **the agent narrates, never scores**;
  on disagreement the deterministic verdict wins and the disagreement is logged.
- **H2/H3 — Vertex-direct is PRIMARY (drop OpenCode from V1).** An auditable, fixed
  tool-grammar loop we fully control beats an opaque third-party headless runner for the
  most safety-critical component. Trap capture (external, tamper-proof) is the source of
  truth for network facts, never the VM-authored report.

**V1 PROVABLE CORE (build this; defer the rest):**
1. `agent/knowledge_graph.py` — pure Python over the off-VM clone, no execution: file index
   + import edges + suspicion pre-rank. Reuses the static-scan pattern SET (shared, not
   forked — M3). Unit-tested. Proves "explore finds what the flagged-region scan missed."
2. `agent/explore_detonate.py` — Vertex-direct lead (+ ≤1 parallelizer) loop: repo content
   as untrusted data; fixed-grammar `detonate()` → `run-harness.sh run` as `runner` with
   pre-assert; time budget < cage + token budget; findings split `fact`(code-verified) vs
   `inference`(model). Unit-tested with a mocked model + mocked detonate.
3. Wire into `orchestrate.sh` between staging and RUN; map outcomes onto the existing
   `ScoringDynamicOutcome` → `scoring.ts`/`verdict.py` (deterministic stays authoritative).
4. Progressive checkpoint keyed by commit SHA (banked cost) + honest budget-exhausted
   fallback ("complex repo, here's everything found, flagged for review").
5. Survivable-watchdog enhancement (detect inside-death, finalize early) — strengthens
   isolation, kept in core.

**DEFERRED (real value, but each weakens isolation / adds surface / adds cost — not needed
to prove the moat):** OpenCode (H3), baked deps (H1), warm pool (M4), the continuous
external-monitor model (H5), continuous parallel static rescans for the whole VM lifetime
(L3), and the full A2A lead/peer quorum (M1 — keep peer review for PRIORITIZATION only, not
for promoting a finding to FACT). These are documented as roadmap, not V1.

The sections below are the original (pre-audit) fuller vision; read them through the lens of
the binding revisions above.

---

## The load-bearing constraint (why the brain is OUTSIDE)

The detonation VM has **no external IP, no service account, deny-all egress** — it can
reach ONLY the intra-VPC trap. That is the isolation. Therefore a Gemini-driven agent
**cannot run inside it** during RUN without breaking the absolute invariant *no real
packet ever leaves*. So:

- **AI brain = OUTSIDE the blast radius**, on the **orchestrator/controller** (the host
  running `orchestrate.sh`). That host already: holds the off-VM repo clone, has Vertex
  access (ADC / `GOOGLE_SERVICE_ACCOUNT_JSON`), and SSHes into both VMs over IAP. It is
  the natural home for the agent.
- **Hands = INSIDE the sealed VM**, reached only via intra-VPC SSH (`ssh_det`). The agent
  *explores* the clone locally (read/grep/knowledge-graph — no execution, no egress
  needed) and *detonates* by relaying a command into the sealed VM under the observer.
- This split IS the prompt's "external monitor sees the blast without being blasted" and
  the survivable inside/outside watchdog. No packet leaves the detonation VM; only SSH
  reaches in.

## Components

### 1. Knowledge graph (pre-process the clone — token saver)
`agent/build-knowledge-graph.py` (runs on the controller over the off-VM clone, BEFORE
detonation, no execution): file index, language/size, import/require/include edges
(regex + tree-sitter if available, ctags fallback), dependency manifest (package.json,
requirements.txt, go.mod, Cargo.toml, setup.py), install/build scripts, and a
**suspicion pre-rank** reusing `static-scan` heuristics (obfuscation, cred paths,
install-time net, dynamic-code, entropy). Output: `knowledge-graph.json`. Agents JUMP to
suspicious nodes instead of reading linearly.

### 2. OpenCode + the Gemini agent team (on the controller)
OpenCode (`opencode run`, headless) configured with the `@ai-sdk/google-vertex` provider
(project/location from env, ADC/service-account auth). Models:
- **Lead + 2 parallelizers** = `gemini-3.1-flash-lite` (thinking off) — explore disjoint
  angles concurrently (dependency/install path vs. source-tree+runtime). The lead owns
  the knowledge graph, the progressive report, exploration decisions, and validates
  findings.
- **Advisor** = `gemini-3.5-flash` (thinking on), called **sparingly** (cap ~ 3 per scan)
  on genuinely hard judgment ("is this blob malicious or just packed?"). Hand-built
  advisor pattern (the native advisor tool is Claude-only): Flash-Lite executes,
  escalates to 3.5-Flash on a hard decision with shared context, capped so a confused
  executor can't loop-burn the advisor. Returns a plan/correction/verdict; never drives,
  never writes user output.

If OpenCode integration proves brittle headless, the SAME orchestration is achievable by
calling Vertex directly (the `_shared/vertex.ts` seam already exists) with an
explore/detonate tool loop — OpenCode is the "hands" convenience, not a hard dependency.
The agent LOGIC (explore -> rank -> detonate -> cross-validate -> report) is what matters.

### 3. Tools the agent is given
- `read_file(path)`, `grep(pattern)`, `graph_query(node)` — over the local clone (read-only).
- `detonate(command, phase)` — relays `command` into the sealed VM via `ssh_det` under
  `observe.py`; returns stdout + the behavior delta (connects, cred reads, files dropped,
  CPU). This is the ONLY way code runs, and it runs INSIDE the sinkhole.
- `record_finding(finding)` — gated by the A2A pre-tool-use hook (below).

### 4. A2A coordination (pre-tool-use hook, cross-validation)
Before a finding is hardened into the report as FACT, the lead (and a peer) validate it
(`agent/validate-finding.py` hook). A single agent's "I found X / I'm making progress"
is never trusted alone — peer/lead confirmation is required. The lead can pull effort
toward a hot lead. This is the defense against one agent hallucinating progress.

### 5. Timeout model (inner consensus + outer hard cage)
- **Inner = consensus + progress**, not a clock. The team continues while the lead
  validates genuine, peer-confirmed convergence. A stuck/looping/self-deluding agent is
  caught by peers/lead and cut or redirected.
- **Outer = generous hard infra ceiling (~15 min)**: the VM's `--max-run-duration` DELETE
  (already present) is the malware-proof cage the AI cannot reach. The AI sets its working
  timeout WITHIN the cage.

### 6. No early exit (hard rule)
Never stop because an early finding looks "mildly dangerous" — a small threat in file 1
may be SEVERE in file 40. Explore fully so severity is REAL. Under-scored severity is a
cousin of the false "Safe" and is forbidden.

### 7. Never a wasted/blank report (hard rule)
- **Progress-aware extension**: a scan that's catching something (peer-validated
  convergence) extends itself; the timeout only stops *stuck* scans, never *winning* ones.
- **Continuous checkpointing** = progressive reporting: persist findings at EVERY
  checkpoint (`results/<name>-progress.json`), so cost is always banked.
- **Resume-don't-restart**: checkpointed by SHA; a scan that hits a wall resumes.
- If even the outer cage hits: result = persisted evidence + honest "exceptional/complex
  repo, here's everything found, high-danger signals confirmed, flagged for continued
  review" — evidence-backed, non-blank, never false-low, never falsely-clean.

### 8. Attribution discipline (credibility)
Cross-validation is STRICTEST on attribution. FACT vs INFERENCE always: "captured
endpoint IP resolves to [country]" (fact, cited) vs "resembles a known [actor] pattern"
(inference, hedged). Never let inference harden into stated fact; never a bare country.
Every claim tied to captured evidence (payload bytes, resolved IP, cred-read syscall).

### 9. Survivable watchdog (inside/outside split, strengthen existing)
The trap (outside) already survives the detonation VM dying. Strengthen it to **detect
inside-death** (agent/observer process gone, or SSH dead) and **finalize immediately**
(finalize sinkhole capture read-only, lock down, press the infra kill switch =
`--max-run-duration` DELETE) rather than waiting for the full timeout.

### 10. External AI monitor (outside the blast radius)
A `gemini-3.1-flash-lite` monitor on the controller continuously reads the trap's live
capture + observer stream while the in-VM detonation runs — sees the blast without being
blasted. Flags runtime-only appearances for the lead.

### 11. Continuous parallel static scanning (whole VM lifetime)
Beyond stage-1's flagged regions: re-run the static scanners over the VM's evolving
filesystem (dropped files, unpacked payloads, mutated code) in parallel the entire time
the VM is alive. Cheap, always-on; catches runtime-only artifacts.

## Efficiency (right-size: cheap, fast, parallel)
- **VM**: already `e2-small` (2-core) — measure; scale only if real builds need it. (Spec
  said don't use 8-core; we already don't.)
- **Warm VM pool**: keep 1-2 pre-booted detonation+trap VMs ready (`agent/warm-pool.sh`);
  a scan grabs a warm one (near-instant), uses it, destroys it, pool replenishes in the
  background. Removes cold boot (~15-30s) from the critical path.
- **Pre-vetted baked deps**: bake VERIFIED-secure common npm/pip deps into the golden
  image so builds pull locally. ONLY pre-vetted (a poisoned baked dep = disaster).
- **Parallel inside the VM**: static scanners + knowledge-graph build + dep install
  overlap, not sequential.
- **Concurrent scans**: multiple warm VMs -> parallel scans.

## Scoring integration
The dynamic outcome already feeds `_shared/scoring.ts` (`ScoringDynamicOutcome`:
credentialReadObserved, egressIntercepted, autoBuildSucceeded). The agentic findings map
onto the same forensic record (`forensics.py`) + verdict (`verdict.py`), so the deep score
is computed by the SAME formula. No bare "Safe"; honest `not_verified`.

## Live-proof plan (one real GCP run, synthetic fixture)
1. `exfil-c2` fixture: agent explores -> finds the buried `index.js` exfil to
   `exfil.evil-c2.example` (stage-1 might only flag a region; the agent reads the whole
   tree) -> detonates -> sinkhole captures the POST inert -> forensic record + dangerous
   verdict, with the captured host cited as FACT. VM deleted, trap deleted, no VMs left.
2. `benign-deps`: agent explores -> builds via proxy -> runs clean -> honest "no malicious
   behavior observed", never "Safe".
3. Re-measure auto-build success + escalation rate on the real runs.

## Build order (dependency-correct, incremental — each provable)
1. Knowledge graph (pure Python, unit-testable off the clone) — foundation.
2. The explore/detonate agent loop (Vertex-direct first for reliability; OpenCode layer
   on top) with checkpointing + the advisor pattern + A2A validation. Unit-test the loop
   logic with a mocked model.
3. Wire into `orchestrate.sh` between staging and RUN; map findings into `forensics.py`.
4. Survivable-watchdog + external-monitor + continuous-static enhancements.
5. Warm pool + baked deps (efficiency).
6. ONE live GCP proof on `exfil-c2` + `benign-deps`; re-measure rates.

## What stays exactly as-is (reuse, strengthen — never weaken)
Ephemeral VM, monitored sinkhole (no-real-packet-leaves), double containment (VPC deny +
in-VM DNAT), off-VM disposable payload analysis, forensic JSON, reset/delete every scan,
decoy canaries (no real creds), dead-man's-switch cleanup. All preserved; the agent layer
sits on top of this, it does not replace it.
