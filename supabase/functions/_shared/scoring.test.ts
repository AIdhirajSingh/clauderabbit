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
  computeScore,
  type ScoringInputs,
  type ScoringReputation,
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
  sentScore: 0,
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
  const sum = result.breakdown.reduce((acc, d) => acc + d.delta, result.baseline);
  const clamped = Math.min(100, Math.max(0, Math.round(sum)));
  assertEquals(result.score, clamped, "score must equal clamped(baseline + Σdeltas)");
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
