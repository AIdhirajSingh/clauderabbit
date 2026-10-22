import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCanaries } from "../../lib/engine/forensics/capture.ts";
import { buildRanSummary, classifyNetwork, ranFrom } from "../../lib/engine/ran.ts";
import { parseForensicBundle, type DetonationResult } from "../../lib/engine/sandbox/detonate.ts";
import { payloadFromRows, reportsRowFor, type ReportRecord, type StoredReportRow } from "../../lib/engine/store.ts";
import type { ForgedCallData, ReportPayload } from "../../lib/engine/types.ts";
import { filesOf, makeTgz } from "../support/tar.ts";

const canaries = makeCanaries();

function cap(over: Record<string, unknown>) {
  return { t: 1, phase: "install", proto: "https", port: 443, method: "GET", path: "/x", sni: null, req_headers: {}, req_bytes: 0, req_body_b64: "", tls: "intercepted", ...over };
}

async function detonated(capture: object[], opts: { entry?: string; entryExit?: number | null; checks?: string } = {}): Promise<DetonationResult> {
  const result = {
    version: 1,
    mode: "repo",
    ecosystem: "npm",
    deps_kind: "npm-ls",
    install: { status: "completed", exit_code: 0, ms: 4210, command: "npm ci --omit=dev --no-audit --no-fund" },
    entry: { status: opts.entry ?? "completed", exit_code: opts.entryExit === undefined ? 0 : opts.entryExit, ms: 120 },
    clock: { real_ms: 120, fake_ms: 3600 },
    total_ms: 9000,
  };
  const bundle = makeTgz([
    { name: "out/", type: "dir" },
    { name: "out/result.json", data: JSON.stringify(result) },
    { name: "out/checks.jsonl", data: opts.checks ?? '{"name":"egress_contained","ok":true}\n' },
    { name: "out/capture.jsonl", data: capture.map((c) => JSON.stringify(c)).join("\n") },
    { name: "out/trace.install", data: `9 1.0 execve("/bin/sh", ["sh", "-c", "node install.js"], 0x1 /* 1 vars */) = 0\n` },
    {
      name: "out/trace.entry",
      data:
        `20 2.0 execve("/bin/bash", ["bash", "/root/run/entry.sh"], 0x1 /* 1 vars */) = 0\n` +
        `21 2.1 execve("/usr/local/bin/node", ["node", "-e", "require('/work/src')"], 0x1 /* 1 vars */) = 0\n`,
    },
    { name: "out/deps.json", data: JSON.stringify({ name: "repo", dependencies: { esbuild: { version: "0.21.5" }, "left-pad": { version: "1.3.0" }, chalk: { version: "5.3.0" } } }) },
    { name: "out/install.out", data: "added 3 packages" },
  ]);
  return { sandboxId: "sbx-1", harnessExit: 0, ...(await parseForensicBundle(bundle, canaries)) };
}

const REPO = filesOf({
  "package.json": JSON.stringify({ name: "acme", version: "1.0.0", scripts: { postinstall: "node install.js", test: "node t.js" } }),
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "acme", version: "1.0.0" },
      "node_modules/esbuild": { version: "0.21.5", hasInstallScript: true },
      "node_modules/left-pad": { version: "1.3.0" },
      "node_modules/chalk": { version: "5.3.0" },
      // In the lockfile with a script but not installed by this run (dev, skipped by the plan).
      "node_modules/husky": { version: "9.0.0", dev: true, hasInstallScript: true },
    },
  }),
});
const PLAN = { devScripts: [], devTotal: 4, source: "lockfile-v2" as const, platformSkipped: [] };

test("ran: a detonated npm run yields every field from the run's own facts", async () => {
  const d = await detonated([cap({ host: "registry.npmjs.org", forged_kind: "registry" }), cap({ proto: "dns", host: "registry.npmjs.org", port: 53, forged_kind: "dns", tls: null })]);
  assert.equal(d.entryExitCode, 0);
  const ran = buildRanSummary({ detonation: d, plan: PLAN, files: REPO });
  assert.deepEqual(ran, {
    package_manager: "npm",
    installed: 3,
    skipped: 4,
    install_ms: 4210,
    install_scripts: 2, // esbuild (installed, hasInstallScript) + the repo's own postinstall; husky was not installed
    network: { kind: "registry_only" },
    entry_point: { command: "node -e require('/work/src')", exit_code: 0 },
  });
});

