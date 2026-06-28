/**
 * Unit tests for the deterministic scoring engine (computeScore).
 *
 * Run: `deno test supabase/functions/_shared/scoring.test.ts`
 *
 * These assert the product-defining invariants:
 *   - a clean, established, well-starred repo lands 90+ ("Trusted" band)
 *   - obfuscation + credential access + a brand-new owner lands < 30 (dangerous)
 *   - the install-time-network penalty is applied and named
 *   - the breakdown deltas reproduce the score (citation trail is consistent)
 *   - reputation deltas are bounded and structurally separate from code deltas
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  computeEscalatedScore,
  computeScore,
  type ScoringEscalatedInputs,
  type ScoringInputs,
  type ScoringReputation,
  type ScoringRiskyItem,
  type ScoringStaticSignals,
} from "./scoring.ts";

// --- Fixtures ----------------------------------------------------------------

const CLEAN_SIGNALS: ScoringStaticSignals = {
  installHook: false,
  obfuscation: false,
  credAccess: false,
  network: false,
  embeddedSecret: false,
  typosquat: false,
};

const ESTABLISHED_REP: ScoringReputation = {
  established: true,
  ageDays: 3650,
  sentScore: 85,
  stars: 50_000,
};

const UNKNOWN_REP: ScoringReputation = {
  established: false,
  ageDays: -1,
  sentScore: -1,
  stars: 0,
};

function baseInputs(over: Partial<ScoringInputs> = {}): ScoringInputs {
  return {
    signals: { ...CLEAN_SIGNALS },
    installTimeNetwork: false,
    severityHint: "clean",
    risky: [],
    reputation: { ...UNKNOWN_REP },
    confidence: 0.9,
    escalated: false,
    ...over,
  };
}

/** The breakdown is the citation trail: baseline + sum(deltas), clamped, == score. */
function assertBreakdownConsistent(result: ReturnType<typeof computeScore>): void {
  // STRICT: with the clamp_floor/ceiling delta, the citation trail is now EXACT —
  // baseline + Σ(deltas) must equal score with NO re-clamp here (re-clamping would
  // mask the very clamp-boundary inconsistency this guard exists to catch).
  const sum = result.breakdown.reduce((acc, d) => acc + d.delta, result.baseline);
  assertEquals(result.score, sum, "score must equal baseline + Σdeltas exactly");
}

// --- Tests -------------------------------------------------------------------

Deno.test("clean + established + well-starred repo lands 90+ (Trusted band)", () => {
  // Arrange
  const inputs = baseInputs({
    reputation: { ...ESTABLISHED_REP },
    confidence: 0.95,
  });

  // Act
  const result = computeScore(inputs);

  // Assert
  assert(
    result.score >= 90,
    `expected >= 90 for a clean established repo, got ${result.score}`,
  );
  assertBreakdownConsistent(result);
});

Deno.test("obfuscation + credAccess + new owner lands < 30 (dangerous band)", () => {
  // Arrange
  const inputs = baseInputs({
    signals: { ...CLEAN_SIGNALS, obfuscation: true, credAccess: true },
    severityHint: "high",
    confidence: 0.5,
    escalated: true,
    reputation: { established: false, ageDays: 5, sentScore: 0, stars: 0 },
    risky: [
      { severity: "high", kind: "code" },
      { severity: "high", kind: "behavior" },
    ],
  });

  // Act
  const result = computeScore(inputs);

  // Assert
  assert(
    result.score < 30,
    `expected < 30 for obfuscation+credAccess+new-owner, got ${result.score}`,
  );
  assertBreakdownConsistent(result);
});

Deno.test("install-time network penalty is applied and named", () => {
  // Arrange
  const withNet = baseInputs({
    signals: { ...CLEAN_SIGNALS, installHook: true },
    installTimeNetwork: true,
  });
  const without = baseInputs({
    signals: { ...CLEAN_SIGNALS, installHook: true },
    installTimeNetwork: false,
  });

  // Act
  const a = computeScore(withNet);
  const b = computeScore(without);

  // Assert
  const factor = a.breakdown.find((d) => d.factor === "install_time_network");
  assert(factor, "install_time_network delta must be present");
  assert(factor.delta < 0, "install_time_network must be a penalty");
  assert(factor.group === "code", "install_time_network must be a code-group delta");
  assert(
    a.score < b.score,
    `install-time network must lower the score (${a.score} should be < ${b.score})`,
  );
  assertBreakdownConsistent(a);
});

