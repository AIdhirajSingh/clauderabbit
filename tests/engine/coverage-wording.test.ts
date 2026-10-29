/**
 * Every coverage sentence follows the real phase results (live 2026-10-29,
 * sindresorhus/is-plain-obj: the report said "the install and entry point completed
 * with full coverage" and "the entry phase did not complete" in the same report,
 * because the proven_clean line always said the entry ran with full coverage).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScore, NO_BEHAVIOUR, provenRunText, type ScoreInput } from "../../lib/engine/score.ts";
import type { ReputationSignals } from "../../lib/engine/reputation.ts";
import { deterministicReport, validateLunaReport, validateWriterOutput, type WriterContext } from "../../lib/engine/model/writer.ts";

const NEUTRAL_REP: ReputationSignals = {
  ownerAgeDays: null, ownerEstablished: null, npmFirstPublishDays: null, maintainerChangedWithin30d: null,
  weeklyDownloads: null, repoStars: null, evidence: [], unavailable: [],
};

function scoreInputFixture(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    behaviour: NO_BEHAVIOUR, install: "completed", entry: "completed", archiveTruncated: false,
    forensics: { coverage: "complete", gaps: [] }, coverage: { scanners: true, osv: true, checks: true },
    malicious: [], staticFindings: [], checkFindings: [], docs: null, capabilities: [], reputation: NEUTRAL_REP, failedStages: [],
    ...over,
  };
}

for (const entry of ["completed", "failed", "timeout"] as const) {
  test(`proven_clean states the real entry result (${entry})`, () => {
    const r = computeScore(scoreInputFixture({ entry, reputation: NEUTRAL_REP }));
    const line = r.breakdown.find((d) => d.code === "proven_clean");
    assert.ok(line, "a proven clean run is lifted to the top band");
    assert.ok(line.detail.startsWith(provenRunText(entry)));
    assert.doesNotMatch(line.detail, /full coverage/i);
    if (entry !== "completed") assert.doesNotMatch(line.detail, /entry(?: point)? completed/i);
  });
}

test("a writer draft that claims a completed entry is rejected when the entry failed", () => {
  const ctx: WriterContext = { score: 90, verdict: "No threats observed", sandbox: "observed", entry: "failed" };
  const draft = {
    headline: "No threats observed: the install and entry point ran with full coverage and no deductions.",
    summary: "No threats observed. In the sandbox run, the install and entry point completed with full coverage. Not verified: the entry phase did not complete.",
  };
  const v = validateWriterOutput(draft, ctx);
  assert.equal(v.ok, false);
  const p = validateLunaReport({ what_ran: "The install and entry point completed with full coverage and no deductions.", what_matters: "No threats observed, 90/100." }, ctx);
  assert.equal(p.ok, false);
  // The same text is fine when the entry did complete.
  assert.equal(validateWriterOutput(draft, { ...ctx, entry: "completed" }).ok, true);
});

test("the deterministic fallback never claims a completed entry for a failed one", () => {
  const r = computeScore(scoreInputFixture({ entry: "failed", reputation: NEUTRAL_REP }));
  const out = deterministicReport({ score: r.score, verdict: r.verdict, breakdown: r.breakdown, notVerified: r.notVerified, sandbox: "observed" });
  const ctx: WriterContext = { score: r.score, verdict: r.verdict, sandbox: "observed", entry: "failed" };
  assert.deepEqual(validateWriterOutput(out, ctx), { ok: true });
  assert.deepEqual(validateLunaReport(out.report, ctx), { ok: true });
});
