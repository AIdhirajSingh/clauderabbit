/**
 * Keyless end-to-end scan (DESIGN.md section 10): runScan with the stand-in
 * model, the mock sandbox (our fixtures only, through the production forge
 * policy and the production forensic parsers) and an in-memory store. No key,
 * no network: every registry, OSV and npm API call is answered by a fake fetch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adFor, adText } from "../../lib/engine/ads.ts";
import { loadEngineConfig } from "../../lib/engine/config.ts";
import { findBanned } from "../../lib/engine/model/writer.ts";
import { runScan, type EngineDeps } from "../../lib/engine/orchestrator.ts";
import { SCAN_EVENT_TYPES, type ForgedCallData, type ScanEvent, type ScanRequest } from "../../lib/engine/types.ts";
import { fakeFetch, json, bytes } from "../support/fake-fetch.ts";
import { MemoryStore } from "../support/memory-store.ts";
import { MockSandboxProvider } from "../support/mock-sandbox.ts";
import { StandInModel } from "../support/stand-in-model.ts";
import { makeTgz } from "../support/tar.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const DAY = 86_400_000;

function fixtureTarball(name: string): { bytes: Uint8Array; integrity: string } {
  const dir = join(FIXTURES, name);
  const entries = readdirSync(dir)
    .sort()
    .map((f) => ({ name: `package/${f}`, data: readFileSync(join(dir, f)) as Uint8Array }));
  const tgz = makeTgz(entries);
  return { bytes: tgz, integrity: "sha512-" + createHash("sha512").update(tgz).digest("base64") };
}

function registry(pkg: string, tgz: { bytes: Uint8Array; integrity: string }, now: number) {
  const tarball = `https://registry.npmjs.org/${pkg}/-/${pkg}-1.0.0.tgz`;
  const created = new Date(now - 400 * DAY).toISOString();
  return {
    tarball,
    routes: [
      {
        match: `https://registry.npmjs.org/${pkg}`,
        respond: () =>
          json({
            name: pkg,
            "dist-tags": { latest: "1.0.0" },
            maintainers: [{ name: "cr-fixtures" }],
            time: { created, modified: created, "1.0.0": created },
            versions: {
              "1.0.0": {
                name: pkg,
                version: "1.0.0",
                description: "fixture",
                dist: { tarball, integrity: tgz.integrity },
                maintainers: [{ name: "cr-fixtures" }],
                _npmUser: { name: "cr-fixtures" },
              },
            },
          }),
      },
      { match: tarball, respond: () => bytes(tgz.bytes) },
      { match: `https://api.npmjs.org/downloads/point/last-week/${pkg}`, respond: () => json({ downloads: 500 }) },
    ],
  };
}

const osvRoute = {
  match: "https://api.osv.dev/v1/querybatch",
  respond: (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { queries: unknown[] };
    return json({ results: body.queries.map(() => ({})) });
  },
};

function request(name: string): ScanRequest {
  return { target: { kind: "npm", name }, caller: { surface: "cli", userId: "u-test", ip: null, deviceId: null, operator: false }, regenerate: false };
}

function deps(store: MemoryStore, sandbox: MockSandboxProvider, fetchImpl: typeof fetch): EngineDeps {
  return { model: new StandInModel(), sandbox, store, fetch: fetchImpl, now: () => Date.now(), config: loadEngineConfig({}) };
}

function assertOrdered(events: ScanEvent[]) {
  for (let i = 1; i < events.length; i++) assert.ok(events[i]!.seq > events[i - 1]!.seq, `seq ${events[i]!.seq} after ${events[i - 1]!.seq}`);
}

function noBareSafe(text: string) {
  assert.equal(/\bsafe\b/i.test(text), false, `found "safe" in: ${text}`);
  assert.deepEqual(findBanned(text), []);
}

test("keyless e2e: the phone-home fixture is caught by the forge, scored Malicious, then served from the SHA cache", { timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "cr-e2e-"));
  try {
    const now = Date.now();
    const tgz = fixtureTarball("phone-home");
    const reg = registry("cr-fixture-phone-home", tgz, now);
    const ff = fakeFetch([...reg.routes, osvRoute]);
    const store = new MemoryStore();
    const sandbox = new MockSandboxProvider(tmp);
    const d = deps(store, sandbox, ff.fetch);

    const events: ScanEvent[] = [];
    const outcome = await runScan(request("cr-fixture-phone-home"), d, { onEvent: (e) => events.push(e) });
    assert.equal(outcome.kind, "fresh", JSON.stringify(outcome));
    if (outcome.kind !== "fresh") return;
    const report = outcome.report;

    // The beacon's HTTPS POST was captured, answered by the forge and carried the canary.
    const forged = events.filter((e): e is ScanEvent & { type: "forged_call"; data: ForgedCallData } => e.type === "forged_call");
    const c2 = forged.find((e) => e.data.host === "c2.cr-fixture.invalid" && e.data.proto === "https");
    assert.ok(c2, `no forged_call for the fixture C2: ${JSON.stringify(forged.map((e) => e.data))}`);
    assert.equal(c2.data.phase, "install");
    assert.equal(c2.data.method, "POST");
    assert.equal(c2.data.tls, "intercepted");
    assert.equal(c2.data.forged_kind, "json");
    assert.ok(c2.data.canary_hits.includes("AWS_SECRET_ACCESS_KEY"), JSON.stringify(c2.data));
    assert.ok(forged.some((e) => e.data.proto === "dns" && e.data.host === "c2.cr-fixture.invalid"), "the DNS lookup reached the forge");
    assert.ok(!forged.some((e) => e.data.host === "probe.cr-fixture.invalid"), "probe traffic is harness traffic, never behaviour");

    // The fixture itself received the forged body.
    const det = sandbox.sessions.find((s) => s.opts.purpose === "detonate")!;
    const result = JSON.parse(readFileSync(join(det.record.packageDir!, "beacon-result.json"), "utf8"));
    assert.deepEqual(result, { ok: true });

    // Recorded in the forensics and in the process tree.
    const fx = report.forensics as { forged_calls: ForgedCallData[]; install: string; entry: string };
    assert.ok(fx.forged_calls.some((c) => c.host === "c2.cr-fixture.invalid" && c.canary_hits.includes("AWS_SECRET_ACCESS_KEY")));
    assert.equal(fx.install, "completed");
    assert.equal(fx.entry, "completed");
    assert.ok(events.some((e) => e.type === "process" && e.data.argv.join(" ") === "node beacon.js" && e.data.phase === "install"));

    // Verdict: dangerous, never a bare "Safe", not_verified listed.
    assert.ok(report.score <= 15, `score ${report.score}`);
    assert.equal(report.verdict, "Malicious");
    assert.equal(report.band, "red");
    assert.ok(report.breakdown.some((b) => b.code === "canary_exfiltration"));
    assert.ok(report.not_verified.length >= 3);
    noBareSafe(`${report.headline} ${report.summary}`);
    assert.equal(report.writer, "model");
    assert.equal(report.model_id, "test-stand-in");

    // One ordered stream covering all seven event types, persisted for replay.
    assertOrdered(events);
    for (const t of SCAN_EVENT_TYPES) assert.ok(events.some((e) => e.type === t), `missing event type ${t}`);
    const stored = store.events.get(outcome.runId)!;
    assert.equal(stored.length, events.length);
    assert.ok(events.filter((e) => e.type === "check" && e.data.name === "sandbox_killed").every((e) => e.type === "check" && e.data.ok));

    // Both sandboxes were fresh for this scan and destroyed after it.
    assert.equal(sandbox.sessions.length, 2);
    assert.deepEqual(sandbox.sessions.map((s) => [s.opts.purpose, s.opts.network, s.killed]).sort(), [["analyze", "none", true], ["detonate", "registry-only", true]]);

    // Every surface gets an ad with the result.
    const ad = adFor("cli", { siteUrl: d.config.siteUrl, adsense: d.config.adsense, target: { kind: "npm", name: "cr-fixture-phone-home" } });
    assert.equal(ad.kind, "house");
    assert.ok(adText(ad).includes("Sponsored"));

    // Second scan of the same SHA: cache hit, replayed events, no new sandbox.
    const replay: ScanEvent[] = [];
    const again = await runScan(request("cr-fixture-phone-home"), d, { onEvent: (e) => replay.push(e) });
    assert.equal(again.kind, "cached");
    if (again.kind !== "cached") return;
    assert.equal(again.runId, outcome.runId);
    assert.equal(again.report.score, report.score);
    assert.equal(sandbox.sessions.length, 2);
    assert.equal(replay.length, events.length);
    assert.ok(replay.every((e) => e.replayed === true && e.run_id === outcome.runId));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("keyless e2e: the quiet fixture is not dangerous and still lists what was not verified", { timeout: 120_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "cr-e2e-"));
  try {
    const tgz = fixtureTarball("quiet-lib");
    const reg = registry("cr-fixture-quiet-lib", tgz, Date.now());
    const ff = fakeFetch([...reg.routes, osvRoute]);
    const store = new MemoryStore();
    const sandbox = new MockSandboxProvider(tmp);
    const events: ScanEvent[] = [];
    const outcome = await runScan(request("cr-fixture-quiet-lib"), deps(store, sandbox, ff.fetch), { onEvent: (e) => events.push(e) });
    assert.equal(outcome.kind, "fresh", JSON.stringify(outcome));
    if (outcome.kind !== "fresh") return;
    const r = outcome.report;
    assert.ok(r.score >= 80, `score ${r.score}: ${JSON.stringify(r.breakdown)}`);
    assert.notEqual(r.verdict, "Malicious");
    assert.notEqual(r.verdict, "High risk");
    assert.notEqual(r.verdict as string, "Safe");
    assert.ok(r.not_verified.length >= 3, JSON.stringify(r.not_verified));
    assert.ok(r.not_verified.some((n) => n.startsWith("Behaviour outside the observed install and entry windows")));
    noBareSafe(`${r.headline} ${r.summary}`);
    const nonRegistry = events.filter((e) => e.type === "forged_call" && e.data.proto !== "dns");
    assert.deepEqual(nonRegistry, []);
    assert.equal((r.forensics as { install: string }).install, "completed");
    assert.ok(sandbox.sessions.every((s) => s.killed));
    assertOrdered(events);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
