/**
 * Deterministic safety-score engine — the ONE place the 0-100 number is decided.
 *
 * WHY THIS EXISTS (CLAUDE.md / PRD §4):
 *   The read model READS the flagged code and REPORTS structured signals
 *   (static-scan flags, per-finding `risky` items, reputation facts, a
 *   confidence). It must NOT be the thing that hands us a score — a model that
 *   self-reports "82/100" is guessing, and a confident wrong number is the one
 *   outcome that can kill this product. Instead the model FEEDS this function,
 *   and the SCORE is computed here by a fixed, auditable formula. Every point
 *   gained or lost is a NAMED, EXPLAINABLE delta, so a report can cite exactly
 *   why a repo is 18/100 ("install-time exfil -40, new owner -12, ...").
 *
 * STRUCTURAL RAIL (CLAUDE.md): code/behavior signals and reputation signals are
 *   kept conceptually SEPARATE. They are scored by two separate delta groups
 *   (`group: "code"` vs `group: "reputation"`), reputation is weighted LIGHTER
 *   and BOUNDED, and the breakdown preserves which group each delta came from.
 *   The number is driven by what the code does; reputation only nudges it.
 *
 * This module is PURE: deterministic, no randomness, no I/O, no Deno/Node deps.
 * The same formula serves the fast path now and the deep (dynamic sandbox) path
 * later — `dynamic` inputs are optional and only apply when a real run happened.
 */

// --- Public types ------------------------------------------------------------

/** Severity of a single model `risky` finding (mirrors lib/types.ts). */
export type ScoringSeverity = "high" | "med" | "low";

/** What kind of signal a finding is (mirrors lib/types.ts RiskKind). */
export type ScoringRiskKind = "behavior" | "code" | "rep";

/** The raw static-scan signal booleans (mirrors StaticSignals in static-scan.ts). */
export interface ScoringStaticSignals {
  installHook: boolean;
  obfuscation: boolean;
  credAccess: boolean;
  network: boolean;
  embeddedSecret: boolean;
  typosquat: boolean;
}

/** A single model finding fed into scoring (subset of the model `risky` item). */
export interface ScoringRiskyItem {
  severity: ScoringSeverity;
  kind: ScoringRiskKind;
}

/** Reputation facts — kept SEPARATE from code/behavior, weighted lighter. */
export interface ScoringReputation {
  /** Owner account is "established" (old enough + enough repos) per github.ts. */
  established: boolean;
  /** Owner account age in days; -1 when unknown. */
  ageDays: number;
  /** Community sentiment score 0-100, or -1 when UNKNOWN (model returned none).
   * The sentinel keeps "no signal" (-1 → no delta) distinct from a genuinely
   * negative read (0 → bad-sentiment penalty), mirroring `ageDays = -1`. */
  sentScore: number;
  /** Repository star count. */
  stars: number;
}

/**
 * Optional dynamic/forensic outcome — present ONLY when the deep sandbox path
 * actually ran the repo. When present these are the STRONGEST code/behavior
 * signals (observed, not inferred), so the same formula serves the deep path.
 */
export interface ScoringDynamicOutcome {
  /** A high-value credential (ssh key, aws creds, .npmrc) was read at runtime. */
  credentialReadObserved: boolean;
  /** The sandbox intercepted real outbound egress the code attempted. */
  egressIntercepted: boolean;
  /** The repo cloned, built and ran unattended (a healthiness signal). */
  autoBuildSucceeded: boolean;
}

/** The full set of signals available at scoring time. */
export interface ScoringInputs {
  /** Raw static-scan booleans (code-side). */
  signals: ScoringStaticSignals;
  /** True when network activity was found in an install-time context (code-side). */
  installTimeNetwork: boolean;
  /** Overall static-scan severity hint (code-side). */
  severityHint: "clean" | "low" | "medium" | "high";
  /** The model's individual findings (code/behavior/rep-tagged). */
  risky: ScoringRiskyItem[];
  /** Reputation facts (owner/community) — separate, lighter group. */
  reputation: ScoringReputation;
  /** The model's self-reported read confidence 0-1. */
  confidence: number;
  /** Whether the escalation gate decided to escalate this repo. */
  escalated: boolean;
  /** Dynamic-run outcome, present only when the deep path actually ran. */
  dynamic?: ScoringDynamicOutcome;
}

