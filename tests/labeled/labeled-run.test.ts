/**
 * The labeled set and its runner: the set is well formed (50 clean pinned by SHA, 20 malicious with OSV MAL ids),
 * every request the runner sends parses through the real /api/scan body parser, and the judging and metrics
 * rules hold. No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScanBody } from "../../lib/server/scan-service.ts";
import { judge, metrics, renderMarkdown, requestFor, validateSet } from "../../scripts/labeled-run.mjs";

const doc = JSON.parse(readFileSync(new URL("./set.json", import.meta.url), "utf8"));

test("set.json: 50 clean GitHub repos pinned by full SHA, 20 malicious with OSV MAL ids", () => {
  assert.deepEqual(validateSet(doc), []);
  const clean = doc.entries.filter((e: { expected: string }) => e.expected === "clean");
  const bad = doc.entries.filter((e: { expected: string }) => e.expected === "malicious");
  assert.equal(clean.length, 50);
  assert.equal(bad.length, 20);
  assert.ok(clean.every((e: { kind: string }) => e.kind === "github"));
  assert.ok(bad.every((e: { source: { osv_id: string } }) => /^MAL-\d{4}-\d+$/.test(e.source.osv_id)));
});

test("every runner request is accepted by the real /api/scan body parser with the pinned identity", () => {
  for (const e of doc.entries) {
    const parsed = parseScanBody(requestFor(e));
    assert.ok(parsed.ok, e.id);
    if (!parsed.ok) continue;
    const t = parsed.target;
    if (e.kind === "github") assert.ok(t.kind === "github" && t.ref === e.pin.sha, e.id);
    if (e.kind === "npm") assert.ok(t.kind === "npm" && t.version === e.pin.version, e.id);
    if (e.kind === "tarball") assert.ok(t.kind === "tarball" && t.integrity === e.pin.integrity, e.id);
  }
});

test("judge: flags, misses, pin mismatch, unavailable, empty not_verified", () => {
  const gh = doc.entries.find((e: { kind: string }) => e.kind === "github");
  const npm = doc.entries.find((e: { kind: string }) => e.kind === "npm");
  const res = (report: Record<string, unknown>) => ({ type: "result", ad: { kind: "house" }, report: { not_verified: ["x"], ...report } });
  assert.equal(judge(gh, res({ verdict: "No threats observed", commit_sha: gh.pin.sha })).status, "pass");
  assert.equal(judge(gh, res({ verdict: "High risk", commit_sha: gh.pin.sha })).status, "fail");
  assert.equal(judge(gh, res({ verdict: "Low risk", commit_sha: "0".repeat(40) })).status, "fail");
  assert.equal(judge(gh, res({ verdict: "Safe", commit_sha: gh.pin.sha })).status, "fail");
  assert.equal(judge(gh, { type: "result", ad: {}, report: { verdict: "Low risk", commit_sha: gh.pin.sha, not_verified: [] } }).status, "fail");
  assert.equal(judge(npm, res({ verdict: "Malicious", commit_sha: `${npm.pin.version}+sha512-x` })).status, "pass");
  assert.equal(judge(npm, res({ verdict: "Caution", commit_sha: `${npm.pin.version}+sha512-x` })).status, "fail");
  assert.equal(judge(npm, { type: "error", code: "not_found", message: "gone" }).status, "unavailable");
});

test("metrics: precision, recall and escalation over available scans only", () => {
  const rows = [
    { expected: "malicious", status: "pass", flagged: true, escalated: true, wallMs: 9000 },
    { expected: "malicious", status: "fail", flagged: false, escalated: true, wallMs: 8000 },
    { expected: "clean", status: "fail", flagged: true, escalated: true, wallMs: 7000 },
    { expected: "clean", status: "pass", flagged: false, escalated: false, wallMs: 6000 },
    { expected: "malicious", status: "unavailable", wallMs: 100 },
  ];
  const m = metrics(rows);
  assert.equal(m.available, 4);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.equal(m.escalation, 0.75);
  assert.equal(m.max, 9000);
  const md = renderMarkdown("https://preview.example", rows.map((r, i) => ({ id: `e${i}`, events: 0, ...r })), m, "2026-10-16T00:00:00Z");
  assert.match(md, /\| Precision \| 50\.0% \|/);
  assert.match(md, /unavailable 1/);
});
