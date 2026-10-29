/**
 * The existence pre-check in front of the runner sandbox (lib/server/scan-service.ts probeStored):
 * a missing GitHub repo, ref, npm package or npm version answers not_found from the request itself,
 * before any runner sandbox is created, and a private repo ends the same way with a message that
 * says so. A rate limit, an upstream error or a timeout on the check is never reported as missing:
 * the probe answers null and the request falls through to the runner (fail open).
 *
 * fetch is mocked: no live network. The store is a fake that refuses every write, so the test also
 * proves the pre-check claims no run and writes nothing.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadEngineConfig } from "../../lib/engine/config.ts";
import { probeStored, type CallerContext } from "../../lib/server/scan-service.ts";
import type { ScanEvent, ScanTarget } from "../../lib/engine/types.ts";
import type { V2Store } from "../../lib/engine/store.ts";

const ENV = {
  NEXT_PUBLIC_SITE_URL: "https://clauderabbit.in",
  NEXT_PUBLIC_SUPABASE_URL: "https://branch.supabase.test",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
  CR_V2_DATABASE_URL: "postgres://cr_v2_server.abcdefghijklmnopqrst:placeholder@127.0.0.1:1/postgres",
  OPENAI_API_KEY: "placeholder-not-a-key",
  E2B_API_KEY: "placeholder-not-a-key",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Route = (url: string) => Response | Promise<Response>;

/** Mock fetch from a URL router; records every URL asked for. */
function mockFetch(route: Route): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    return route(url);
  }) as typeof fetch;
  return seen;
}

function fakeStore(): { store: V2Store; writes: string[] } {
  const writes: string[] = [];
  const refuse = (name: string) => async () => {
    writes.push(name);
    throw new Error(`${name} must not be called by the pre-check`);
  };
  const store = {
    db: {} as V2Store["db"],
    ownerCache: { get: async () => null, put: async () => undefined },
    findCached: async () => null,
    chargeBudget: async () => true,
    claimRun: refuse("claimRun"),
    appendEvents: refuse("appendEvents"),
    saveReport: refuse("saveReport"),
    finishRun: refuse("finishRun"),
    recordUserScan: refuse("recordUserScan"),
  } as unknown as V2Store;
  return { store, writes };
}

