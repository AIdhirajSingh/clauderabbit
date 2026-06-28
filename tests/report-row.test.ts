/**
 * Unit tests for `reportRowToReport` (lib/report-row.ts) — the DB-row → Report
 * reshaper used by the SSR `/owner/repo` page and the SPA board→report fetch.
 *
 * BUG-17 (determinism per commit SHA): a cached render must reconstruct the EXACT
 * reputation the fresh scan showed — in particular `forks`, which the legacy
 * columns-only path could not recover (it always returned "—"). The fix reads the
 * persisted deterministic `reputation_json` view; these lock that behavior, plus
 * the legacy fallback for rows persisted before the view existed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportRowToReport, type ReportRow } from "../lib/report-row";

function baseRow(owners: ReportRow["owners"]): ReportRow {
  return {
    owner_login: "unjs",
    repo_name: "ofetch",
    commit_sha: "dfbe3ca",
    score: 96,
    verdict: "Trusted",
    cached: true,
    deep: false,
    summary: "clean",
    confidence: 0.95,
    scan_path: "cache",
    stats_json: { loc: "75 KB", packages: 0, stars: "5.3k", created: "5 yr 3 mo" },
    packages_json: [],
    risky_json: [],
    logs_json: [],
    owners,
  };
}

test("reconstructs forks (and the rest) from the persisted reputation_json view", () => {
  const row = baseRow({
    github_login: "unjs",
    display_name: "UnJS",
    account_age_label: "5 yr 3 mo",
    established: true,
    public_repos: 82,
    stars_total: 5300,
    sentiment: "Strong",
    sentiment_score: 90,
    reputation_json: { stars: "5.3k", forks: "412", sentiment: "Excellent", sentScore: 100 },
  });
  const report = reportRowToReport(row);
  // forks comes from the deterministic view — NOT the legacy "—".
  assert.equal(report.reputation.forks, "412");
  assert.equal(report.reputation.stars, "5.3k");
  assert.equal(report.reputation.sentiment, "Excellent");
  assert.equal(report.reputation.sentScore, 100);
  // ownerHistory derives from the owner columns (matches the fresh signal facts).
  assert.equal(report.ownerHistory.handle, "unjs");
  assert.equal(report.ownerHistory.name, "UnJS");
  assert.equal(report.ownerHistory.repos, 82);
  assert.equal(report.ownerHistory.note, "");
});

test("legacy row without reputation_json falls back to columns (forks '—')", () => {
  const row = baseRow({
    github_login: "unjs",
    display_name: "UnJS",
    account_age_label: "5 yr 3 mo",
    established: true,
    public_repos: 82,
    stars_total: 5300,
    sentiment: "Strong",
    sentiment_score: 90,
  });
  const report = reportRowToReport(row);
  assert.equal(report.reputation.forks, "—");
  assert.equal(report.reputation.stars, "5.3k"); // from stats_json.stars
  assert.equal(report.reputation.sentiment, "Strong");
  assert.equal(report.reputation.sentScore, 90);
});

test("missing owner → safe defaults, never throws", () => {
  const report = reportRowToReport(baseRow(null));
  assert.equal(report.ownerHistory.handle, "unjs");
  assert.equal(report.reputation.forks, "—");
  assert.equal(report.reputation.stars, "5.3k");
});
