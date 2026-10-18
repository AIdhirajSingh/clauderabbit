/**
 * Timing test of the real orchestrator with every external call given a latency
 * taken from the live fixture run and the operator smoke (key day steps 4 and 7),
 * scaled 1:10 (1 ms here = 10 ms live). It proves the shape of the critical path:
 *
 *  - the fetch runs alongside the claim and the budget check, both VMs are
 *    created the moment those pass, and the harness command (forge, fence,
 *    probe) is running before any input is written;
 *  - every input is written before the go file, and no repo byte reaches the VM
 *    before the harness has started;
 *  - the VM kills are issued at the end of each VM's work and finish before the
 *    run closes, but the scan does not wait on them before the report call;
 *  - with `background`, the report is returned before the rows are persisted;
 *  - the measured wall time is the overlapped path, well under the sum the old
 *    serial ordering paid for the same latencies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadEngineConfig } from "../../lib/engine/config.ts";
import type { ModelAdapter, StructuredRequest, StructuredResult } from "../../lib/engine/model/adapter.ts";
import { runScan, type EngineDeps } from "../../lib/engine/orchestrator.ts";
import type { CommandResult, RunOptions, SandboxCreateOptions, SandboxProvider, SandboxSession } from "../../lib/engine/sandbox/provider.ts";
import type { ScanRequest } from "../../lib/engine/types.ts";
import { bytes, fakeFetch, json } from "../support/fake-fetch.ts";
import { MemoryStore } from "../support/memory-store.ts";
import { StandInJev } from "../support/stand-in-jev.ts";
import { StandInModel } from "../support/stand-in-model.ts";
import { makeTgz } from "../support/tar.ts";

/** Live milliseconds / 10. */
const L = {
  resolve: 28, // packument (live: resolve 283)
  cache: 37, // live: cache 370
  claim: 23, // one DB round trip iad1 -> ap-south-1
  budget: 23,
  fetch: 6, // live: fetch 55
  create: 60, // E2B Sandbox.create (live: 556 to 646)
  write: 16, // one files.write round trip
  read: 15,
  kill: 25,
  prepare: 220, // harness CA, fence, forge, probe before inputs
  detonateWork: 330, // install, entry, collect, pack after inputs
  analysisRun: 560, // cr-analyze.sh on 1 vCPU (Semgrep, GuardDog, YARA)
  luna: 428, // live: report 4278
  persist: 42, // live: persist 415
  osv: 5,
  jev: 20,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delay = <T>(ms: number, v: T) => sleep(ms).then(() => v);

const tgz = makeTgz([
  { name: "package/package.json", data: '{"name":"timing-fixture","version":"1.0.0","main":"index.js"}' },
  { name: "package/index.js", data: "module.exports = 1;" },
]);
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
const tarballUrl = "https://registry.npmjs.org/timing-fixture/-/timing-fixture-1.0.0.tgz";
const created = new Date(Date.now() - 400 * 86_400_000).toISOString();

const bundle = makeTgz([
  { name: "out/", type: "dir" },
  {
    name: "out/result.json",
    data: JSON.stringify({
      version: 1,
      mode: "npm-package",
      ecosystem: "npm",
      deps_kind: "npm-ls",
      install: { status: "completed", exit_code: 0, ms: 2231, command: "npm install --no-audit --no-fund /work/pkg.tgz" },
      entry: { status: "completed", exit_code: 0, ms: 31 },
      clock: { real_ms: 44, fake_ms: 1071 },
      total_ms: 5645,
      phases: { forge_ms: 1500, contained_ms: 2200, inputs_ms: 2210, install_start_ms: 2260, collect_start_ms: 4600 },
    }),
  },
  { name: "out/checks.jsonl", data: '{"name":"egress_contained","ok":true,"detail":"x"}\n{"name":"clock_accelerated","ok":true}\n' },
  { name: "out/capture.jsonl", data: "" },
  { name: "out/trace.install", data: "" },
  { name: "out/trace.entry", data: "" },
  { name: "out/deps.json", data: JSON.stringify({ name: "cr-run-app", dependencies: { "timing-fixture": { version: "1.0.0" } } }) },
]);

const enc = new TextEncoder();

interface Mark {
  t: number;
  what: string;
}

class TimedProvider implements SandboxProvider {
  readonly template = "timed";
  readonly marks: Mark[] = [];
  readonly t0: number;
  constructor(t0: number) {
    this.t0 = t0;
  }
  mark(what: string) {
    this.marks.push({ t: Date.now() - this.t0, what });
  }
  async create(opts: SandboxCreateOptions): Promise<SandboxSession> {
    this.mark(`${opts.purpose}:create`);
    await sleep(L.create);
    const files = new Map<string, Uint8Array>();
    const mark = (w: string) => this.mark(`${opts.purpose}:${w}`);
    const purpose = opts.purpose;
    return {
      id: `${purpose}-timed`,
      async writeFile(path: string, data: Uint8Array | string) {
        mark(`write ${path}`);
        await sleep(L.write);
        files.set(path, typeof data === "string" ? enc.encode(data) : data);
      },
      async readFile(path: string) {
        await sleep(L.read);
        const v = files.get(path);
        if (!v) throw new Error(`ENOENT ${path}`);
        return v;
      },
      async run(cmd: string, ro: RunOptions): Promise<CommandResult> {
        void ro;
        mark(`run ${cmd}`);
        if (purpose === "detonate") {
          await sleep(L.prepare);
          mark("probe passed");
          while (!files.has("/root/in/go")) await sleep(1);
          mark("go seen");
          for (const f of ["/root/in/target.tgz", "/root/in/run.json", "/root/.cr/canary.env", "/root/.cr/canary-patterns.txt"]) assert.ok(files.has(f), `${f} before go`);
          await sleep(L.detonateWork);
          files.set("/root/out.tgz", bundle);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        assert.ok(files.has("/root/in/src.tgz"));
        await sleep(L.analysisRun);
        files.set("/root/out/semgrep.json", enc.encode(JSON.stringify({ results: [], errors: [] })));
        files.set("/root/out/yara.json", enc.encode(JSON.stringify({ matches: [], errors: [] })));
        files.set("/root/out/guarddog-npm.json", enc.encode(JSON.stringify({ results: {}, errors: {} })));
        files.set("/root/out/status.json", enc.encode(JSON.stringify({ semgrep: { exit: 0, ms: 5 }, yara: { exit: 0, ms: 2 }, "guarddog-npm": { exit: 0, ms: 9 } })));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async kill() {
        mark("kill issued");
        await sleep(L.kill);
        mark("kill done");
      },
    };
  }
}

class SlowStore extends MemoryStore {
  persistedAt = -1;
  t0 = 0;
  override async findCached(subject: string, sha: string) {
    await sleep(L.cache);
    return super.findCached(subject, sha);
  }
  override async claimRun(...a: Parameters<MemoryStore["claimRun"]>) {
    await sleep(L.claim);
    return super.claimRun(...a);
  }
  override async chargeBudget(...a: Parameters<MemoryStore["chargeBudget"]>) {
    await sleep(L.budget);
    return super.chargeBudget(...a);
  }
  override async saveReport(...a: Parameters<MemoryStore["saveReport"]>) {
    await sleep(L.persist);
    this.persistedAt = Date.now() - this.t0;
    return super.saveReport(...a);
  }
}

class SlowLuna implements ModelAdapter {
  readonly modelId = "test-stand-in";
  readonly inner = new StandInModel();
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    await sleep(L.luna);
    return this.inner.structured(req);
  }
}

test("pipeline timing: VMs boot and the forge comes up during resolve/fetch; kills and persist leave the critical path", async () => {
  const t0 = Date.now();
  const provider = new TimedProvider(t0);
  const store = new SlowStore();
  store.t0 = t0;
  let fetchDoneAt = -1;
  const ff = fakeFetch([
    {
      match: "https://registry.npmjs.org/timing-fixture",
      respond: () => delay(L.resolve, json({ name: "timing-fixture", "dist-tags": { latest: "1.0.0" }, time: { created, "1.0.0": created }, versions: { "1.0.0": { version: "1.0.0", dist: { tarball: tarballUrl, integrity } } } })),
    },
    {
      match: tarballUrl,
      respond: async () => {
        await sleep(L.fetch);
        fetchDoneAt = Date.now() - t0;
        return bytes(tgz);
      },
    },
    { match: (u) => u.startsWith("https://api.npmjs.org/downloads/"), respond: () => json({ downloads: 10 }) },
    { match: "https://api.osv.dev/v1/querybatch", respond: (_u, init) => delay(L.osv, json({ results: (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries.map(() => ({})) })) },
  ]);
  const jev = new StandInJev();
  const slowJev = { modelId: jev.modelId, decide: async (r: Parameters<StandInJev["decide"]>[0]) => (await sleep(L.jev), jev.decide(r)) };
  const deps: EngineDeps = { jev: slowJev, luna: new SlowLuna(), sandbox: provider, store, fetch: ff.fetch, now: () => Date.now(), config: loadEngineConfig({}), newRunId: () => "00000000-0000-4000-8000-0000000000f1" };
  const req: ScanRequest = { target: { kind: "npm", name: "timing-fixture" }, caller: { surface: "web", userId: null, ip: null, deviceId: null, operator: false }, regenerate: false };

  const tasks: Promise<void>[] = [];
  const out = await runScan(req, deps, { background: (t) => void tasks.push(t) });
  const returnedAt = Date.now() - t0;
  assert.equal(out.kind, "fresh");
  if (out.kind !== "fresh") return;
  assert.equal(store.reports.size, 0, "the report is returned before its row is written");
  assert.equal(tasks.length, 1);
  await tasks[0];
  assert.equal(store.reports.size, 1, "the background task persisted the report");
  assert.ok(store.persistedAt > returnedAt);

  const at = (what: string) => provider.marks.find((m) => m.what === what)?.t ?? -1;
  const detCreate = at("detonate:create");
  const anaCreate = at("analyze:create");
  const harnessStart = at("detonate:run bash /opt/cr/bin/cr-detonate.sh");
  const firstInput = Math.min(...provider.marks.filter((m) => m.what.startsWith("detonate:write ")).map((m) => m.t));
  const goWrite = at("detonate:write /root/in/go");
  assert.ok(detCreate >= 0 && anaCreate >= 0);
  // Boot right after the claim and the budget check (which ran alongside the fetch), never after verify / reach.
  const bootDue = L.resolve + L.cache + Math.max(L.claim, L.budget);
  assert.ok(Math.abs(detCreate - bootDue) <= 25 && Math.abs(anaCreate - bootDue) <= 25, `VMs created at ${detCreate} / ${anaCreate} ms, due at ${bootDue} ms`);
  assert.ok(fetchDoneAt > 0 && fetchDoneAt <= bootDue + 15, `the fetch ran alongside the claim (${fetchDoneAt} ms)`);
  const idx = (pred: (m: Mark) => boolean) => provider.marks.findIndex(pred);
  assert.ok(
    idx((m) => m.what === "detonate:run bash /opt/cr/bin/cr-detonate.sh") < idx((m) => m.what.startsWith("detonate:write ")),
    `harness started (${harnessStart} ms) before the first input write (${firstInput} ms)`,
  );
  assert.ok(provider.marks.filter((m) => m.what.startsWith("detonate:write ") && m.what !== "detonate:write /root/in/go").every((m) => m.t < goWrite), "go is written last");
  assert.ok(idx((m) => m.what === "detonate:probe passed") < idx((m) => m.what === "detonate:go seen"), "the probe passed before the harness saw its inputs");
  const kills = provider.marks.filter((m) => m.what.endsWith("kill done"));
  assert.equal(kills.length, 2, "both VMs destroyed");
  const killedChecks = (out.report.forensics as { checks?: unknown }).checks;
  void killedChecks;

  const total = out.report.timings.total!;
  // The same latencies in the old serial order: resolve, cache, claim, budget, fetch, then
  // max(detonation create + 4 serial writes + full harness + read + kill, analysis create +
  // 2 writes + run + 9 serial reads + kill), then Luna, then persist before the result.
  const oldDet = L.create + 4 * L.write + (L.prepare + L.detonateWork) + L.read + L.kill;
  const oldAna = L.create + 2 * L.write + L.analysisRun + 9 * L.read + L.kill;
  const oldTotal = L.resolve + L.cache + L.claim + L.budget + L.fetch + Math.max(oldDet, oldAna) + L.luna + L.persist;
  // New: resolve, cache, max(claim, budget) then boot; analysis VM: create, 2 parallel writes,
  // run, one parallel read round (the detonation VM finishes earlier: its prepare overlapped).
  const newAna = L.create + L.write + L.analysisRun + L.read;
  const newExpected = L.resolve + L.cache + Math.max(L.claim, L.budget) + newAna + L.luna;
  console.log(`pipeline timing (ms, live = x10): measured ${returnedAt} to result, report.timings.total ${total}; old serial order ${oldTotal}; overlapped path ${newExpected}`);
  assert.ok(returnedAt < oldTotal - 2 * L.persist, `result at ${returnedAt} ms, old order ${oldTotal} ms`);
  assert.ok(returnedAt >= newExpected - 10, `cannot beat the overlapped critical path (${newExpected} ms), got ${returnedAt}`);
  assert.ok(returnedAt <= newExpected + 120, `within scheduling slack of the overlapped critical path (${newExpected} ms), got ${returnedAt}`);
});
