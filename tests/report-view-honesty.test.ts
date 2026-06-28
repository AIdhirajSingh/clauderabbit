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

test("escalated-but-not-run (deep=true, no forensics) → _ranSandbox false, NO runtime claims", () => {
  const v = buildReportView(makeReport({ deep: true, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  // The exact lie that shipped (BUG-2): must NOT appear.
  assert.ok(
    !/we observed|blocked outbound attempts|when we ran it/i.test(v._finalNote),
    "static scan must not claim runtime observations: " + v._finalNote,
  );
  // It must instead speak in static terms.
  assert.ok(
    /static analysis|not executed in a sandbox|static-read/i.test(v._finalNote),
    "static scan must say so: " + v._finalNote,
  );
  // The "what we could not verify" list must flag that runtime wasn't executed.
  assert.ok(
    v._notVerified.some((s) => /not executed in a sandbox/i.test(s)),
    "notVerified must flag un-run runtime: " + JSON.stringify(v._notVerified),
  );
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

test("without forensics the stored summary is returned verbatim (no surprise edits)", () => {
  const stored = "Project Y. Runtime was not executed in a sandbox on this pass.";
  const v = buildReportView(makeReport({ score: 70, deep: true, summary: stored, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  assert.equal(v.summary, stored, "static report keeps its summary unchanged");
});
