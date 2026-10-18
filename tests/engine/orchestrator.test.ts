import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadEngineConfig } from "../../lib/engine/config.ts";
import { runScan, type EngineDeps } from "../../lib/engine/orchestrator.ts";
import type { SandboxCreateOptions, SandboxProvider, SandboxSession } from "../../lib/engine/sandbox/provider.ts";
import type { ScanEvent, ScanRequest } from "../../lib/engine/types.ts";
import { bytes, fakeFetch, json, type FakeRoute } from "../support/fake-fetch.ts";
import { MemoryStore } from "../support/memory-store.ts";
import { StandInJev } from "../support/stand-in-jev.ts";
import { StandInModel } from "../support/stand-in-model.ts";
import { makeTgz } from "../support/tar.ts";

const tgz = makeTgz([
  { name: "package/package.json", data: '{"name":"orch-fixture","version":"1.0.0","main":"index.js"}' },
  { name: "package/index.js", data: "module.exports = 1;" },
]);
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
const tarball = "https://registry.npmjs.org/orch-fixture/-/orch-fixture-1.0.0.tgz";
const created = new Date(Date.now() - 400 * 86_400_000).toISOString();

const ROUTES: FakeRoute[] = [
  {
    match: "https://registry.npmjs.org/orch-fixture",
    respond: () => json({ name: "orch-fixture", "dist-tags": { latest: "1.0.0" }, time: { created, "1.0.0": created }, versions: { "1.0.0": { version: "1.0.0", dist: { tarball, integrity } } } }),
  },
  { match: tarball, respond: () => bytes(tgz) },
  { match: (u) => u.startsWith("https://api.npmjs.org/downloads/"), respond: () => json({ downloads: 10 }) },
  { match: "https://api.osv.dev/v1/querybatch", respond: (_u, init) => json({ results: (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries.map(() => ({})) }) },
];
const ff = fakeFetch(ROUTES);

class RefusingProvider implements SandboxProvider {
  readonly template = "refusing";
  attempts = 0;
  async create(opts: SandboxCreateOptions): Promise<SandboxSession> {
    void opts;
    this.attempts++;
    throw new Error("concurrency limit reached");
  }
}

const req: ScanRequest = { target: { kind: "npm", name: "orch-fixture" }, caller: { surface: "web", userId: null, ip: null, deviceId: null, operator: false }, regenerate: false };

function deps(store: MemoryStore, sandbox: SandboxProvider): EngineDeps {
  let n = 0;
  return { jev: new StandInJev(), luna: new StandInModel(), sandbox, store, fetch: ff.fetch, now: () => Date.now(), config: loadEngineConfig({}), newRunId: () => `00000000-0000-4000-8000-00000000000${++n}` };
}

test("no sandbox capacity: the scan errors with capacity, records the run as error, never scores without running", async () => {
  const store = new MemoryStore();
  const events: ScanEvent[] = [];
  const out = await runScan(req, deps(store, new RefusingProvider()), { onEvent: (e) => events.push(e) });
  assert.equal(out.kind, "error");
  if (out.kind !== "error") return;
  assert.equal(out.code, "capacity");
  assert.equal(store.runs.get(out.runId!)!.status, "error");
  assert.equal(store.reports.size, 0);
  assert.ok(events.some((e) => e.type === "stage" && e.data.name === "detonate" && e.data.status === "error"));
  assert.ok(!events.some((e) => e.type === "stage" && e.data.name === "score"));
});

test("a second request for a running SHA attaches; an exhausted budget refuses fresh scans", async () => {
  const store = new MemoryStore();
  const d = deps(store, new RefusingProvider());
  const key = `1.0.0+${integrity}`;
  await store.claimRun({ runId: "running-run", targetKind: "npm", subject: "npm:orch-fixture", commitSha: key, modelId: "m", template: "t" });
  const attached = await runScan(req, d);
  assert.deepEqual(attached, { kind: "attached", runId: "running-run" });

  const store2 = new MemoryStore();
  store2.budget = { seconds: 10_000_000, tokens: 0 };
  const provider = new RefusingProvider();
  const refused = await runScan(req, deps(store2, provider));
  assert.equal(refused.kind, "error");
  if (refused.kind === "error") assert.equal(refused.code, "budget_exhausted");
  assert.equal(provider.attempts, 0, "no sandbox is created over budget");
});

test("unknown npm package resolves to not_found before any run is recorded", async () => {
  const store = new MemoryStore();
  const nf = fakeFetch([{ match: "https://registry.npmjs.org/nope-pkg", respond: () => new Response("{}", { status: 404 }) }]);
  const out = await runScan({ ...req, target: { kind: "npm", name: "nope-pkg" } }, { ...deps(store, new RefusingProvider()), fetch: nf.fetch });
  assert.equal(out.kind, "error");
  if (out.kind === "error") {
    assert.equal(out.code, "not_found");
    assert.equal(out.runId, null);
  }
  assert.equal(store.runs.size, 0);
});

test("a run with incomplete coverage is stored but never served as the SHA cache hit", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { MockSandboxProvider } = await import("../support/mock-sandbox.ts");
  const osvDown = fakeFetch([
    ...ROUTES.slice(0, 3),
    { match: "https://api.osv.dev/v1/querybatch", respond: () => new Response("unavailable", { status: 503 }) },
  ]);
  const tmp = mkdtempSync(join(tmpdir(), "cr-orch-"));
  try {
    const store = new MemoryStore();
    let n = 0;
    const d: EngineDeps = { jev: new StandInJev(), luna: new StandInModel(), sandbox: new MockSandboxProvider(tmp), store, fetch: osvDown.fetch, now: () => Date.now(), config: loadEngineConfig({}), newRunId: () => `00000000-0000-4000-8000-0000000000a${++n}` };
    const first = await runScan(req, d);
    assert.equal(first.kind, "fresh");
    if (first.kind !== "fresh") return;
    const cov = (first.report.forensics as { coverage: { complete: boolean; failed: string[] } }).coverage;
    assert.equal(cov.complete, false);
    assert.ok(cov.failed.includes("osv"), cov.failed.join(","));
    const events: ScanEvent[] = [];
    const second = await runScan(req, d, { onEvent: (e) => events.push(e) });
    assert.equal(second.kind, "fresh", "the degraded run is not the cache entry; the next request scans again");
    assert.ok(events.some((e) => e.type === "stage" && e.data.name === "cache" && /incomplete coverage/.test(e.data.detail ?? "")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("budget ledger failure fails closed: no sandbox starts", async () => {
  const store = new MemoryStore();
  store.chargeBudget = async () => {
    throw new Error("ledger unavailable");
  };
  const provider = new RefusingProvider();
  const out = await runScan(req, deps(store, provider));
  assert.equal(out.kind, "error");
  if (out.kind === "error") assert.equal(out.code, "capacity");
  assert.equal(provider.attempts, 0);
});
