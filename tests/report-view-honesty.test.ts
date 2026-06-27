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
