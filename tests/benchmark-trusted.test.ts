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

test("the scorer's registry hosts are the sandbox's: a registry the forge passes is never an unknown host", async () => {
  const { REGISTRY_HOSTS } = await import("../lib/engine/score.ts");
  const { REGISTRY_ALLOW_OUT } = await import("../lib/engine/sandbox/provider.ts");
  for (const h of REGISTRY_ALLOW_OUT) assert.ok(REGISTRY_HOSTS.has(h), h);
  for (const h of ["registry.yarnpkg.com", "npm.jsr.io"]) assert.ok(REGISTRY_HOSTS.has(h), h);
});

test("repo.yarnpkg.com (corepack's Yarn 2+ download) is in the outer fence, exact host only, and its reads are never behaviour", async () => {
  const { REGISTRY_ALLOW_OUT } = await import("../lib/engine/sandbox/provider.ts");
  const { deriveBehaviour } = await import("../lib/engine/score.ts");
  const allow: readonly string[] = REGISTRY_ALLOW_OUT;
  assert.ok(allow.includes("repo.yarnpkg.com"));
  assert.ok(!allow.some((h) => h.includes("*") || h === "yarnpkg.com" || h.endsWith(".repo.yarnpkg.com")), "no wildcard or parent domain");
  const policy = JSON.parse(readFileSync(new URL("../sandbox/e2b/guest/policy.json", import.meta.url), "utf8")) as { registries: Record<string, string[]> };
  assert.deepEqual(policy.registries.yarn_repo, ["repo.yarnpkg.com"]);
  const call = (method: string, path: string, forged_kind: string) => ({
    t: 1, phase: "install", proto: "https", host: "repo.yarnpkg.com", port: 443, method, path, sni: "repo.yarnpkg.com",
    req_headers: {}, req_bytes: 0, req_body_b64: "", forged_kind, tls: "intercepted", canary_hits: [] as string[],
  });
  const reads = deriveBehaviour({
    forgedCalls: [call("GET", "/4.5.0/packages/yarnpkg-cli/bin/yarn.js", "registry"), call("GET", "/tags", "registry")] as never,
    files: [], processes: [], canaryInFiles: [],
  });
  assert.deepEqual(reads.nonDistributionHosts, []);
  const write = deriveBehaviour({ forgedCalls: [call("POST", "/tags", "json")] as never, files: [], processes: [], canaryInFiles: [] });
  assert.deepEqual(write.nonDistributionHosts, ["repo.yarnpkg.com"], "a write to the host still counts");
});
