import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeScore, NO_BEHAVIOUR, type ScoreInput } from "../lib/engine/score.ts";
import { parseScanBody } from "../lib/server/scan-service.ts";

const bench = JSON.parse(readFileSync(new URL("../benchmarks/trusted.json", import.meta.url), "utf8")) as { min_score: number; targets: Array<{ target: string }> };

test("the trusted benchmark: 15 targets, the required ones included, each a valid scan body", () => {
  assert.equal(bench.targets.length, 15);
  assert.equal(bench.min_score, 80);
  const names = bench.targets.map((t) => t.target);
  for (const n of ["react", "lodash", "express", "axios", "chalk", "vite", "typescript", "next"]) assert.ok(names.some((t) => t.endsWith(`/${n}`) || t === `npm:${n}`), n);
  for (const t of bench.targets) assert.ok(parseScanBody(t).ok, t.target);
});

test("the rule the benchmark guards: read findings with nothing observed take no points; observed behaviour makes them count", () => {
  const base: ScoreInput = { behaviour: NO_BEHAVIOUR, install: "completed", entry: "completed", archiveTruncated: false, forensics: { coverage: "complete", gaps: [] }, coverage: { scanners: true, osv: true, checks: true }, malicious: [], staticFindings: [], checkFindings: [], docs: null, capabilities: [], reputation: { ownerAgeDays: null, ownerEstablished: null, npmFirstPublishDays: null, maintainerChangedWithin30d: null, weeklyDownloads: null, repoStars: null, evidence: [], unavailable: [] }, failedStages: [] };
  const hits = Array.from({ length: 23 }, (_, i) => ({ source: "heuristic" as const, rule: "heur.shell_fetch.unrecognized", severity: "high" as const, file: "scripts/install.sh", line: i + 1, message: "m", reach: "import" as const }));
  const read = computeScore({ ...base, staticFindings: hits });
  assert.ok(read.score >= bench.min_score, String(read.score));
  assert.ok(!read.breakdown.some((d) => d.points < 0 && (d.group === "static" || d.group === "docs")));
  const seen = computeScore({ ...base, staticFindings: hits, behaviour: { ...NO_BEHAVIOUR, canaryHits: ["AWS_ACCESS_KEY_ID sent to c2.example (https, install)"] } });
  assert.ok(seen.breakdown.some((d) => d.group === "static" && d.points < 0), "with observed behaviour the read findings count");
  assert.ok(seen.score < 30);
});
