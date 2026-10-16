import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadEngineConfig } from "../../lib/engine/config.ts";
import { runScan, type EngineDeps } from "../../lib/engine/orchestrator.ts";
import type { SandboxCreateOptions, SandboxProvider, SandboxSession } from "../../lib/engine/sandbox/provider.ts";
import type { ScanEvent, ScanRequest } from "../../lib/engine/types.ts";
import { bytes, fakeFetch, json } from "../support/fake-fetch.ts";
import { MemoryStore } from "../support/memory-store.ts";
import { StandInModel } from "../support/stand-in-model.ts";
import { makeTgz } from "../support/tar.ts";

const tgz = makeTgz([
  { name: "package/package.json", data: '{"name":"orch-fixture","version":"1.0.0","main":"index.js"}' },
  { name: "package/index.js", data: "module.exports = 1;" },
]);
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
const tarball = "https://registry.npmjs.org/orch-fixture/-/orch-fixture-1.0.0.tgz";
const created = new Date(Date.now() - 400 * 86_400_000).toISOString();

const ff = fakeFetch([
  {
    match: "https://registry.npmjs.org/orch-fixture",
    respond: () => json({ name: "orch-fixture", "dist-tags": { latest: "1.0.0" }, time: { created, "1.0.0": created }, versions: { "1.0.0": { version: "1.0.0", dist: { tarball, integrity } } } }),
  },
  { match: tarball, respond: () => bytes(tgz) },
  { match: (u) => u.startsWith("https://api.npmjs.org/downloads/"), respond: () => json({ downloads: 10 }) },
  { match: "https://api.osv.dev/v1/querybatch", respond: (_u, init) => json({ results: (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries.map(() => ({})) }) },
]);

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
  return { model: new StandInModel(), sandbox, store, fetch: ff.fetch, now: () => Date.now(), config: loadEngineConfig({}), newRunId: () => `00000000-0000-4000-8000-00000000000${++n}` };
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