/** Which conceptual group a delta belongs to (the structural-separation rail). */
export type ScoringGroup = "code" | "reputation";

/** A single named, explainable score delta — the citation trail. */
export interface ScoreDelta {
  /** Stable factor key, e.g. "obfuscation" or "new_owner". */
  factor: string;
  /** Signed point change applied to the running score. */
  delta: number;
  /** Human-readable reason shown in the report citation. */
  detail: string;
  /** Code/behavior vs reputation — keeps the two structurally separate. */
  group: ScoringGroup;
}

/** The computed score plus its full citation trail. */
export interface ScoreResult {
  /** Final clamped score 0-100. */
  score: number;
  /** The baseline the deltas were applied to (documents the starting point). */
  baseline: number;
  /** Every applied delta, in application order — the citation trail. */
  breakdown: ScoreDelta[];
}

// --- Weight table ------------------------------------------------------------
//
// All weights live here, each documented with the REASON it has that magnitude.
// Code/behavior penalties dominate; reputation deltas are smaller and bounded.
// The baseline starts in the "Likely safe" band, NOT "Trusted": a repo earns the
// top band only by being clean AND having a positive reputation, and any real
// code signal pulls it down hard. This encodes the rail that we never hand out a
// confident high score for free.

/** Neutral starting point — mid "Likely safe" band. A repo with zero signals and
 * unknown reputation lands here, i.e. "nothing alarming, but not vouched-for". */
const BASELINE = 82;

// -- Code/behavior penalties (heaviest — the score is driven by what code does) --

/** Obfuscation (eval-of-decoded-payload, long base64 blobs). The single clearest
 * malware tell in package-ecosystem attacks; alone it must reach the dangerous
 * band, so it is the largest static penalty. */
const W_OBFUSCATION = -42;

/** Credential-path access (~/.ssh, .aws/credentials, .npmrc, bulk env read).
 * Reading secrets is the payload of most supply-chain attacks; near-maximal. */
const W_CRED_ACCESS = -40;

/** Install-time network (curl/wget/fetch wired into a pre/post-install hook).
 * The classic "runs on npm install before you ever import it" exfil vector;
 * combined with the install-hook penalty this lands a repo deep in the red. */
const W_INSTALL_TIME_NETWORK = -40;

/** An embedded secret/private key committed in the source. Either leaked creds
 * or a planted key for later use; a serious code-hygiene + risk signal. */
const W_EMBEDDED_SECRET = -22;

/** A typosquat hint — package name shadows a popular package within edit-
 * distance 2. Strong intent signal (impersonation) but not proof of payload. */
const W_TYPOSQUAT = -20;

/** A plain install hook (pre/post-install script) with no network. Install
 * scripts are legitimate but are the surface attacks hide in — a mild penalty. */
const W_INSTALL_HOOK = -8;

/** Generic network capability in the code (fetch/child_process/raw IP URL) that
 * is NOT install-time. Normal for most apps; small, lest every real app suffers. */
const W_NETWORK = -6;

// -- Per-finding penalties for the model's `risky[]` items (code/behavior only) --
// The model surfaces specific findings; each code/behavior finding deducts by
// severity. Reputation-kind ('rep') findings are deliberately NOT scored here —
// reputation is handled by the separate reputation group below, so a finding the
// model tagged 'rep' never double-counts against the code score.

/** A high-severity code/behavior finding from the model's read. */
const W_RISKY_HIGH = -14;
/** A medium-severity code/behavior finding. */
const W_RISKY_MED = -7;
/** A low-severity code/behavior finding. */
const W_RISKY_LOW = -3;

