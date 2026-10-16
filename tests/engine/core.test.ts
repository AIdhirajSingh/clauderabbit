import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_E2B_TEMPLATE, DEFAULT_MODEL_ID, isOperatorKey, loadEngineConfig, missingKeys } from "../../lib/engine/config.ts";
import { chunkUtf8, createRunEventBus, eventLine, splitNdjson, TRANSCRIPT_BYTES_PER_SOURCE } from "../../lib/engine/events.ts";
import { adFor, adText, badgeUrl, houseAd } from "../../lib/engine/ads.ts";
import { computeReputation, fetchGithubOwner, fetchWeeklyDownloads, maintainerChangedWithin, ownerEstablished, type OwnerCache, type OwnerInfo } from "../../lib/engine/reputation.ts";
import type { ScanEvent } from "../../lib/engine/types.ts";
import { fakeFetch, json } from "../support/fake-fetch.ts";

const OPERATOR = "o".repeat(40);

test("config: defaults, overrides and validation", () => {
  const c = loadEngineConfig({});
  assert.equal(c.modelId, DEFAULT_MODEL_ID);
  assert.equal(c.modelId, "gpt-6-luna");
  assert.equal(c.e2bTemplate, DEFAULT_E2B_TEMPLATE);
  assert.equal(c.reasoningEffort, "low");
  assert.equal(c.siteUrl, "https://clauderabbit.in");
  assert.equal(c.adsense.adtest, "on");
  assert.equal(c.operatorKey, null);
  assert.equal(c.dailySandboxSecondsCap, 20_000);
  assert.equal(c.dailyModelTokensCap, 20_000_000);
  assert.deepEqual(missingKeys(c), ["OPENAI_API_KEY", "E2B_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
  const o = loadEngineConfig({
    CR_MODEL_ID: "other-model",
    CR_MODEL_REASONING_EFFORT: "high",
    CR_E2B_TEMPLATE: "tpl",
    OPENAI_API_KEY: "k1",
    E2B_API_KEY: "k2",
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "legacy",
    NEXT_PUBLIC_SITE_URL: "https://preview.example/path",
    NEXT_PUBLIC_ADSENSE_TEST: "OFF",
    CR_OPERATOR_KEY: OPERATOR,
    CR_DAILY_SANDBOX_SECONDS_CAP: "100",
  });
  assert.equal(o.modelId, "other-model");
  assert.equal(o.reasoningEffort, "high");
  assert.equal(o.supabaseSecretKey, "legacy");
  assert.equal(o.siteUrl, "https://preview.example");
  assert.equal(o.adsense.adtest, "off");
  assert.equal(o.dailySandboxSecondsCap, 100);
  assert.deepEqual(missingKeys(o), []);
  assert.equal(isOperatorKey(o, OPERATOR), true);
  assert.equal(isOperatorKey(o, OPERATOR.slice(1) + "x"), false);
  assert.equal(isOperatorKey(o, null), false);
  assert.equal(loadEngineConfig({ CR_OPERATOR_KEY: "short" }).operatorKey, null);
  assert.throws(() => loadEngineConfig({ CR_MODEL_REASONING_EFFORT: "turbo" }));
  assert.throws(() => loadEngineConfig({ CR_DAILY_MODEL_TOKENS_CAP: "-5" }));
  assert.throws(() => loadEngineConfig({ NEXT_PUBLIC_SITE_URL: "not a url" }));
});

test("events: seq strictly increases, t_ms is relative, listeners get every event", () => {
  let now = 1000;
  const seen: ScanEvent[] = [];
  const bus = createRunEventBus({ runId: "r1", startedAt: 1000, now: () => now, listeners: [(e) => seen.push(e), () => { throw new Error("closed socket"); }] });
  bus.emit({ type: "stage", data: { name: "resolve", status: "start" } });
  now = 1250;
  bus.emit({ type: "timing", data: { name: "resolve", ms: 250 } });
  assert.deepEqual(seen.map((e) => [e.seq, e.t_ms, e.type, e.run_id]), [
    [1, 0, "stage", "r1"],
    [2, 250, "timing", "r1"],
  ]);
});

test("events: cap of 600 per run with one events_truncated check", async () => {
  const persisted: ScanEvent[] = [];
  const bus = createRunEventBus({ runId: "r", startedAt: 0, now: () => 0, persist: async (b) => void persisted.push(...b) });
  for (let i = 0; i < 700; i++) bus.emit({ type: "process", data: { phase: "install", pid: i, ppid: 1, argv: ["x"] } });
  bus.emit({ type: "check", data: { name: "late", ok: true } });
  await bus.close();
  const all = bus.events();
  assert.equal(all.length, 600);
  const last = all[599]!;
  assert.equal(last.type, "check");
  assert.equal((last.data as { name: string }).name, "events_truncated");
  assert.match((last.data as { detail: string }).detail, /process=101, check=1/);
  assert.deepEqual(persisted.map((e) => e.seq), all.map((e) => e.seq));
  for (let i = 1; i < all.length; i++) assert.ok(all[i]!.seq > all[i - 1]!.seq);
  bus.emit({ type: "check", data: { name: "after close", ok: true } });
  assert.equal(bus.events().length, 600);
});

test("events: transcripts are chunked to 4 KiB and capped per source", () => {
  const bus = createRunEventBus({ runId: "r", startedAt: 0, now: () => 0 });
  bus.transcript("install", "stdout", "a".repeat(10_000));
  const t = bus.events().filter((e) => e.type === "transcript");
  assert.deepEqual(t.map((e) => (e.data as { text: string }).text.length), [4096, 4096, 1808]);
  bus.transcript("install", "stdout", "b".repeat(TRANSCRIPT_BYTES_PER_SOURCE));
  const checks = bus.events().filter((e) => e.type === "check");
  assert.equal(checks.length, 1);
  const bytes = bus.events().filter((e) => e.type === "transcript").reduce((s, e) => s + (e.data as { text: string }).text.length, 0);
  assert.equal(bytes, TRANSCRIPT_BYTES_PER_SOURCE);
  bus.transcript("install", "stdout", "more");
  assert.equal(bus.events().filter((e) => e.type === "transcript").reduce((s, e) => s + (e.data as { text: string }).text.length, 0), TRANSCRIPT_BYTES_PER_SOURCE);
});

test("events: chunkUtf8 never splits a code point; NDJSON round trip", () => {
  const parts = chunkUtf8("é".repeat(5) + "\u{1F600}", 4);
  assert.deepEqual(parts, ["éé", "éé", "é", "\u{1F600}"]);
  const bus = createRunEventBus({ runId: "r", startedAt: 0, now: () => 0 });
  bus.emit({ type: "check", data: { name: "x", ok: true } });
  const line = eventLine(bus.events()[0]!);
  const { values, rest } = splitNdjson(line + line + '{"partial":');
  assert.equal(values.length, 2);
  assert.equal(rest, '{"partial":');
  assert.deepEqual(values[0], { type: "event", event: bus.events()[0] });
});

test("events: persistence errors are reported, never thrown into emit", async () => {
  const errors: unknown[] = [];
  const bus = createRunEventBus({ runId: "r", startedAt: 0, now: () => 0, persist: async () => { throw new Error("db down"); }, onPersistError: (e) => errors.push(e) });
  bus.emit({ type: "check", data: { name: "x", ok: true } });
  await bus.close();
  assert.equal(errors.length, 1);
});

test("ads: web gets AdSense test mode when both ids are set, else house; CLI and MCP get house", () => {
  const adsense = { clientId: "ca-pub-1234567890123456", slotId: "1234567890", adtest: "on" as const };
  const target = { kind: "github" as const, name: "octo/cat" };
  assert.deepEqual(adFor("web", { siteUrl: "https://clauderabbit.in", adsense, target }), {
    kind: "adsense",
    placement: "scan_result",
    client: "ca-pub-1234567890123456",
    slot: "1234567890",
    format: "auto",
    adtest: "on",
  });
  for (const s of ["cli", "mcp", "mcp-remote"] as const) {
    const ad = adFor(s, { siteUrl: "https://clauderabbit.in", adsense, target });
    assert.equal(ad.kind, "house");
    if (ad.kind === "house") assert.equal(ad.url, "https://clauderabbit.in/badge/octo/cat");
  }
  assert.equal(adFor("web", { siteUrl: "https://clauderabbit.in", adsense: { ...adsense, slotId: null }, target }).kind, "house");
  assert.equal(adFor("web", { siteUrl: "https://clauderabbit.in", adsense: { ...adsense, clientId: "bogus" }, target }).kind, "house");
  assert.equal(badgeUrl("https://x.example/", { kind: "npm", name: "@s/p" }), "https://x.example/badge/npm/%40s%2Fp");
  const generic = houseAd("https://x.example", null);
  assert.equal(generic.kind === "house" && generic.url, "https://x.example/");
  assert.match(adText(houseAd("https://x.example", target)), /^\[Sponsored\] /);
});

const NOW = Date.parse("2026-10-16T00:00:00Z");
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

test("reputation: maintainer change window", () => {
  const hist = (rows: Array<[number, string[]]>) => rows.map(([d, m], i) => ({ version: `1.0.${i}`, publishedAt: iso(d), maintainers: m }));
  assert.equal(maintainerChangedWithin([], NOW), null);
  assert.equal(maintainerChangedWithin(hist([[400, ["a"]], [10, ["a"]]]), NOW), false);
  assert.equal(maintainerChangedWithin(hist([[400, ["a"]], [10, ["a", "mallory"]]]), NOW), true);
  assert.equal(maintainerChangedWithin(hist([[400, ["A", "b"]], [10, ["b", "a"]]]), NOW), false);
  assert.equal(maintainerChangedWithin(hist([[5, ["a"]], [2, ["b"]]]), NOW), false);
  assert.equal(maintainerChangedWithin(hist([[400, ["a"]], [100, ["b"]]]), NOW), false);
});

test("reputation: owner lookup uses the cache first and stores live answers", async () => {
  const store = new Map<string, OwnerInfo>();
  const cache: OwnerCache = { get: async (l) => store.get(l) ?? null, put: async (i) => void store.set(i.login, i) };
  const f = fakeFetch([{ match: "https://api.github.com/users/octo", respond: () => json({ login: "octo", type: "User", created_at: iso(800), public_repos: 9 }) }]);
  const a = await fetchGithubOwner("octo", { fetch: f.fetch, timeoutMs: 1000 }, cache);
  const b = await fetchGithubOwner("octo", { fetch: f.fetch, timeoutMs: 1000 }, cache);
  assert.deepEqual(a, b);
  assert.equal(f.calls.length, 1);
  assert.equal(ownerEstablished(a!, NOW), true);
  const down = fakeFetch([{ match: () => true, respond: () => json({}, 500) }]);
  assert.equal(await fetchGithubOwner("x", { fetch: down.fetch, timeoutMs: 1000 }), null);
  assert.equal(await fetchWeeklyDownloads("x", { fetch: down.fetch, timeoutMs: 1000 }), null);
  const dl = fakeFetch([{ match: "https://api.npmjs.org/downloads/point/last-week/@s%2Fp", respond: () => json({ downloads: 123 }) }]);
  assert.equal(await fetchWeeklyDownloads("@s/p", { fetch: dl.fetch, timeoutMs: 1000 }), 123);
});

test("reputation: signals and unavailable sources are reported separately", () => {
  const r = computeReputation(
    {
      owner: { login: "newbie", type: "User", createdAt: iso(10), publicRepos: 0 },
      ownerLookedUp: true,
      npm: {
        name: "p",
        version: "1.0.0",
        tarballUrl: "",
        integrity: null,
        shasum: null,
        description: null,
        license: null,
        scripts: {},
        repositoryUrl: null,
        publisher: null,
        maintainers: ["newbie"],
        firstPublishedAt: iso(3),
        publishedAt: iso(3),
        versionCount: 1,
        history: [],
      },
      weeklyDownloads: null,
    },
    NOW,
  );
  assert.equal(r.ownerAgeDays, 10);
  assert.equal(r.ownerEstablished, false);
  assert.equal(r.npmFirstPublishDays, 3);
  assert.equal(r.weeklyDownloads, null);
  assert.deepEqual(r.unavailable, ["npm download counts"]);
  const gh = computeReputation({ owner: { login: "octo", type: "User", createdAt: iso(4000), publicRepos: 40 }, ownerLookedUp: true, repoStars: 1234 }, NOW);
  assert.equal(gh.repoStars, 1234);
  assert.ok(gh.evidence.includes("GitHub repository stars: 1234"));
  assert.equal(computeReputation({ ownerLookedUp: false }, NOW).repoStars, null);
  const failed = computeReputation({ owner: null, ownerLookedUp: true }, NOW);
  assert.deepEqual(failed.unavailable, ["GitHub owner history (lookup failed)"]);
  assert.equal(failed.ownerAgeDays, null);
});