test("ran: non-registry calls the forge answered are counted as forged; none and lost records are distinct", async () => {
  const forged = await detonated([
    cap({ host: "registry.npmjs.org", forged_kind: "registry" }),
    cap({ host: "c2.example", method: "POST", forged_kind: "json" }),
    cap({ proto: "dns", host: "c2.example", port: 53, forged_kind: "dns", tls: null }),
  ]);
  assert.deepEqual(classifyNetwork(forged), { kind: "forged", calls: 2 });

  const quiet = await detonated([]);
  assert.deepEqual(classifyNetwork(quiet), { kind: "none" });

  // A registry host answered by a non-registry handler is not plain registry traffic.
  const odd: ForgedCallData = { phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, req_bytes: 0, forged_kind: "json", canary_hits: [] };
  assert.deepEqual(classifyNetwork({ forgedCalls: [odd], forensics: { coverage: "complete", gaps: [] } }), { kind: "forged", calls: 1 });

  // A cut record cannot claim registry-only or none; a lost one claims nothing.
  assert.equal(classifyNetwork({ forgedCalls: [], forensics: { coverage: "partial", gaps: ["cut"] } }), null);
  assert.equal(classifyNetwork({ forgedCalls: [odd], forensics: { coverage: "lost", gaps: [] } }), null);
});

test("ran: unknown facts stay null, never guessed", async () => {
  const d = await detonated([], { entry: "skipped", entryExit: null });
  const ran = buildRanSummary({ detonation: d, plan: null, files: filesOf({ "package.json": "{}" }) })!;
  assert.equal(ran.skipped, null, "no install plan");
  assert.equal(ran.install_scripts, null, "no npm lockfile");
  assert.equal(ran.entry_point, null, "entry did not run");
  assert.equal(buildRanSummary({ detonation: null, plan: PLAN, files: REPO }), undefined, "no detonation result: no summary");
});

const BASE: ReportPayload = {
  run_id: "11111111-1111-4111-8111-111111111111",
  target: "acme/lib",
  commit_sha: "a".repeat(40),
  score: 88,
  verdict: "Low risk",
  band: "green",
  summary: "s",
  headline: "h",
  evidence: { behaviour: [], code: [], reputation: [] },
  breakdown: [],
  not_verified: [],
  forensics: null,
  packages: null,
  model_id: "m",
  template: "t",
  timings: {},
  writer: "deterministic",
};

function roundTrip(report: ReportPayload): ReportPayload {
  const record: ReportRecord = { runId: report.run_id, targetKind: "github", subject: "acme/lib", ownerLogin: "acme", repoName: "lib", commitSha: report.commit_sha, report, packages: null, risky: [], logs: [], stats: {} };
  const row = reportsRowFor(record);
  const stored: StoredReportRow = { id: 1, commit_sha: row.commit_sha, score: row.score, verdict: row.verdict, summary: row.summary, stats_json: JSON.parse(JSON.stringify(row.stats_json)), packages_json: row.packages_json, forensics_json: row.forensics_json, run_id: row.run_id, score_breakdown: row.score_breakdown, not_verified: row.not_verified };
  return payloadFromRows(stored, { id: report.run_id, subject: "acme/lib", model_id: "m", template: "t", timings: {} });
}

test("ran: persisted in stats_json and read back by payloadFromRows", async () => {
  const ran = buildRanSummary({ detonation: await detonated([cap({ host: "c2.example", forged_kind: "json" })], { entry: "failed", entryExit: 1 }), plan: PLAN, files: REPO })!;
  assert.deepEqual(ran.network, { kind: "forged", calls: 1 });
  assert.deepEqual(ran.entry_point, { command: "node -e require('/work/src')", exit_code: 1 });
  assert.deepEqual(roundTrip({ ...BASE, ran }).ran, ran);
});

test("ran: old rows without it (or with a malformed one) give undefined", () => {
  assert.equal(roundTrip(BASE).ran, undefined);
  assert.equal(ranFrom(undefined), null);
  assert.equal(ranFrom({ package_manager: "npm", installed: "3", skipped: null, install_ms: null, install_scripts: null, network: null, entry_point: null }), null);
  assert.equal(ranFrom({ package_manager: "npm", installed: 3, skipped: null, install_ms: null, install_scripts: null, network: { kind: "bogus" }, entry_point: null }), null);
});

test("a partial scan's reason line is stored and read back with it (stored scans and replays show it)", () => {
  const back = roundTrip({ ...BASE, partial: true, partial_reason: "Build ran out of time, so the program never ran" });
  assert.equal(back.partial, true);
  assert.equal(back.partial_reason, "Build ran out of time, so the program never ran");
  assert.equal(roundTrip(BASE).partial_reason, undefined);
});
