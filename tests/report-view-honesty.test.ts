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

test("a low score that RAN but caught NOTHING never claims a runtime detonation it didn't observe", () => {
  // The inverse of a bare 'Safe': blended score is low (static + reputation), but
  // the run itself observed no attack. The note must NOT assert credential access /
  // outbound exfil we never saw — it must say we ran it and observed nothing.
  const v = buildReportView(
    makeReport({
      score: 25,
      deep: true,
      forensics_json: { schema: "claude-rabbit/forensic-record@1" }, // no caught attack
    }),
  );
  assert.equal(v._ranSandbox, true);
  assert.ok(
    !/credential access or network behavior consistent with malware when we ran it|blocked outbound attempts are themselves/i.test(v._finalNote),
    "a clean run must not fabricate a runtime detonation: " + v._finalNote,
  );
  assert.ok(/did not observe malicious behavior/i.test(v._finalNote), v._finalNote);
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
  assert.ok(/when we ran it/i.test(v._finalNote), "a real catch earns runtime-malice language: " + v._finalNote);
  assert.ok(/consistent with malware/i.test(v._finalNote), v._finalNote);
});

test("once forensics exist, the hero summary drops the stale 'not executed in a sandbox' clause", () => {
  const v = buildReportView(
    makeReport({
      score: 28,
      deep: true,
      summary:
        "Project X does things. No malicious behavior was observed in our static read; full runtime behavior was not executed in a sandbox on this pass.",
      forensics_json: {
        schema: "claude-rabbit/forensic-record@1",
        verdict: { headline: "Ran in the sandbox; the project crashed early so runtime is largely unverified." },
      },
    }),
  );
  assert.equal(v._ranSandbox, true);
  assert.ok(
    !/not executed in a sandbox/i.test(v.summary),
    "a sandbox-run report must not claim it wasn't run: " + v.summary,
  );
  assert.ok(/Ran in the sandbox/i.test(v.summary), "summary should carry the dynamic headline: " + v.summary);
  // The project description survives the reconciliation.
  assert.ok(/Project X does things/i.test(v.summary), v.summary);
});

test("without forensics the stored summary is returned verbatim (no surprise edits)", () => {
  const stored = "Project Y. Runtime was not executed in a sandbox on this pass.";
  const v = buildReportView(makeReport({ score: 70, deep: true, summary: stored, forensics_json: null }));
  assert.equal(v._ranSandbox, false);
  assert.equal(v.summary, stored, "static report keeps its summary unchanged");
});