Deno.test("breakdown deltas sum consistently with the score (citation trail)", () => {
  // Arrange — a mixed-signal repo so several deltas fire.
  const inputs = baseInputs({
    signals: {
      ...CLEAN_SIGNALS,
      installHook: true,
      network: true,
      typosquat: true,
    },
    reputation: { established: true, ageDays: 800, sentScore: 60, stars: 250 },
    confidence: 0.8,
    risky: [{ severity: "med", kind: "code" }],
  });

  // Act
  const result = computeScore(inputs);

  // Assert
  assertBreakdownConsistent(result);
  assert(result.breakdown.length > 0, "a signalful repo must produce deltas");
});

Deno.test("reputation deltas are bounded and separate from code deltas", () => {
  // Arrange — maximal positive reputation; reputation must NOT exceed its cap and
  // must NOT rescue dangerous code.
  const stellarRep: ScoringReputation = {
    established: true,
    ageDays: 5000,
    sentScore: 100,
    stars: 1_000_000,
  };
  const cleanInputs = baseInputs({ reputation: { ...stellarRep } });
  const dangerousInputs = baseInputs({
    signals: { ...CLEAN_SIGNALS, obfuscation: true, credAccess: true },
    reputation: { ...stellarRep },
    confidence: 0.4,
    escalated: true,
  });

  // Act
  const clean = computeScore(cleanInputs);
  const dangerous = computeScore(dangerousInputs);

  // Assert — reputation total is bounded.
  const repDeltas = clean.breakdown.filter((d) => d.group === "reputation");
  const repTotal = repDeltas.reduce((acc, d) => acc + d.delta, 0);
  assert(
    repTotal <= 14 && repTotal >= -18,
    `reputation total ${repTotal} must be within [-18, 14]`,
  );
  // Every reputation delta is tagged reputation; code deltas are tagged code.
  for (const d of repDeltas) assertEquals(d.group, "reputation");

  // Stellar reputation cannot rescue obfuscation + credential access.
  assert(
    dangerous.score < 30,
    `stellar reputation must NOT rescue dangerous code, got ${dangerous.score}`,
  );
  assertBreakdownConsistent(clean);
  assertBreakdownConsistent(dangerous);
});

Deno.test("dynamic credential read drives the score into the dangerous band", () => {
  // Arrange — even an otherwise quiet, established repo, if the sandbox OBSERVED
  // a credential read at runtime, must score dangerously.
  const inputs = baseInputs({
    reputation: { ...ESTABLISHED_REP },
    confidence: 0.9,
    escalated: true,
    dynamic: {
      credentialReadObserved: true,
      egressIntercepted: true,
      autoBuildSucceeded: true,
    },
  });

  // Act
  const result = computeScore(inputs);

  // Assert
  assert(
    result.score < 30,
    `observed runtime credential read + egress must be dangerous, got ${result.score}`,
  );
  const observed = result.breakdown.find(
    (d) => d.factor === "dynamic_credential_read",
  );
  assert(observed, "dynamic_credential_read delta must be present");
  assertBreakdownConsistent(result);
});

Deno.test("computeScore is deterministic for identical inputs", () => {
  // Arrange
  const inputs = baseInputs({
    signals: { ...CLEAN_SIGNALS, network: true, installHook: true },
    reputation: { established: true, ageDays: 1000, sentScore: 50, stars: 500 },
  });

  // Act
  const a = computeScore(inputs);
  const b = computeScore(inputs);

  // Assert
  assertEquals(a.score, b.score);
  assertEquals(a.breakdown.length, b.breakdown.length);
});

