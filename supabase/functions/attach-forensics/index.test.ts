/**
 * Unit tests for the PHASE-AWARE runtime classification in attach-forensics/index.ts.
 *
 * Run: `deno test supabase/functions/attach-forensics/index.test.ts`
 *
 * These lock in the fix for a real false positive: a BUILD-phase dependency fetch to
 * a recognized software-distribution host (assemble-forensics.py's
 * `verdict.supply_chain_egress`) must NOT read as a confirmed attack (`caughtAttack`),
 * and the runtime summary must surface it as an honest supply-chain note rather than
 * an attack claim — while a genuine attack indicator (credential reads, or any host in
 * the ATTACK-GRADE `captured_network_intent` / `intended_destinations`) still drives
 * `caughtAttack` exactly as before.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildRuntimeSummary, extractRuntime } from "./index.ts";
import type { ScoringReputation } from "../_shared/scoring.ts";

const NEUTRAL_REP: ScoringReputation = {
  established: false,
  ageDays: -1,
  sentScore: -1,
  stars: 0,
};

/** A minimal forensic record, overridable per test — mirrors assemble-forensics.py's schema. */
function forensics(overrides: {
  autoBuildSucceeded?: boolean;
  ranWithoutCrash?: boolean;
  credReads?: number;
  capturedNetworkIntent?: string[];
  intendedDestinations?: string[];
  attackEgressIntercepted?: boolean;
  supplyChainEgress?: string[];
  dynamicScore?: number;
}): Record<string, unknown> {
  return {
    what_it_ran: {
      project_type: "node",
      auto_build_succeeded: overrides.autoBuildSucceeded ?? true,
      ran_without_crash: overrides.ranWithoutCrash ?? true,
    },
    network_intent: {
      intended_destinations: (overrides.intendedDestinations ?? []).map((host) => ({ host })),
    },
    in_vm_behavior: {
      high_value_credential_reads: overrides.credReads ?? 0,
    },
    verdict: {
      dynamic_score: overrides.dynamicScore ?? 100,
      captured_network_intent: overrides.capturedNetworkIntent ?? [],
      attack_egress_intercepted: overrides.attackEgressIntercepted ?? false,
      supply_chain_egress: overrides.supplyChainEgress ?? [],
    },
  };
}

// ── extractRuntime: the false positive this fix exists for ──────────────────────
Deno.test("extractRuntime: a pure supply-chain-caution record is NOT a caught attack", () => {
  const rt = extractRuntime(
    forensics({
      autoBuildSucceeded: false,
      attackEgressIntercepted: false,
      capturedNetworkIntent: [],
      intendedDestinations: [],
      supplyChainEgress: ["downloads.sourceforge.net"],
    }),
  );
  assertEquals(rt.caughtAttack, false, "a benign build-time distribution-host fetch must not be caughtAttack");
  assertEquals(rt.supplyChainHost, "downloads.sourceforge.net");
});

Deno.test("extractRuntime: an attack-grade captured_network_intent IS a caught attack", () => {
  const rt = extractRuntime(
    forensics({
      attackEgressIntercepted: true,
      capturedNetworkIntent: ["evil-c2.example"],
      supplyChainEgress: [],
    }),
  );
  assertEquals(rt.caughtAttack, true);
  assertEquals(rt.capturedHost, "evil-c2.example");
});

Deno.test("extractRuntime: a credential read is a caught attack regardless of supply_chain_egress", () => {
  const rt = extractRuntime(
    forensics({
      credReads: 2,
      attackEgressIntercepted: false,
      capturedNetworkIntent: [],
      supplyChainEgress: ["github.com"], // a co-occurring benign fetch must not mask the real signal
    }),
  );
  assertEquals(rt.caughtAttack, true, "a real credential read must never be masked by an unrelated supply-chain fetch");
});

Deno.test("extractRuntime: intended_destinations alone (legacy field) still drives caughtAttack", () => {
  // Defensive fallback: even if attack_egress_intercepted/captured_network_intent were
  // somehow missing, a non-empty intended_destinations must still fail toward "attack".
  const rt = extractRuntime(
    forensics({
      attackEgressIntercepted: false,
      capturedNetworkIntent: [],
      intendedDestinations: ["evil-c2.example"],
      supplyChainEgress: [],
    }),
  );
  assertEquals(rt.caughtAttack, true);
});

// ── buildRuntimeSummary: the honest supply-chain note, and no regressions ────────
Deno.test("buildRuntimeSummary: supply-chain-only run gets an honest note, not an attack claim", () => {
  const rt = extractRuntime(
    forensics({
      autoBuildSucceeded: false,
      attackEgressIntercepted: false,
      supplyChainEgress: ["downloads.sourceforge.net"],
    }),
  );
  const summary = buildRuntimeSummary("react", "react", rt, NEUTRAL_REP, null);
  assert(
    summary.includes("did not build to a runnable state"),
    `expected the honest build-failure sentence, got: ${summary}`,
  );
  assert(
    summary.includes("downloads.sourceforge.net") && summary.toLowerCase().includes("supply-chain"),
    `expected an honest supply-chain note naming the host, got: ${summary}`,
  );
  assert(
    !summary.includes("We caught it"),
    `a benign supply-chain fetch must never trigger the caught-attack phrasing, got: ${summary}`,
  );
});

Deno.test("buildRuntimeSummary: a real caught attack is unaffected by the supply-chain branch", () => {
  const rt = extractRuntime(
    forensics({
      attackEgressIntercepted: true,
      capturedNetworkIntent: ["evil-c2.example"],
    }),
  );
  const summary = buildRuntimeSummary("owner", "repo", rt, NEUTRAL_REP, null);
  assert(
    summary.includes("We caught it") && summary.includes("evil-c2.example"),
    `expected the existing caught-attack framing, got: ${summary}`,
  );
});

Deno.test("buildRuntimeSummary: a plain clean run has no supply-chain text bleeding in", () => {
  const rt = extractRuntime(forensics({}));
  const summary = buildRuntimeSummary("owner", "repo", rt, NEUTRAL_REP, null);
  assertEquals(
    summary,
    "We ran owner/repo, a node project, in an isolated sandbox. It built and ran cleanly. " +
      "We observed no malicious behavior, credential access, or outbound exfiltration.",
  );
});