/** Cap on total per-finding `risky[]` penalty so a model that emits many small
 * findings can't drive the score arbitrarily negative beyond the named static
 * penalties — the static signals remain the dominant, auditable drivers. */
const RISKY_PENALTY_FLOOR = -36;

// -- Confidence / escalation (code-side — about how sure the static read is) --

/** Low read-confidence penalty. When the model couldn't confidently clear the
 * repo from the static read, we withhold points rather than guess "safe". This
 * is the numeric expression of the never-bare-"Safe" rail. */
const W_LOW_CONFIDENCE = -10;
/** Confidence below this is treated as "could not clear from static read". Kept
 * equal to the orchestrator's escalation threshold so the two agree. */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** Escalation reservation: when the gate escalated but no dynamic run has yet
 * confirmed clean, hold back points — the repo is unresolved, not cleared. Small,
 * because the specific signals that caused escalation already carry their own
 * penalties; this only prevents an escalated-but-otherwise-quiet repo scoring high. */
const W_ESCALATION_PENDING = -6;

// -- Dynamic/forensic outcome (deep path only — OBSERVED behavior, strongest) --

/** A credential read OBSERVED at runtime in the sandbox. Observed beats inferred:
 * this is proof of malicious behavior, so it is the single largest penalty. */
const W_DYN_CRED_READ = -55;
/** Real outbound egress the code attempted, intercepted by the sandbox. Proof of
 * exfil/C2 intent actually executed; near-maximal. */
const W_DYN_EGRESS = -45;
/** The repo cloned, built and ran unattended with no malicious behavior observed.
 * A small POSITIVE: it is healthier than a repo we could not even build. Stays
 * small so a clean build can never paper over a code/behavior penalty above. */
const W_DYN_AUTOBUILD_OK = 4;

// -- Reputation group (SEPARATE, lighter, BOUNDED — only nudges the number) --
// These never dominate: their total is clamped to [REP_MIN, REP_MAX] so a great
// reputation cannot rescue dangerous code, and a poor reputation cannot sink a
// clean repo on its own. This is the structural rail made numeric.

/** Established owner (account >1yr + multiple public repos). A real positive but
 * bounded — an established owner can still ship a compromised release. */
const W_REP_ESTABLISHED = 8;
/** Brand-new owner account (< NEW_OWNER_AGE_DAYS). New owners are over-represented
 * in throwaway-attack accounts, so a modest reputational penalty. */
const W_REP_NEW_OWNER = -12;
/** Owner age is unknown (lookup degraded). Withhold the established bonus and
 * apply a tiny uncertainty penalty rather than assuming good standing. */
const W_REP_UNKNOWN_OWNER = -3;
/** Many stars (>= STARS_STRONG). Community vetting signal; small and bounded. */
const W_REP_MANY_STARS = 6;
/** Some stars (>= STARS_SOME). A weaker community signal. */
const W_REP_SOME_STARS = 3;
/** Positive community sentiment (sentScore >= SENT_POSITIVE). Small nudge. */
const W_REP_GOOD_SENTIMENT = 4;
/** Negative community sentiment (sentScore <= SENT_NEGATIVE). Small penalty. */
const W_REP_BAD_SENTIMENT = -5;

/** Thresholds for the bounded reputation signals. */
const NEW_OWNER_AGE_DAYS = 60;
const STARS_STRONG = 1000;
const STARS_SOME = 100;
const SENT_POSITIVE = 70;
const SENT_NEGATIVE = 35;

/** Hard bounds on the TOTAL reputation contribution. Reputation may move the
 * score by at most +REP_MAX / REP_MIN points — it can nudge, never decide. */
const REP_MAX = 14;
const REP_MIN = -18;

// --- Pure helpers ------------------------------------------------------------

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function severityWeight(sev: ScoringSeverity): number {
  if (sev === "high") return W_RISKY_HIGH;
  if (sev === "med") return W_RISKY_MED;
  return W_RISKY_LOW;
}

/** Build the code/behavior delta list from static signals + model findings +
 * confidence/escalation + (optional) dynamic outcome. Immutable — returns a new
 * array; never mutates inputs. */
