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
 *
 * extractRuntime is ASYNC: assemble-forensics.py's own host-recognition list is static
 * and finite (the same limitation the fast-path classifier had), so an attack-grade
 * host it didn't recognize gets one live HTTPS check here — see _shared/host-verify.ts,
 * already proven for the fast path. `fetch` is mocked below so these tests stay fast
 * and deterministic.
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

function withMockedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

/** Every host in this test file that has no legitimate-fetch mock is "unreachable". */
const UNREACHABLE_FETCH = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as typeof fetch;

/** A minimal forensic record, overridable per test — mirrors assemble-forensics.py's schema. */
function forensics(overrides: {
  autoBuildSucceeded?: boolean;
  ranWithoutCrash?: boolean;
  credReads?: number;
  capturedNetworkIntent?: string[];
  intendedDestinations?: string[];
  attackEgressIntercepted?: boolean;
  supplyChainEgress?: string[];
  buildPhaseUnrecognized?: string[];
  dynamicScore?: number;
  exfilHosts?: string[];
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
    payload_analysis: {
      decoded_payloads: (overrides.exfilHosts ?? []).map((host) => ({
        host,
        kind: "credential_exfil",
      })),
    },
    verdict: {
      dynamic_score: overrides.dynamicScore ?? 100,
      captured_network_intent: overrides.capturedNetworkIntent ?? [],
      attack_egress_intercepted: overrides.attackEgressIntercepted ?? false,
      supply_chain_egress: overrides.supplyChainEgress ?? [],
      build_phase_unrecognized_egress: overrides.buildPhaseUnrecognized ?? [],
    },
  };
}

// ── extractRuntime: the false positive this fix exists for ──────────────────────
Deno.test("extractRuntime: a pure supply-chain-caution record is NOT a caught attack", async () => {
  const rt = await extractRuntime(
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

Deno.test("extractRuntime: an attack-grade captured_network_intent IS a caught attack", async () => {
  const rt = await withMockedFetch(UNREACHABLE_FETCH, () =>
    extractRuntime(
      forensics({
        attackEgressIntercepted: true,
        capturedNetworkIntent: ["evil-c2.example"],
        supplyChainEgress: [],
      }),
    ));
  assertEquals(rt.caughtAttack, true);
  assertEquals(rt.capturedHost, "evil-c2.example");
});

Deno.test("extractRuntime: a credential read is a caught attack regardless of supply_chain_egress", async () => {
  const rt = await extractRuntime(
    forensics({
      credReads: 2,
      attackEgressIntercepted: false,
      capturedNetworkIntent: [],
      supplyChainEgress: ["github.com"], // a co-occurring benign fetch must not mask the real signal
    }),
  );
  assertEquals(rt.caughtAttack, true, "a real credential read must never be masked by an unrelated supply-chain fetch");
});

Deno.test("extractRuntime: intended_destinations alone (legacy field) still drives caughtAttack", async () => {
  // Defensive fallback: even if attack_egress_intercepted/captured_network_intent were
  // somehow missing, a non-empty intended_destinations must still fail toward "attack".
  const rt = await withMockedFetch(UNREACHABLE_FETCH, () =>
    extractRuntime(
      forensics({
        attackEgressIntercepted: false,
        capturedNetworkIntent: [],
        intendedDestinations: ["evil-c2.example"],
        supplyChainEgress: [],
      }),
    ));
  assertEquals(rt.caughtAttack, true);
});

// ── extractRuntime: the dynamic-path live-verification extension ────────────────
// Same root-cause fix as the fast path (scan/index.ts): assemble-forensics.py's static
// SOFTWARE_DISTRIBUTION_HOSTS list can't know every legitimate host in the world, so an
// unrecognized-but-real host it flagged attack-grade gets one live check here before the
// verdict is final.
Deno.test("extractRuntime: an unrecognized host that verifies live-legitimate is downgraded, not a caught attack", async () => {
  const rt = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch,
    () =>
      extractRuntime(
        forensics({
          attackEgressIntercepted: true,
          capturedNetworkIntent: ["storage.googleapis.com"],
          // A BUILD-phase fetch to a real distribution host not on the static list —
          // the only case eligible for the live-verification downgrade.
          buildPhaseUnrecognized: ["storage.googleapis.com"],
        }),
      ),
  );
  assertEquals(rt.caughtAttack, false, "a live-verified real host with no credential involvement must not be a caught attack");
  assertEquals(rt.capturedHost, null);
  assertEquals(rt.supplyChainHost, "storage.googleapis.com");
});

Deno.test("extractRuntime: a credential read blocks the live-verification downgrade even for a real host", async () => {
  const rt = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch,
    () =>
      extractRuntime(
        forensics({
          credReads: 1,
          attackEgressIntercepted: true,
          capturedNetworkIntent: ["storage.googleapis.com"],
        }),
      ),
  );
  assertEquals(rt.caughtAttack, true, "credential involvement must never be masked by a host verifying legitimate");
  assertEquals(rt.capturedHost, "storage.googleapis.com");
});

Deno.test("extractRuntime: a credential-exfil-tagged host is never eligible for the live-verification downgrade", async () => {
  const rt = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch,
    () =>
      extractRuntime(
        forensics({
          attackEgressIntercepted: true,
          capturedNetworkIntent: ["storage.googleapis.com"],
          buildPhaseUnrecognized: ["storage.googleapis.com"], // eligible, but exfil-tagged below wins
          exfilHosts: ["storage.googleapis.com"],
        }),
      ),
  );
  assertEquals(rt.caughtAttack, true, "a host tied to a credential-exfil payload stays attack-grade regardless of what it verifies as");
  assertEquals(rt.capturedHost, "storage.googleapis.com");
});

