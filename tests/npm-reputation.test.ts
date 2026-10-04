/**
 * npm package reports must show real registry signals only — never the
 * "npm / unknown / new / 0 repos" placeholders a GitHub-owner card produced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { npmSignalRows } from "../lib/report-view";
import { reportToMarkdown } from "../lib/export-markdown";
import type { Report } from "../lib/types";

test("npmSignalRows: full registry data renders every real signal", () => {
  const rows = npmSignalRows({
    package: "left-pad", version: "1.3.0", publisher: "stevemao",
    maintainers: ["stevemao", "azer"], ageLabel: "12 yr 6 mo",
    weeklyDownloads: 1234567, versionCount: 13, license: "WTFPL",
  });
  const m = Object.fromEntries(rows);
  assert.equal(m["Publisher"], "@stevemao");
  assert.equal(m["Maintainers (2)"], "stevemao, azer");
  assert.equal(m["First published"], "12 yr 6 mo ago");
  assert.ok(m["Weekly downloads"]);
  assert.equal(m["Versions published"], "13");
});

test("npmSignalRows: missing signals are omitted, never 'unknown'/'new'/0", () => {
  const rows = npmSignalRows({ package: "x", version: "1.0.0" });
  assert.deepEqual(rows, []);
  const text = JSON.stringify(npmSignalRows({ package: "x", version: "1.0.0", weeklyDownloads: 5 }));
  assert.ok(!/unknown|"new"|Public repos|Account age/i.test(text), text);
});

test("markdown export: npm report uses registry rows, not the GitHub owner table", () => {
  const report = {
    id: "npm/left-pad", owner: "npm", name: "left-pad", score: 94, verdict: "Trusted",
    cached: true, deep: false, summary: "s",
    ownerHistory: { handle: "stevemao", name: "left-pad", age: "12 yr", established: true, repos: 2, note: "" },
    reputation: { stars: "—", forks: "—", sentiment: "", sentScore: 0 },
    npm: { package: "left-pad", version: "1.3.0", publisher: "stevemao", weeklyDownloads: 10 },
    stats: { loc: "—", packages: 0, stars: "—", created: "—" },
    packages: [], risky: [], logs: [],
  } as unknown as Report;
  const md = reportToMarkdown(report, "https://clauderabbit.in");
  assert.ok(md.includes("Publisher"), md);
  assert.ok(!md.includes("Public repos") && !md.includes("Account age") && !md.includes("Community sentiment"), md);
});

test("published page: an npm report row builds the npm card from stats_json.npm", async () => {
  const { reportRowToReport } = await import("../lib/report-row");
  const row = {
    owner_login: "npm", repo_name: "left-pad", commit_sha: "sha512-x", score: 90, verdict: "Trusted",
    cached: false, deep: false, summary: "s", confidence: 0.9, scan_path: "fast",
    stats_json: { loc: "—", packages: 0, stars: "—", created: "—",
      npm: { package: "left-pad", version: "1.3.0", publisher: "stevemao", maintainers: ["stevemao", "westlac"], ageLabel: "12 yr 6 mo", weeklyDownloads: 3230729, versionCount: 15 } },
    packages_json: [], risky_json: [], logs_json: [], owner_id: null, owners: null,
  };
  const r = reportRowToReport(row as unknown as Parameters<typeof reportRowToReport>[0]);
  assert.equal(r.npm?.publisher, "stevemao");
  assert.equal(r.npm?.versionCount, 15);
  assert.notEqual(r.ownerHistory.handle, "npm");
  assert.ok(!JSON.stringify(npmSignalRows(r.npm!)).includes("unknown"));
});

test("published page: an old npm row without the registry view shows no junk rows", async () => {
  const { reportRowToReport } = await import("../lib/report-row");
  const row = {
    owner_login: "npm", repo_name: "left-pad", commit_sha: "x", score: 94, verdict: "Trusted", cached: true,
    deep: false, summary: "", confidence: 1, scan_path: "fast", stats_json: { loc: "—" },
    packages_json: [], risky_json: [], logs_json: [], owner_id: null, owners: null,
  };
  const r = reportRowToReport(row as unknown as Parameters<typeof reportRowToReport>[0]);
  assert.equal(r.npm?.package, "left-pad");
  assert.deepEqual(npmSignalRows(r.npm!), []);
});