function codeDeltas(inputs: ScoringInputs): ScoreDelta[] {
  const deltas: ScoreDelta[] = [];
  const s = inputs.signals;

  if (s.obfuscation) {
    deltas.push({
      factor: "obfuscation",
      delta: W_OBFUSCATION,
      detail: "Obfuscated/encoded payload detected in source (eval-of-decoded or long base64 blob).",
      group: "code",
    });
  }
  if (s.credAccess) {
    deltas.push({
      factor: "credential_access",
      delta: W_CRED_ACCESS,
      detail: "Code references credential paths (SSH keys, cloud credentials, .npmrc, or bulk env read).",
      group: "code",
    });
  }
  if (inputs.installTimeNetwork) {
    deltas.push({
      factor: "install_time_network",
      delta: W_INSTALL_TIME_NETWORK,
      detail: "Network/shell activity wired into an install-time hook (runs on install, before import).",
      group: "code",
    });
  }
  if (s.embeddedSecret) {
    deltas.push({
      factor: "embedded_secret",
      delta: W_EMBEDDED_SECRET,
      detail: "An embedded secret or private key is committed in the source.",
      group: "code",
    });
  }
  if (s.typosquat) {
    deltas.push({
      factor: "typosquat",
      delta: W_TYPOSQUAT,
      detail: "Package name closely shadows a popular package (typosquat / impersonation hint).",
      group: "code",
    });
  }
  // Install hook penalty applies only for the hook itself; the heavier
  // install-time-network penalty above is separate and additive.
  if (s.installHook) {
    deltas.push({
      factor: "install_hook",
      delta: W_INSTALL_HOOK,
      detail: "A pre/post-install script is present (the surface install-time attacks hide in).",
      group: "code",
    });
  }
  // Generic (non-install-time) network capability. Only penalize when it is NOT
  // already counted as install-time network, to avoid double-charging.
  if (s.network && !inputs.installTimeNetwork) {
    deltas.push({
      factor: "network",
      delta: W_NETWORK,
      detail: "Code has outbound network capability (fetch / child_process / hardcoded IP URL).",
      group: "code",
    });
  }

  // Per-finding penalties for the model's code/behavior `risky` items. Reputation
  // ('rep') findings are excluded here — they belong to the reputation group.
  const codeFindings = inputs.risky.filter(
    (r) => r.kind === "code" || r.kind === "behavior",
  );
  let riskySum = 0;
  for (const r of codeFindings) riskySum += severityWeight(r.severity);
  if (riskySum < 0) {
    const applied = Math.max(riskySum, RISKY_PENALTY_FLOOR);
    deltas.push({
      factor: "model_findings",
      delta: applied,
      detail: `${codeFindings.length} code/behavior finding(s) reported by the read model${
        riskySum < RISKY_PENALTY_FLOOR ? " (capped)" : ""
      }.`,
      group: "code",
    });
  }

  // Low read-confidence: withhold points rather than guess "safe".
  if (inputs.confidence < LOW_CONFIDENCE_THRESHOLD) {
    deltas.push({
      factor: "low_confidence",
      delta: W_LOW_CONFIDENCE,
      detail: `Read confidence ${inputs.confidence.toFixed(2)} is below ${LOW_CONFIDENCE_THRESHOLD}; the static read could not confidently clear the repo.`,
      group: "code",
    });
  }

  // Escalation reservation — only when escalated AND no dynamic run has resolved
  // it yet. A completed dynamic run supplies its own (stronger) deltas below.
  if (inputs.escalated && !inputs.dynamic) {
    deltas.push({
      factor: "escalation_pending",
      delta: W_ESCALATION_PENDING,
      detail: "Escalated to the dynamic sandbox; not yet cleared by a runtime observation.",
      group: "code",
    });
  }

  // Dynamic/forensic outcome — observed behavior from a real sandbox run.
  if (inputs.dynamic) {
    const d = inputs.dynamic;
    if (d.credentialReadObserved) {
      deltas.push({
        factor: "dynamic_credential_read",
        delta: W_DYN_CRED_READ,
        detail: "The sandbox OBSERVED the code reading a high-value credential at runtime.",
        group: "code",
      });
    }
    if (d.egressIntercepted) {
      deltas.push({
        factor: "dynamic_egress",
        delta: W_DYN_EGRESS,
        detail: "The sandbox intercepted real outbound egress the code attempted at runtime.",
        group: "code",
      });
    }
    // Credit a clean unattended build ONLY when nothing malicious was observed —
    // crediting a repo that read credentials or attempted egress for "building
    // cleanly" would be an absurd line in the citation ("+4 built fine, also
    // exfiltrated your SSH key").
    if (
      d.autoBuildSucceeded && !d.credentialReadObserved && !d.egressIntercepted
    ) {
      deltas.push({
        factor: "dynamic_autobuild_ok",
        delta: W_DYN_AUTOBUILD_OK,
        detail: "The repo cloned, built and ran unattended with no malicious behavior observed.",
        group: "code",
      });
    }
  }

  return deltas;
}