Deno.test("extractRuntime: a RUN-phase C2 that ANSWERS HTTPS is NEVER downgraded (moat-bypass fix)", async () => {
  // The critical fix: a live C2 trivially runs a web server, so "responds to HTTPS"
  // must not clear a RUN-phase exfil target. This host is in captured_network_intent
  // but NOT in build_phase_unrecognized_egress (i.e. it was a run-phase attempt), so
  // even though the mocked fetch returns 200 it must stay a caught attack.
  const rt = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch,
    () =>
      extractRuntime(
        forensics({
          attackEgressIntercepted: true,
          capturedNetworkIntent: ["live-c2.attacker.example"],
          buildPhaseUnrecognized: [], // run-phase → not eligible for the liveness rescue
        }),
      ),
  );
  assertEquals(rt.caughtAttack, true, "a run-phase C2 that answers HTTPS must stay a caught attack");
  assertEquals(rt.capturedHost, "live-c2.attacker.example");
});

Deno.test("extractRuntime: a PRESENT-but-empty phase field downgrades nothing (strict)", async () => {
  // The sandbox emitted the phase field but no host was build-phase-unrecognized, so even a
  // host that answers HTTPS is not eligible — a run-phase host stays a caught attack.
  const rt = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch,
    () =>
      extractRuntime(
        forensics({
          attackEgressIntercepted: true,
          capturedNetworkIntent: ["storage.googleapis.com"],
          buildPhaseUnrecognized: [], // present + empty → strict, nothing eligible
        }),
      ),
  );
  assertEquals(rt.caughtAttack, true, "present-but-empty phase field → nothing downgraded");
});

Deno.test("extractRuntime: a LEGACY record with NO phase field keeps the prior liveness downgrade (forward-compat, non-regressing)", async () => {
  // Deploying this edge function ahead of the sandbox image rebuild must NOT over-flag: an
  // older record that never carried the phase field falls back to the prior behavior (any
  // captured host may be liveness-downgraded). The strict phase-aware behavior activates
  // automatically once the sandbox emits the field.
  const rec = forensics({ attackEgressIntercepted: true, capturedNetworkIntent: ["storage.googleapis.com"] });
  delete (rec.verdict as Record<string, unknown>).build_phase_unrecognized_egress;
  const rt = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch,
    () => extractRuntime(rec),
  );
  assertEquals(rt.caughtAttack, false, "legacy record (no phase field) → prior liveness downgrade preserved");
});

Deno.test("extractRuntime: a mix of one real host and one unreachable host only downgrades the real one", async () => {
  const rt = await withMockedFetch(
    ((url: string) => {
      const host = new URL(url).hostname;
      if (host === "storage.googleapis.com") return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.reject(new Error("unreachable"));
    }) as typeof fetch,
    () =>
      extractRuntime(
        forensics({
          attackEgressIntercepted: true,
          capturedNetworkIntent: ["storage.googleapis.com", "evil-c2.example"],
          // Only the build-phase host is eligible; evil-c2 (run-phase) never is.
          buildPhaseUnrecognized: ["storage.googleapis.com"],
        }),
      ),
  );
  assertEquals(rt.caughtAttack, true, "the remaining unreachable host must still keep this a caught attack");
  assertEquals(rt.capturedHost, "evil-c2.example");
  assertEquals(rt.supplyChainHost, "storage.googleapis.com");
});

// ── buildRuntimeSummary: the honest supply-chain note, and no regressions ────────
Deno.test("buildRuntimeSummary: supply-chain-only run gets an honest note, not an attack claim", async () => {
  const rt = await extractRuntime(
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

Deno.test("buildRuntimeSummary: a real caught attack is unaffected by the supply-chain branch", async () => {
  const rt = await withMockedFetch(UNREACHABLE_FETCH, () =>
    extractRuntime(
      forensics({
        attackEgressIntercepted: true,
        capturedNetworkIntent: ["evil-c2.example"],
      }),
    ));
  const summary = buildRuntimeSummary("owner", "repo", rt, NEUTRAL_REP, null);
  assert(
    summary.includes("We caught it") && summary.includes("evil-c2.example"),
    `expected the existing caught-attack framing, got: ${summary}`,
  );
});

Deno.test("buildRuntimeSummary: a plain clean run has no supply-chain text bleeding in", async () => {
  const rt = await extractRuntime(forensics({}));
  const summary = buildRuntimeSummary("owner", "repo", rt, NEUTRAL_REP, null);
  assertEquals(
    summary,
    "We ran owner/repo, a node project, in an isolated sandbox. It built and ran cleanly. " +
      "We observed no malicious behavior, credential access, or outbound exfiltration.",
  );
});
