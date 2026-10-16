import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReport } from "../lib/scan.ts";
import { buildReportView } from "../lib/report-view.ts";

// BUG-2 (the canary): a report's runtime claims/badge must reflect what ACTUALLY
// executed (a forensic record exists), never the bare `deep`/`scan_path` flag.

function makeReport(overrides: Record<string, unknown>) {
  return normalizeReport({
    id: "owner/repo",
    owner: "owner",
    name: "repo",
    score: 25,
    verdict: "Malicious",
    cached: false,
    deep: true,
    scan_path: "deep",
    summary: "summary",
    risky: [],
    packages: [],
    logs: [],
    ...overrides,
  });
}

test("escalation attempted but not run (deep=true, no forensics) → _ranSandbox false, says the run DID NOT COMPLETE, distinct from never-escalated", () => {
  const v = buildReportView(makeReport({ deep: true, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  // The exact lie that shipped (BUG-2): must NOT appear.
  assert.ok(
    !/we observed|blocked outbound attempts|when we ran it/i.test(v._finalNote),
    "attempted-but-failed scan must not claim runtime observations: " + v._finalNote,
  );
  // It must PLAINLY say the sandbox run did not complete — the honest failed/incomplete state.
  assert.ok(
    /sandbox run did not complete/i.test(v._finalNote),
    "an attempted-but-failed escalation must say the run did not complete: " + v._finalNote,
  );
  // And it must NOT wear the never-escalated sentence — the two states never share a sentence.
  assert.ok(
    !/runtime was not executed in a sandbox on this pass/i.test(v._finalNote),
    "attempted-but-failed must not reuse the never-escalated 'was not executed' sentence: " + v._finalNote,
  );
  // The "what we could not verify" list must flag that the run did not complete.
  assert.ok(
    v._notVerified.some((s) => /sandbox run did not complete/i.test(s)),
    "notVerified must flag the incomplete run: " + JSON.stringify(v._notVerified),
  );
});

test("never-escalated vs attempted-but-failed (both no forensics) produce DISTINCT final notes that never share a sentence", () => {
  const never = buildReportView(makeReport({ score: 45, deep: false, forensics_json: null }));
  const failed = buildReportView(makeReport({ score: 45, deep: true, forensics_json: null }));
  assert.notEqual(never._finalNote, failed._finalNote, "the two states must not render identical copy");
  // never-escalated speaks in static-read terms; attempted-but-failed says the run did not complete.
  assert.ok(/not executed in a sandbox on this pass/i.test(never._finalNote), never._finalNote);
  assert.ok(/sandbox run did not complete/i.test(failed._finalNote), failed._finalNote);
  // Neither sentence appears in the other note.
  assert.ok(!/sandbox run did not complete/i.test(never._finalNote), "never-escalated must not claim an attempted run");
  assert.ok(!/not executed in a sandbox on this pass/i.test(failed._finalNote), "attempted-but-failed must not claim it was never run");
});

test("a low score alone (no forensics) never produces the 'active credential access' runtime claim", () => {
  for (const score of [10, 25, 45, 59]) {
    const v = buildReportView(makeReport({ score, deep: true, forensics_json: null }));
    assert.equal(v._ranSandbox, false);
    assert.ok(
      !/active credential access or network behavior consistent with malware when/i.test(v._finalNote) &&
        !/blocked outbound attempts are themselves/i.test(v._finalNote),
      `score ${score} must not claim runtime detonation: ${v._finalNote}`,
    );
  }
});

test("a safe static scan reads as a static-read clearance, not an executed clean run", () => {
  const v = buildReportView(makeReport({ score: 95, verdict: "Trusted", deep: false, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  assert.ok(/static read|not executed in a sandbox/i.test(v._finalNote), v._finalNote);
});

test("a report WITH a forensic record → _ranSandbox true, runtime language allowed", () => {
  // A present forensic record is the honest 'the sandbox ran' signal.
  const v = buildReportView(
    makeReport({
      score: 25,
      deep: true,
      forensics_json: { schema: "claude-rabbit/forensic-record@1" },
    }),
  );
  assert.equal(v._ranSandbox, true, "a forensic record means it ran");
  assert.ok(/we ran it|in the sandbox/i.test(v._finalNote), "real run earns runtime language: " + v._finalNote);
  // And the 'not executed in a sandbox' caveat must NOT be added when it ran.
  assert.ok(
    !v._notVerified.some((s) => /not executed in a sandbox|no sandbox was run/i.test(s)),
    "a real run must not claim it wasn't run: " + JSON.stringify(v._notVerified),
  );
});

// U1: every "didn't exercise / unverified / not executed / largely unverified /
// couldn't verify / not a guarantee" phrasing is FORBIDDEN on an escalated repo.
const HEDGE = /not executed in a sandbox|no sandbox was run|did not run to completion|largely unverified|could not verify|couldn'?t verify|runtime (is|was) (largely )?unverified|not a guarantee|did not (exhaustively )?exercise|only partially exercised|the run was limited|reported as unverified/i;

test("a low score that RAN but caught NOTHING states it plainly, with NO hedge (U1)", () => {
  // Blended score is low (static + reputation), but the run itself observed no
  // attack. The note must NOT fabricate a detonation AND must carry no hedge.
  const v = buildReportView(
    makeReport({
      score: 25,
      deep: true,
      forensics_json: { schema: "claude-rabbit/forensic-record@1" }, // no caught attack
    }),
  );
  assert.equal(v._ranSandbox, true);
  assert.ok(
    !/credential access or .* consistent with malware when we ran it/i.test(v._finalNote),
    "a clean run must not fabricate a runtime detonation: " + v._finalNote,
  );
  assert.ok(/observed no malicious behavior/i.test(v._finalNote), v._finalNote);
  assert.ok(!HEDGE.test(v._finalNote), "no hedge on an escalated repo: " + v._finalNote);
  assert.equal(v._notVerified.length, 0, "an escalated repo has no 'could not verify' list");
});

test("a run that DID catch an attack earns the strong runtime-malice language", () => {
  const v = buildReportView(
    makeReport({
      score: 18,
      deep: true,
      forensics_json: {
        schema: "claude-rabbit/forensic-record@1",
        verdict: { attack_egress_intercepted: true, captured_network_intent: ["exfil.evil-c2.example"] },
      },
    }),
  );
  assert.equal(v._ranSandbox, true);
  assert.ok(v._forensics?._caughtAttack, "fixture should be a caught attack");
  assert.ok(/caught it attempting/i.test(v._finalNote), "a real catch is stated plainly: " + v._finalNote);
  assert.ok(/malware/i.test(v._finalNote), v._finalNote);
  assert.ok(!HEDGE.test(v._finalNote), "even a caught attack carries no 'unverified' hedge: " + v._finalNote);
});

test("a merely-captured, non-attack-grade host does NOT overstate the verdict as a caught attack (real bug fix)", () => {
  // The exact shape that produced the overstated sentence: the verdict's OWN
  // classification says this was NOT an attack (attack_egress_intercepted:
  // false — e.g. a supply-chain-classified fetch to an unrecognized host),
  // no credential reads happened, but a host was still captured/logged for
  // transparency. Merely capturing a host must not itself imply malice.
  const v = buildReportView(
    makeReport({
      score: 25,
      deep: true,
      forensics_json: {
        schema: "claude-rabbit/forensic-record@1",
        verdict: { attack_egress_intercepted: false, captured_network_intent: ["storage.googleapis.com"] },
        in_vm_behavior: { high_value_credential_reads: 0 },
      },
    }),
  );
  assert.equal(v._ranSandbox, true);
  assert.equal(v._forensics?._caughtAttack, false, "a non-attack-grade capture must not read as a caught attack");
  assert.ok(
    !/caught it attempting credential access or outbound exfiltration/i.test(v._finalNote),
    "must not overstate a benign capture as credential access or exfiltration: " + v._finalNote,
  );
  assert.ok(/observed no malicious behavior/i.test(v._finalNote), v._finalNote);
});

test("an escalated report carries NO 'what we could not verify' list and NO hedge anywhere (U1)", () => {
  // The de-hedging of the SUMMARY happens at the backend (the attach edge fn writes
  // a runtime-first summary); the frontend's U1 job is to drop the hedge LIST + the
  // hedge LANGUAGE in the final note. This asserts that frontend contract.
  const v = buildReportView(
    makeReport({
      score: 34,
      deep: true,
      summary: "We ran AmrDab/clawdcursor in an isolated sandbox. It built and started, then exited with an error on startup.",
      forensics_json: { schema: "claude-rabbit/forensic-record@1" },
    }),
  );
  assert.equal(v._ranSandbox, true);
  assert.equal(v._notVerified.length, 0, "no 'what we could not verify' list on an escalated repo");
  assert.ok(!HEDGE.test(v._finalNote), "final note is hedge-free: " + v._finalNote);
  // The forensic card's verdict word must equal the hero verdict (one report, one verdict).
  assert.equal(v._forensics?._verdictWord, v.verdict, "forensic card verdict must match the hero");
});

test("a STATIC report STILL keeps its honest 'could not verify' list (the reframe is escalation-only)", () => {
  const v = buildReportView(makeReport({ score: 84, deep: false, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  assert.ok(v._notVerified.length > 0, "static reads keep the honest hedge list");
  assert.ok(
    v._notVerified.some((s) => /not executed in a sandbox/i.test(s)),
    "static read names that runtime wasn't exercised: " + JSON.stringify(v._notVerified),
  );
});

test("a NEVER-escalated summary is returned verbatim (no surprise edits)", () => {
  const stored = "Project Y. Runtime was not executed in a sandbox on this pass.";
  const v = buildReportView(makeReport({ score: 70, deep: false, summary: stored, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  assert.equal(v.summary, stored, "a never-escalated (static-only) report keeps its summary unchanged");
});

test("an escalated-but-incomplete summary reconciles the stale 'not executed' clause with the badge/verdict", () => {
  // pre-2.0 row, deep=true + no forensics: the old static summary can still carry the static
  // 'runtime ... was not executed in a sandbox' clause, which contradicts the
  // 'Sandbox run incomplete' badge + 'the sandbox run did not complete' final note.
  const stored =
    "The repository is an industry-standard project. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.";
  const v = buildReportView(makeReport({ score: 35, deep: true, summary: stored, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  assert.ok(
    /sandbox run did not complete on this pass/i.test(v.summary),
    "summary now says the run did not complete: " + v.summary,
  );
  assert.ok(
    !/was not executed in a sandbox on this pass/i.test(v.summary),
    "summary no longer carries the never-escalated 'not executed' clause: " + v.summary,
  );
  // The descriptive part of the summary is preserved (only the stale clause changed).
  assert.ok(/industry-standard project/i.test(v.summary), "descriptive text preserved: " + v.summary);
});

// ---- 2.0 rows (forensics_json version 2) -----------------------------------------

function v2(over: Record<string, unknown> = {}) {
  return {
    version: 2,
    install: "completed",
    entry: "completed",
    ecosystem: "npm",
    install_command: "npm install --no-audit --no-fund /work/pkg.tgz",
    forged_calls: [
      { phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, forged_kind: "registry", req_bytes: 0, canary_hits: [] },
      { phase: "install", proto: "http", host: "c2.cr-fixture.invalid", port: 80, method: "POST", path: "/collect", forged_kind: "json", req_bytes: 120, canary_hits: ["AWS_SECRET_ACCESS_KEY"] },
    ],
    files: [{ phase: "install", op: "read_decoy", path: "/home/cr/.aws/credentials", pid: 9 }],
    processes: [{ phase: "install", pid: 9, ppid: 1, argv: ["node", "postinstall.js"] }],
    canary_in_files: [],
    checks: [{ name: "egress_contained", ok: true }],
    forensic_coverage: { coverage: "complete", gaps: [] },
    ...over,
  };
}
const V2_NOT_VERIFIED = ["Behaviour outside the observed install and entry windows.", "Code paths not triggered by install or the entry point."];

test("2.0 row with a canary hit renders the caught-attack note, the forged call, and the stored not_verified list", () => {
  const view = buildReportView(makeReport({ score: 0, verdict: "Malicious", deep: true, forensics_json: v2(), not_verified: V2_NOT_VERIFIED }));
  assert.ok(view._forensics, "the version 2 record is recognized");
  assert.equal(view._ranSandbox, true);
  assert.match(view._finalNote, /caught it attempting credential access or outbound exfiltration/);
  assert.doesNotMatch(view._finalNote, /did not complete on this pass/);
  assert.deepEqual(view._forensics!._capturedHosts, ["c2.cr-fixture.invalid"]);
  assert.equal(view._forensics!.raw.in_vm_behavior.high_value_credential_reads, 1);
  assert.deepEqual(view._notVerified, V2_NOT_VERIFIED);
});

test("2.0 row whose forensic record was lost never reads as an observed clean run", () => {
  const view = buildReportView(
    makeReport({ score: 59, verdict: "High risk", deep: true, forensics_json: v2({ install: "timeout", entry: "skipped", forged_calls: [], files: [], forensic_coverage: { coverage: "lost", gaps: ["x"] } }), not_verified: ["The sandbox run did not produce a forensic record, so install-time and runtime behaviour were not observed."] }),
  );
  assert.equal(view._ranSandbox, false);
  assert.match(view._finalNote, /runtime behaviour was not observed/);
  assert.doesNotMatch(view._finalNote, /observed no malicious behavior/);
  assert.match(view._notVerified.join(" "), /not observed/);
});
