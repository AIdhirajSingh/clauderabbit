/**
 * Regression test for a real, live-caught bug: a CLI scan of a fast-moving repo
 * (openclaw/openclaw) showed the sandbox genuinely detonating in its progress
 * log ("Provisioning...", "Installing dependencies...", "Sandbox run complete")
 * but the FINAL PRINTED REPORT said "STATIC READ ONLY... no dynamic sandbox
 * execution". Root cause: `awaitForensics` re-polled via the caller's original,
 * ref-less scan args, so on that fast-moving repo the default branch advanced
 * mid-poll and the "poll" silently returned a FRESH, non-escalated scan of a
 * NEWER commit — which the CLI then printed as if it were this run's result.
 *
 * `isAwaitedForensicsReport` is the pure predicate that now gates every polled
 * response: a report only counts as "the awaited result" if its `commit_sha`
 * matches the commit that was actually dispatched to the sandbox. This test
 * locks that in — a report contradicting the escalated commit must never be
 * accepted, regardless of what it claims about forensics.
 */
import assert from "node:assert";
import { test } from "node:test";
import { isAwaitedForensicsReport } from "./client.js";
import type { Report } from "./types.js";

/** A minimal, fully-valid Report — every field the real type requires, filled in plainly. */
function makeReport(overrides: Partial<Report>): Report {
  return {
    id: "test-id",
    owner: "openclaw",
    name: "openclaw",
    score: 92,
    verdict: "Trusted",
    cached: false,
    deep: false,
    summary: "static-only summary",
    ownerHistory: { handle: "openclaw", name: "openclaw", age: "6 mo", established: false, repos: 81, note: "" },
    reputation: { stars: "382.4k", forks: "80.3k", sentiment: "High community engagement", sentScore: 95 },
    stats: { loc: "-", packages: 0, stars: "382.4k", created: "6 mo ago" },
    packages: [],
    risky: [],
    logs: [],
    commit_sha: "4bc300843d5e",
    forensics: undefined,
    ...overrides,
  };
}

test("a report for a DIFFERENT commit than the one escalated is rejected — the exact live bug", () => {
  // The escalated + detonated commit (forensics really did attach for THIS sha).
  const escalatedSha = "7fe004d852510000000000000000000000000000";
  // What the buggy unpinned poll actually returned: a fresh fast-path-only scan
  // of a NEWER commit the default branch had advanced to — no forensics, no
  // escalation, but superficially a valid, well-formed report.
  const driftedReport = makeReport({
    commit_sha: "4bc300843d5e00000000000000000000000000",
    deep: false,
    forensics: undefined,
  });
  assert.equal(
    isAwaitedForensicsReport(driftedReport, escalatedSha),
    false,
    "a report for a commit other than the one actually dispatched must never be accepted as the awaited result",
  );
});

test("a report for the SAME commit is accepted, whether or not forensics have attached yet", () => {
  const sha = "7fe004d852510000000000000000000000000000";
  const stillPending = makeReport({ commit_sha: sha, deep: true, forensics: undefined });
  const verified = makeReport({
    commit_sha: sha,
    deep: true,
    score: 64,
    verdict: "Caution",
    forensics: {
      verdict: { dynamic_score: 64, one_word: "Caution", headline: "", attack_egress_intercepted: false, not_verified: [] },
      honesty: { possibly_dormant_unverified: false, notes: [] },
    },
  });
  assert.equal(isAwaitedForensicsReport(stillPending, sha), true);
  assert.equal(isAwaitedForensicsReport(verified, sha), true);
});