Deno.test("score clamps to 0 and the breakdown stays EXACT (clamp_floor delta)", () => {
  // Arrange — stack every heavy penalty so the raw sum falls well below 0.
  const inputs = baseInputs({
    signals: {
      installHook: true,
      obfuscation: true,
      credAccess: true,
      network: true,
      embeddedSecret: true,
      typosquat: true,
    },
    installTimeNetwork: true,
    severityHint: "high",
    confidence: 0.2,
    escalated: true,
    reputation: { established: false, ageDays: 1, sentScore: 0, stars: 0 },
    risky: [
      { severity: "high", kind: "code" },
      { severity: "high", kind: "behavior" },
      { severity: "high", kind: "code" },
    ],
    dynamic: {
      credentialReadObserved: true,
      egressIntercepted: true,
      autoBuildSucceeded: true,
    },
  });

  // Act
  const result = computeScore(inputs);

  // Assert — clamped to 0, a clamp_floor delta records the adjustment, trail exact.
  assertEquals(result.score, 0);
  assert(
    result.breakdown.find((d) => d.factor === "clamp_floor"),
    "a clamp_floor delta must record the clamp adjustment",
  );
  assertBreakdownConsistent(result);
});

Deno.test("a non-new, non-established owner yields no owner-standing delta", () => {
  // Arrange — a 200-day-old account not flagged established.
  const inputs = baseInputs({
    reputation: { established: false, ageDays: 200, sentScore: -1, stars: 0 },
  });

  // Act
  const result = computeScore(inputs);

  // Assert — none of the three owner-standing deltas fired.
  const ownerFactors = ["new_owner", "established_owner", "owner_age_unknown"];
  const fired = result.breakdown.filter((d) => ownerFactors.includes(d.factor));
  assertEquals(fired.length, 0, "no owner-standing delta for a mid-age unestablished owner");
  assertBreakdownConsistent(result);
});

Deno.test("auto-build bonus is suppressed when malicious runtime behavior was observed", () => {
  // Arrange — built cleanly BUT read a credential at runtime.
  const inputs = baseInputs({
    reputation: { ...ESTABLISHED_REP },
    escalated: true,
    dynamic: {
      credentialReadObserved: true,
      egressIntercepted: false,
      autoBuildSucceeded: true,
    },
  });

  // Act
  const result = computeScore(inputs);

  // Assert — the +4 line must NOT appear next to an observed credential read.
  assertEquals(
    result.breakdown.find((d) => d.factor === "dynamic_autobuild_ok"),
    undefined,
    "auto-build bonus must be suppressed alongside an observed credential read",
  );
  assertBreakdownConsistent(result);
});

Deno.test("unknown sentiment (-1) yields no delta, but 0 is a genuine negative read", () => {
  // Arrange — identical except sentScore.
  const unknown = baseInputs({
    reputation: { established: true, ageDays: 1000, sentScore: -1, stars: 0 },
  });
  const negative = baseInputs({
    reputation: { established: true, ageDays: 1000, sentScore: 0, stars: 0 },
  });

  // Act
  const u = computeScore(unknown);
  const n = computeScore(negative);

  // Assert — the sentinel distinguishes "no signal" from "bad signal".
  assertEquals(
    u.breakdown.find((d) => d.factor === "bad_sentiment"),
    undefined,
    "-1 sentiment is unknown → no sentiment delta",
  );
  assert(
    n.breakdown.find((d) => d.factor === "bad_sentiment"),
    "sentScore 0 is a genuine negative read → bad_sentiment delta",
  );
  assertBreakdownConsistent(u);
  assertBreakdownConsistent(n);
});

// --- Escalated (deep-run) score ---------------------------------------------

const CODE_HIGH: ScoringRiskyItem = { severity: "high", kind: "code" };
const NEW_OWNER_REP: ScoringReputation = {
  established: false,
  ageDays: 12,
  sentScore: -1,
  stars: 5,
};

function escInputs(over: Partial<ScoringEscalatedInputs> = {}): ScoringEscalatedInputs {
  return {
    dynamicScore: 80,
    exercised: true,
    caughtAttack: false,
    codeRisky: [],
    reputation: { ...UNKNOWN_REP },
    ...over,
  };
}