/** Build the reputation delta list, then CLAMP its total to [REP_MIN, REP_MAX] so
 * reputation can only nudge the score. Returns deltas whose sum is bounded — if
 * the clamp bit, a synthetic "reputation_cap" delta records the adjustment so the
 * breakdown stays internally consistent (its deltas always sum to the applied
 * total). Immutable. */
function reputationDeltas(rep: ScoringReputation): ScoreDelta[] {
  const raw: ScoreDelta[] = [];

  // Owner standing.
  if (rep.ageDays < 0) {
    raw.push({
      factor: "owner_age_unknown",
      delta: W_REP_UNKNOWN_OWNER,
      detail: "Owner account age could not be determined; standing is unverified.",
      group: "reputation",
    });
  } else if (rep.ageDays < NEW_OWNER_AGE_DAYS) {
    raw.push({
      factor: "new_owner",
      delta: W_REP_NEW_OWNER,
      detail: `Owner account is new (${rep.ageDays} days old); new accounts are over-represented in throwaway attacks.`,
      group: "reputation",
    });
  } else if (rep.established) {
    raw.push({
      factor: "established_owner",
      delta: W_REP_ESTABLISHED,
      detail: "Owner account is established (older than a year with multiple public repos).",
      group: "reputation",
    });
  }

  // Community stars.
  if (rep.stars >= STARS_STRONG) {
    raw.push({
      factor: "many_stars",
      delta: W_REP_MANY_STARS,
      detail: `Strong community signal (${rep.stars.toLocaleString("en-US")} stars).`,
      group: "reputation",
    });
  } else if (rep.stars >= STARS_SOME) {
    raw.push({
      factor: "some_stars",
      delta: W_REP_SOME_STARS,
      detail: `Some community signal (${rep.stars.toLocaleString("en-US")} stars).`,
      group: "reputation",
    });
  }

  // Sentiment.
  if (rep.sentScore >= SENT_POSITIVE) {
    raw.push({
      factor: "good_sentiment",
      delta: W_REP_GOOD_SENTIMENT,
      detail: `Positive community sentiment (${rep.sentScore}/100).`,
      group: "reputation",
    });
  } else if (rep.sentScore >= 0 && rep.sentScore <= SENT_NEGATIVE) {
    raw.push({
      factor: "bad_sentiment",
      delta: W_REP_BAD_SENTIMENT,
      detail: `Negative community sentiment (${rep.sentScore}/100).`,
      group: "reputation",
    });
  }

  const rawTotal = raw.reduce((sum, d) => sum + d.delta, 0);
  const bounded = Math.min(REP_MAX, Math.max(REP_MIN, rawTotal));
  if (bounded === rawTotal) return raw;

  // The bound bit — record the correction so the breakdown stays consistent.
  return [
    ...raw,
    {
      factor: "reputation_cap",
      delta: bounded - rawTotal,
      detail: `Reputation contribution capped to ${
        bounded >= 0 ? "+" : ""
      }${bounded} (reputation may only nudge the score, never decide it).`,
      group: "reputation",
    },
  ];
}