function ctxFor(store: V2Store): CallerContext {
  return { config: loadEngineConfig(ENV), store, identity: null, caller: { surface: "web", userId: null, ip: "203.0.113.9", deviceId: null, operator: false } };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const notFound = () => new Response("Not Found", { status: 404 });

const packument = {
  name: "@acme/widget",
  "dist-tags": { latest: "1.0.0" },
  versions: { "1.0.0": { name: "@acme/widget", version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/@acme/widget/-/widget-1.0.0.tgz", integrity: "sha512-" + "A".repeat(86) + "==" } } },
  time: { created: "2024-01-01T00:00:00.000Z", "1.0.0": "2024-01-01T00:00:00.000Z" },
};

async function probe(target: ScanTarget, opts?: { lookupCache?: boolean }) {
  const { store, writes } = fakeStore();
  const events: ScanEvent[] = [];
  const line = await probeStored(ctxFor(store), target, (e) => events.push(e), opts);
  return { line, writes, events };
}

test("missing GitHub repo: not_found from the pre-check, no run claimed, says it may be private", async () => {
  mockFetch((url) => (url.startsWith("https://api.github.com/repos/thisownerdoesnotexist-zz9/nope") ? notFound() : json({}, 500)));
  const { line, writes } = await probe({ kind: "github", owner: "thisownerdoesnotexist-zz9", repo: "nope" });
  assert.ok(line && line.type === "error", "a missing repo answers an error line");
  assert.equal(line.code, "not_found");
  assert.equal(line.run_id, null);
  assert.match(line.message, /thisownerdoesnotexist-zz9\/nope was not found on GitHub, or it is private/);
  assert.equal(line.ad.kind, "house");
  assert.deepEqual(writes, []);
});

test("missing GitHub repo under the API rate limit: git's endpoint answers 404, still not_found", async () => {
  mockFetch((url) => {
    if (url.startsWith("https://api.github.com/")) return new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    if (url.startsWith("https://github.com/ghost-zz9/nope.git/info/refs")) return notFound();
    return json({}, 500);
  });
  const { line } = await probe({ kind: "github", owner: "ghost-zz9", repo: "nope" });
  assert.ok(line && line.type === "error");
  assert.equal(line.code, "not_found");
  assert.match(line.message, /or it is private/);
});

test("private GitHub repo the API can see: private_repo from the pre-check", async () => {
  mockFetch((url) => (url === "https://api.github.com/repos/acme/secret" ? json({ name: "secret", owner: { login: "acme", type: "Organization" }, default_branch: "main", private: true, visibility: "private" }) : json({}, 500)));
  const { line } = await probe({ kind: "github", owner: "acme", repo: "secret" });
  assert.ok(line && line.type === "error");
  assert.equal(line.code, "private_repo");
  assert.match(line.message, /only public repositories can be scanned/);
});

test("missing npm package (scoped): not_found from the pre-check, registry asked with the scoped encoding", async () => {
  const seen = mockFetch((url) => (url.startsWith("https://registry.npmjs.org/") ? notFound() : json({}, 500)));
  const { line, writes } = await probe({ kind: "npm", name: "@acme/does-not-exist-zz9-cr" });
  assert.ok(line && line.type === "error");
  assert.equal(line.code, "not_found");
  assert.match(line.message, /npm package "@acme\/does-not-exist-zz9-cr" is not on the public registry/);
  assert.equal(seen[0], "https://registry.npmjs.org/@acme%2Fdoes-not-exist-zz9-cr");
  assert.deepEqual(writes, []);
});

test("missing npm package (unscoped): not_found", async () => {
  mockFetch((url) => (url === "https://registry.npmjs.org/this-package-does-not-exist-zz9-cr" ? notFound() : json({}, 500)));
  const { line } = await probe({ kind: "npm", name: "this-package-does-not-exist-zz9-cr" });
  assert.ok(line && line.type === "error");
  assert.equal(line.code, "not_found");
});

test("missing version of an existing npm package: not_found naming the package and the version", async () => {
  mockFetch((url) => (url === "https://registry.npmjs.org/@acme%2Fwidget" ? json(packument) : json({}, 500)));
  const { line } = await probe({ kind: "npm", name: "@acme/widget", version: "9.9.9" });
  assert.ok(line && line.type === "error");
  assert.equal(line.code, "not_found");
  assert.match(line.message, /npm package "@acme\/widget" has no published version or dist-tag "9\.9\.9"/);
});

test("the pre-check also runs when the stored-report lookup is skipped (fresh or full scans)", async () => {
  mockFetch((url) => (url.startsWith("https://registry.npmjs.org/") ? notFound() : json({}, 500)));
  const { line } = await probe({ kind: "npm", name: "this-package-does-not-exist-zz9-cr" }, { lookupCache: false });
  assert.ok(line && line.type === "error");
  assert.equal(line.code, "not_found");
});

test("an existing target with no stored report: null, so the runner starts as before", async () => {
  mockFetch((url) => (url === "https://registry.npmjs.org/@acme%2Fwidget" ? json(packument) : json({}, 500)));
  const { line, writes } = await probe({ kind: "npm", name: "@acme/widget", version: "1.0.0" });
  assert.equal(line, null);
  assert.deepEqual(writes, []);
});

test("fail open: rate limits, upstream errors and network errors are never reported as not_found", async () => {
  const cases: Array<[string, ScanTarget, Route]> = [
    ["GitHub API and git endpoint both rate limited", { kind: "github", owner: "acme", repo: "lib" }, () => new Response("slow down", { status: 429 })],
    ["GitHub 502", { kind: "github", owner: "acme", repo: "lib" }, () => new Response("bad gateway", { status: 502 })],
    ["GitHub network error", { kind: "github", owner: "acme", repo: "lib" }, () => { throw new TypeError("fetch failed"); }],
    ["npm 429", { kind: "npm", name: "left-pad" }, () => new Response("slow down", { status: 429 })],
    ["npm 503", { kind: "npm", name: "@acme/widget", version: "1.0.0" }, () => new Response("unavailable", { status: 503 })],
    ["npm network error", { kind: "npm", name: "left-pad" }, () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [label, target, route] of cases) {
    mockFetch(route);
    const { line, writes } = await probe(target);
    assert.equal(line, null, `${label}: falls through to the runner`);
    assert.deepEqual(writes, [], `${label}: writes nothing`);
  }
});

test("POST /api/scan on the runner path: a missing npm package ends not_found without creating a runner sandbox, also for a fresh scan", async () => {
  const { POST } = await import("../../app/api/scan/route.ts");
  const saved: Record<string, string | undefined> = {};
  // The operator key skips the burst limiter, whose database is a placeholder with no listener here.
  const operatorKey = "test-operator-key-placeholder-0123456789";
  const env: Record<string, string | undefined> = { ...ENV, VERCEL_ENV: "preview", CR_SCAN_RUNNER: undefined, CR_OPERATOR_KEY: operatorKey };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const seen = mockFetch((url) => (url.startsWith("https://registry.npmjs.org/") ? notFound() : json({}, 500)));
  try {
    const started = Date.now();
    const res = await POST(new Request("https://clauderabbit.in/api/scan", { method: "POST", headers: { "Content-Type": "application/json", "x-clauderabbit-client": "cli", "x-cr-operator-key": operatorKey }, body: JSON.stringify({ target: "npm:this-package-does-not-exist-zz9-cr", fresh: true }) }));
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { type: string; code?: string; message?: string; run_id?: string | null });
    const final = lines.at(-1)!;
    assert.equal(final.type, "error");
    assert.equal(final.code, "not_found");
    assert.equal(final.run_id, null);
    assert.match(final.message ?? "", /is not on the public registry/);
    assert.ok(seen.every((u) => !/e2b/i.test(u)), `no sandbox API call: ${seen.join(", ")}`);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