Deno.test("escalated: a CAUGHT ATTACK hard-caps the score (<=25) even with great reputation", () => {
  const r = computeEscalatedScore(
    escInputs({ dynamicScore: 90, caughtAttack: true, reputation: { ...ESTABLISHED_REP } }),
  );
  assert(r.score <= 25, `caught attack must cap <=25, got ${r.score}`);
  assert(
    r.breakdown.some((d) => d.factor === "caught_attack_ceiling"),
    "a caught attack records the ceiling delta",
  );
  assertBreakdownConsistent(r);
});

Deno.test("escalated: a CLEAN reputation cannot lift a caught attack out of the red", () => {
  const r = computeEscalatedScore(
    escInputs({ dynamicScore: 95, exercised: true, caughtAttack: true, reputation: { ...ESTABLISHED_REP } }),
  );
  assert(r.score < 30, `caught attack stays dangerous regardless of reputation, got ${r.score}`);
  // No POSITIVE reputation delta is applied when the run wasn't cleanly exercised.
  assert(
    !r.breakdown.some((d) => d.group === "reputation" && d.delta > 0),
    "positive reputation must NOT apply to a caught attack",
  );
});

Deno.test("escalated: a crash-on-startup (NOT exercised) cannot reach the clean bands (<=64)", () => {
  const r = computeEscalatedScore(
    escInputs({ dynamicScore: 64, exercised: false, reputation: { ...ESTABLISHED_REP } }),
  );
  assert(r.score <= 64, `a non-exercised run cannot reach the clean band, got ${r.score}`);
  // Reputation may only LOWER a non-exercised run; a great reputation cannot whitewash it.
  assert(
    !r.breakdown.some((d) => d.group === "reputation" && d.delta > 0),
    "positive reputation must NOT apply to a non-exercised run",
  );
  assertBreakdownConsistent(r);
});

Deno.test("escalated: a CLEAN, fully-exercised run earns a clean-band score; reputation may lift it", () => {
  const plain = computeEscalatedScore(escInputs({ dynamicScore: 80, exercised: true }));
  const repped = computeEscalatedScore(
    escInputs({ dynamicScore: 80, exercised: true, reputation: { ...ESTABLISHED_REP } }),
  );
  assert(repped.score >= plain.score, "a good reputation can lift a clean exercised run");
  assert(repped.score >= 80, `clean exercised + good rep should be clean-band, got ${repped.score}`);
  assertBreakdownConsistent(plain);
  assertBreakdownConsistent(repped);
});

Deno.test("escalated: running it clean LIFTS a statically-feared repo above static fear (the wedge)", () => {
  // Static read alone would condemn (high code finding + new owner). The run executes cleanly.
  const escalated = computeEscalatedScore(
    escInputs({
      dynamicScore: 82,
      exercised: true,
      caughtAttack: false,
      codeRisky: [CODE_HIGH],
      reputation: { ...NEW_OWNER_REP },
    }),
  );
  // The runtime is primary: a clean exercised run sits well above a static-only condemnation,
  // but the unresolved static finding + new owner still pull it down (bounded), never below the
  // residual. It must NOT be whitewashed to green, and NOT stay at the static floor.
  assert(escalated.score > 40, `clean run should lift above static fear, got ${escalated.score}`);
  assert(escalated.score < 82, `unresolved static + new owner still apply, got ${escalated.score}`);
  assert(
    escalated.breakdown.some((d) => d.factor === "static_residual" && d.delta < 0),
    "the unresolved static finding is a negative residual",
  );
  assertBreakdownConsistent(escalated);
});

Deno.test("escalated: clawdcursor-like (crash on startup, install concerns, new owner) lands red but coherent", () => {
  const r = computeEscalatedScore(
    escInputs({
      dynamicScore: 64, // verdict.py caps a crashed run at 64
      exercised: false, // built then crashed on startup
      caughtAttack: false,
      codeRisky: [CODE_HIGH], // undisclosed install-time scripts
      reputation: { ...NEW_OWNER_REP }, // new account
    }),
  );
  assert(r.score < 60, `a crashing, statically-flagged, new-owner repo is dangerous, got ${r.score}`);
  assert(r.score > 0, "but it is not a zero (no malice was observed)");
  // The runtime observation is the leading citation, never a stage-1 number bolted on.
  assertEquals(r.breakdown[0].factor, "runtime_observation");
  assertBreakdownConsistent(r);
});