// --- Public API --------------------------------------------------------------

/**
 * Compute the authoritative safety score from weighted, named signals.
 *
 * The model FEEDS the signals; this function DECIDES the number. Code/behavior
 * deltas drive the score; reputation deltas (a separate, bounded group) only
 * nudge it. The returned `breakdown` is the full citation trail and its deltas
 * applied to `baseline` reproduce `score` exactly (modulo the final 0-100 clamp).
 *
 * Pure and deterministic: identical inputs always yield an identical result.
 */
export function computeScore(inputs: ScoringInputs): ScoreResult {
  const code = codeDeltas(inputs);
  const reputation = reputationDeltas(inputs.reputation);
  const breakdown: ScoreDelta[] = [...code, ...reputation];

  const rawSum = breakdown.reduce((acc, d) => acc + d.delta, BASELINE);
  const score = clampScore(rawSum);
  // Keep the citation trail EXACT: if the 0-100 clamp moved the number, record the
  // adjustment as its own delta so `baseline + Σ(breakdown deltas) === score`
  // holds unconditionally (same technique as `reputation_cap`). Deltas are all
  // integers, so rawSum is already integral; rounding is belt-and-suspenders.
  const rounded = Math.round(rawSum);
  if (score !== rounded) {
    breakdown.push({
      factor: score <= 0 ? "clamp_floor" : "clamp_ceiling",
      delta: score - rounded,
      detail: `Raw score ${rounded} clamped to the ${
        score <= 0 ? "0" : "100"
      } bound (a safety score is always 0-100).`,
      group: "code",
    });
  }
  return { score, baseline: BASELINE, breakdown };
}

// --- Escalated (deep-run) score ----------------------------------------------
//
// When a repo escalates and the sandbox ACTUALLY RUNS it, the escalation OWNS the
// report: the score is recomputed with the RUNTIME observation as the PRIMARY
// term, not the stage-1 static/reputation number with forensics bolted on. The
// runtime is the strongest signal (we ran it), so it leads; the static read and
// reputation become bounded adjustments. Exercise-gating is the rail that stops a
// run which never really executed (crash on startup, build failure) from being
// whitewashed into a clean band — a crash is limited evidence AND a quality
// signal, so its score is capped. This is score policy, not a verbal hedge.

/** A caught attack (observed egress / credential read / captured C2 host) hard-caps
 * the score — the runtime dominates and the verdict must read dangerous. Sits below
 * the "Malicious" band split so the band and the narrative always agree. */
const ESC_CAUGHT_ATTACK_CEILING = 25;
/** A run that did not BOTH build and run cleanly (crashed/failed to build) cannot
 * reach the clean bands: we saw less, and software that crashes on startup is itself
 * a trust signal. Matches verdict.py's dynamic-score cap for non-exercised runs. */
const ESC_INCOMPLETE_RUN_CEILING = 64;
/** Floor on the residual static concern (NEGATIVE-only): unresolved static findings
 * the short run didn't exercise can lower the score, bounded, but never raise it. */
const ESC_STATIC_RESIDUAL_FLOOR = -18;

/** Inputs for the escalated (deep-run) score. The edge function extracts the
 * runtime primitives from the forensic record and supplies the stage-1 code
 * findings + reputation as the bounded adjustments. Pure: no forensic-JSON
 * coupling here, so this stays deterministic + unit-testable. */
export interface ScoringEscalatedInputs {
  /** The runtime assessment from verdict.py (`forensics.verdict.dynamic_score`). */
  dynamicScore: number;
  /** The repo BOTH built and ran without crashing (auto_build_succeeded && ran_without_crash). */
  exercised: boolean;
  /** The run was caught attempting egress / credential theft / reached a captured C2 host. */
  caughtAttack: boolean;
  /** Stage-1 code/behavior findings — residual static concern the run did not resolve. */
  codeRisky: ScoringRiskyItem[];
  /** Reputation facts (owner/community) — same bounded, separate group as the fast path. */
  reputation: ScoringReputation;
}

/**
 * Compute the escalated score: runtime-PRIMARY, with bounded static + reputation
 * adjustments and exercise-gating ceilings. Returns the same `ScoreResult` shape
 * (a full citation trail whose deltas sum from `baseline` to `score`), so the
 * escalated report's "Score" chapter is as auditable as the fast path's.
 *
 * Pure and deterministic — identical inputs always yield an identical result, so
 * a fresh deep run and a later cached view of the same commit score identically.
 */
export function computeEscalatedScore(inputs: ScoringEscalatedInputs): ScoreResult {
  const dyn = clampScore(inputs.dynamicScore);
  // A caught attack is never treated as a "clean exercised" run, even if it built+ran.
  const cleanExercised = inputs.exercised && !inputs.caughtAttack;
  const breakdown: ScoreDelta[] = [];

  // PRIMARY term: the score starts from what running it actually showed.
  breakdown.push({
    factor: "runtime_observation",
    delta: dyn,
    detail: `The sandbox run scored ${dyn}/100 from observed runtime behavior — the primary signal.`,
    group: "code",
  });

  // Residual static concern (NEGATIVE-only, bounded): code/behavior the static read
  // flagged that the run did not exercise. Running clean does not erase a real
  // undisclosed install hook; static fear can never RAISE a score the run earned.
  const codeRisky = inputs.codeRisky.filter((r) => r.kind === "code" || r.kind === "behavior");
  let staticSum = 0;
  for (const r of codeRisky) staticSum += severityWeight(r.severity);
  const staticAdj = Math.max(ESC_STATIC_RESIDUAL_FLOOR, Math.min(0, staticSum));
  if (staticAdj < 0) {
    breakdown.push({
      factor: "static_residual",
      delta: staticAdj,
      detail: `${codeRisky.length} static code/behavior concern(s) the run did not exercise (bounded residual risk).`,
      group: "code",
    });
  }

  // Reputation — bounded nudge, structurally separate. When the run did NOT cleanly
  // exercise the code (a caught attack, a crash, or a build failure), reputation may
  // only LOWER: a good reputation cannot lift a score the run did not earn.
  const repRaw = reputationDeltas(inputs.reputation);
  if (cleanExercised) {
    breakdown.push(...repRaw);
  } else {
    breakdown.push(...repRaw.filter((d) => d.delta < 0));
  }

  let rawSum = breakdown.reduce((s, d) => s + d.delta, 0);

  // Exercise-gating ceilings (score policy, not a hedge).
  const ceiling = inputs.caughtAttack
    ? ESC_CAUGHT_ATTACK_CEILING
    : !inputs.exercised
      ? ESC_INCOMPLETE_RUN_CEILING
      : 100;
  if (rawSum > ceiling) {
    breakdown.push({
      factor: inputs.caughtAttack ? "caught_attack_ceiling" : "incomplete_run_ceiling",
      delta: ceiling - rawSum,
      detail: inputs.caughtAttack
        ? `Caught attempting credential access or outbound exfiltration in the sandbox; the score is capped at ${ceiling}.`
        : `The repo did not both build and run cleanly in the sandbox; the score is capped at ${ceiling}.`,
      group: "code",
    });
    rawSum = ceiling;
  }

  const score = clampScore(rawSum);
  const rounded = Math.round(rawSum);
  if (score !== rounded) {
    breakdown.push({
      factor: score <= 0 ? "clamp_floor" : "clamp_ceiling",
      delta: score - rounded,
      detail: `Raw score ${rounded} clamped to the ${score <= 0 ? "0" : "100"} bound (a safety score is always 0-100).`,
      group: "code",
    });
  }
  // baseline 0: the runtime observation is itself the first delta, so
  // `baseline + Σ(breakdown deltas) === score` holds exactly.
  return { score, baseline: 0, breakdown };
}
