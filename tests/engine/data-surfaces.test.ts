/**
 * Data and surface seams (DESIGN.md sections 4, 6, 7.3, 8): the reports-row
 * mapping and its round trip back to a ReportPayload, event row mapping,
 * V2Store against PGlite with every migration applied (as cr_v2_server), auth
 * and rate-limit wrappers on the same database and on stubs, request parsing, report URLs, the branch script's
 * production refusal, and the remote MCP text rendering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerToken, identify, identityBackend } from "../../lib/engine/auth.ts";
import { CostMeter } from "../../lib/engine/cost.ts";
import { bucketFor, checkRateLimit, clientIp, GLOBAL_ANON_BUCKET_KEY } from "../../lib/engine/ratelimit.ts";
import { eventFromRow, eventToRow, OWNER_TTL_MS, payloadFromRows, reportsRowFor, V2Store, type ReportRecord, type StoredReportRow } from "../../lib/engine/store.ts";
import { openV2Database } from "../support/pglite-v2.ts";
import type { SqlExecutor } from "../../lib/engine/db.ts";
import type { Ad, ReportPayload, ScanEvent } from "../../lib/engine/types.ts";
import { finalLineText } from "../../lib/server/report-text.ts";
import { parseScanBody, realtimeChannel, replaySubject, reportUrlFor, statusFor, surfaceFromHeader } from "../../lib/server/scan-service.ts";
import { pkceMatches } from "../../lib/server/oauth.ts";
import { createHash } from "node:crypto";

const PAYLOAD: ReportPayload = {
  run_id: "11111111-1111-4111-8111-111111111111",
  target: "acme/lib",
  commit_sha: "a".repeat(40),
  score: 12,
  verdict: "Malicious",
  band: "red",
  summary: "The postinstall hook sent the AWS canary to a remote host.",
  headline: "Exfiltrates credentials at install",
  evidence: { behaviour: ["POST http://c2.cr-fixture.invalid/collect carried the AWS canary"], code: ["postinstall runs beacon.js"], reputation: ["owner account is 3 days old"] },
  breakdown: [{ group: "behaviour", code: "canary_exfil", points: -70, detail: "canary left the VM" }],
  not_verified: ["Behaviour outside the observed install and entry windows."],
  luna_report: { what_ran: "We installed the package in a throwaway sandbox; its postinstall sent a planted key out.", what_matters: "Malicious, 12/100. Do not install it." },
  forensics: { version: 2, forged_calls: 1 },
  packages: { installed: [], malicious: [], advisories: [] },
  model_id: "gpt-6-luna",
  template: "clauderabbit-detonate",
  timings: { detonate: 4100, score: 1 },
  writer: "model",
};

const RECORD: ReportRecord = {
  runId: PAYLOAD.run_id,
  targetKind: "github",
  subject: "acme/lib",
  ownerLogin: "acme",
  repoName: "lib",
  commitSha: PAYLOAD.commit_sha,
  report: PAYLOAD,
  packages: PAYLOAD.packages,
  risky: [
    { source: "semgrep", rule: "child-process-exec", severity: "high", file: "beacon.js", line: 3, message: "exec of a remote string", reach: "install" },
    { check: "install", question: "file_0", file: "package.json", line: null, severity: "medium", verdict: "suspicious", probability: 0.71, title: "Jev judged install-time code in package.json suspicious", evidence: ["package.json (install surface) p=0.71"], reach: "install" },
  ],
  logs: [{ name: "detonate", ms: 4100 }],
  stats: { files: 4, forged_calls: 1, processes: 3 },
};

test("reportsRowFor writes the 2.0 reports row with behaviour, code and reputation kept apart", () => {
  const row = reportsRowFor(RECORD);
  assert.equal(row.scan_path, "run");
  assert.equal(row.deep, true);
  assert.equal(row.cached, false);
  assert.equal(row.run_id, PAYLOAD.run_id);
  assert.deepEqual(row.not_verified, PAYLOAD.not_verified);
  assert.deepEqual(row.score_breakdown, PAYLOAD.breakdown);
  assert.deepEqual(row.risky_json.map((r) => r.kind), ["behavior", "code", "code", "rep"]);
  assert.deepEqual(row.risky_json.map((r) => r.severity), ["high", "high", "med", "low"]);
  assert.deepEqual(row.logs_json, [{ ch: "detonate", kind: "ok", lines: ["4100 ms"] }]);
  assert.equal(row.stats_json.headline, PAYLOAD.headline);
});

test("payloadFromRows rebuilds the ReportPayload the API served", () => {
  const row = reportsRowFor(RECORD);
  const stored: StoredReportRow = { id: 7, commit_sha: row.commit_sha, score: row.score, verdict: row.verdict, summary: row.summary, stats_json: row.stats_json, packages_json: row.packages_json, forensics_json: row.forensics_json, run_id: row.run_id, score_breakdown: row.score_breakdown, not_verified: row.not_verified };
  const back = payloadFromRows(stored, { id: PAYLOAD.run_id, subject: "acme/lib", model_id: "gpt-6-luna", template: "clauderabbit-detonate", timings: PAYLOAD.timings });
  assert.deepEqual(back, PAYLOAD);
  assert.throws(() => payloadFromRows({ ...stored, verdict: "Safe" }, { id: PAYLOAD.run_id, subject: "acme/lib", model_id: null, template: null, timings: {} }), /outside the 2.0 set/);
});

test("event rows map both ways and unknown types are dropped", () => {
  const e: ScanEvent = { run_id: PAYLOAD.run_id, seq: 3, t_ms: 12.6, type: "check", data: { name: "x", ok: true } };
  const row = eventToRow(e);
  assert.equal(row.t_ms, 13);
  assert.deepEqual(eventFromRow(row), { ...e, t_ms: 13 });
  assert.equal(eventFromRow({ ...row, type: "bogus" }), null);
});

test("V2Store on schema v2 as cr_v2_server: claim, dedup, events, report, cache, budget, owners", async () => {
  const v2 = await openV2Database();
  try {
    let now = Date.parse("2026-10-18T10:00:00.000Z");
    const store = new V2Store(v2.server, () => now);
    const claim = { runId: PAYLOAD.run_id, targetKind: "github" as const, subject: "acme/lib", commitSha: PAYLOAD.commit_sha, modelId: "gpt-6-luna", template: "clauderabbit-detonate" };
    assert.deepEqual(await store.claimRun(claim), { status: "claimed", runId: PAYLOAD.run_id });
    assert.deepEqual(await store.claimRun({ ...claim, runId: "22222222-2222-4222-8222-222222222222" }), { status: "running", runId: PAYLOAD.run_id });

    const events: ScanEvent[] = [
      { run_id: PAYLOAD.run_id, seq: 0, t_ms: 1, type: "stage", data: { name: "resolve", status: "start" } },
      { run_id: PAYLOAD.run_id, seq: 1, t_ms: 9.6, type: "check", data: { name: "daily_budget", ok: true } },
    ];
    await store.appendEvents(events);
    const sent = await v2.pg.query<{ topic: string; event: string }>("select topic, event from realtime.sent order by event");
    assert.deepEqual(sent.rows.map((r) => r.topic), [`scan:${PAYLOAD.run_id}`, `scan:${PAYLOAD.run_id}`]);

    assert.equal(await store.findCached("acme/lib", PAYLOAD.commit_sha), null, "a running run is not a cache hit");
    await store.saveReport(RECORD);
    await store.finishRun(PAYLOAD.run_id, { status: "done", timings: PAYLOAD.timings });
    const hit = await store.findCached("acme/lib", PAYLOAD.commit_sha);
    assert.ok(hit);
    assert.equal(hit.runId, PAYLOAD.run_id);
    assert.deepEqual(hit.report, PAYLOAD);
    assert.deepEqual(hit.events, [events[0], { ...events[1]!, t_ms: 10 }]);
    assert.deepEqual(await store.loadRun(PAYLOAD.run_id), { id: PAYLOAD.run_id, subject: "acme/lib", commit_sha: PAYLOAD.commit_sha, status: "done", error_code: null });

    // A regenerate overwrites the shared row: the old run is no longer served from it.
    const run2 = "44444444-4444-4444-8444-444444444444";
    assert.deepEqual(await store.claimRun({ ...claim, runId: run2 }), { status: "claimed", runId: run2 });
    const meter = new CostMeter({ jevModel: "typesafe-ai/jev", lunaModel: "gpt-6-luna" });
    meter.recordJev("check.install", { inputTokens: 3000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
    meter.recordLuna("report", { inputTokens: 2400, outputTokens: 280, cachedInputTokens: 2048, cacheWriteTokens: 0 });
    const ledger = meter.ledger(58.2);
    await store.saveReport({ ...RECORD, runId: run2, report: { ...PAYLOAD, run_id: run2, score: 40, verdict: "High risk", band: "yellow", jev_model_id: "typesafe-ai/jev", cost: ledger } });
    now += 60_000;
    await store.finishRun(run2, { status: "done", timings: {}, cost: ledger });
    const again = await store.findCached("acme/lib", PAYLOAD.commit_sha);
    assert.equal(again?.runId, run2);
    assert.equal(again?.report.verdict, "High risk");
    assert.deepEqual(again?.report.cost, ledger, "the ledger round-trips through v2.scan_runs.cost");
    assert.equal(again?.report.jev_model_id, "typesafe-ai/jev");
    const costRow = await v2.pg.query<{ cost: { total_usd: number; luna: { cached_input_tokens: number } } }>("select cost from v2.scan_runs where id = $1::uuid", [run2]);
    assert.equal(costRow.rows[0]!.cost.total_usd, ledger.total_usd);
    assert.equal(costRow.rows[0]!.cost.luna.cached_input_tokens, 2048);
    assert.equal((await v2.pg.query<{ n: number }>("select count(*)::int as n from v2.reports")).rows[0]!.n, 1);

    // Signed-in history: the claiming user is on the run row; guests are null; every result lands in user_scans.
    const user = "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b";
    const run3 = "55555555-5555-4555-8555-555555555555";
    assert.deepEqual(await store.claimRun({ ...claim, runId: run3, commitSha: "b".repeat(40), userId: user }), { status: "claimed", runId: run3 });
    const owners = await v2.pg.query<{ id: string; user_id: string | null }>("select id::text as id, user_id::text as user_id from v2.scan_runs order by started_at, id");
    assert.deepEqual(owners.rows.find((r) => r.id === run3)?.user_id, user);
    assert.equal(owners.rows.find((r) => r.id === PAYLOAD.run_id)?.user_id, null, "a guest run stores no user");
    assert.deepEqual(await store.listUserScans(user), [], "nothing until a result is received");
    now += 1000;
    await store.recordUserScan(user, run2);
    now += 1000;
    await store.recordUserScan(user, run3);
    now += 1000;
    await store.recordUserScan(user, run2);
    const history = await store.listUserScans(user, 10);
    assert.deepEqual(history.map((h) => [h.run_id, h.subject, h.score, h.verdict]), [
      [run2, "acme/lib", 40, "High risk"],
      [run3, "acme/lib", null, null],
    ], "newest first, one entry per run, a run without a report row has no score yet");
    assert.equal(history[0]!.scanned_at, new Date(now).toISOString());
    assert.deepEqual(await store.listUserScans("not-a-uuid"), []);
    await assert.rejects(store.recordUserScan("not-a-uuid", run2), /must be uuids/);
    const broadcasts = await v2.pg.query<{ n: number }>("select count(*)::int as n from realtime.sent where topic = 'board' and event = 'report'");
    assert.equal(broadcasts.rows[0]!.n, 2, "each report write reached the board");

    assert.equal(await store.chargeBudget({ sandboxSeconds: 9.4, tokens: 100, capSeconds: 20000, capTokens: 20000000 }), true);
    assert.equal(await store.chargeBudget({ sandboxSeconds: 0, tokens: 0, capSeconds: 9, capTokens: 20000000 }), false);

    assert.equal(await store.ownerCache.get("acme"), null);
    await store.ownerCache.put({ login: "acme", type: "Organization", createdAt: "2015-01-02T03:04:05.000Z", publicRepos: 12 });
    assert.deepEqual(await store.ownerCache.get("acme"), { login: "acme", type: "Organization", createdAt: "2015-01-02T03:04:05.000Z", publicRepos: 12 });
    now += OWNER_TTL_MS + 1;
    assert.equal(await store.ownerCache.get("acme"), null, "expired owner rows are refetched");

    await assert.rejects(store.finishRun("not-a-uuid", { status: "done", timings: {} }), /scan_runs finish: /);
    const legacy = await v2.pg.query<{ n: number }>("select (select count(*) from public.reports)::int + (select count(*) from public.owners)::int as n");
    assert.equal(legacy.rows[0]!.n, 0, "nothing lands in the 1.0 tables");
  } finally {
    await v2.close();
  }
});

test("auth: bearer parsing, cr_cli_ tokens via v2.verify_cli_token, malformed tokens never reach the database", async () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  const v2 = await openV2Database();
  try {
    const uid = (await v2.pg.query<{ id: string }>("insert into auth.users (email) values ('a@example.test') returning id::text as id")).rows[0]!.id;
    const token = (await v2.server.query<{ t: string }>("select v2.issue_cli_token($1::uuid) as t", [uid]))[0]!.t;
    let jwtCalls = 0;
    let dbCalls = 0;
    const counted: SqlExecutor = { query: <T,>(t: string, p?: readonly unknown[]) => { dbCalls++; return v2.server.query<T>(t, p); } };
    const backend = identityBackend(counted, { supabaseUrl: null, supabasePublishableKey: null });
    const withJwt = { cliToken: backend.cliToken, jwtUser: async () => { jwtCalls++; return null; } };
    assert.deepEqual(await identify(withJwt, token), { userId: uid, via: "cli_token" });
    assert.equal(await identify(withJwt, "cr_cli_" + "f".repeat(64)), null);
    assert.equal(await identify(withJwt, "cr_cli_short"), null);
    assert.equal(dbCalls, 2, "the malformed token never reached the database");
    assert.equal(await identify(withJwt, "a.b.c"), null);
    assert.equal(jwtCalls, 1);
    assert.equal(await identify(withJwt, null), null);
    assert.equal(await backend.jwtUser("a.b.c"), null, "no Auth server configured: no JWT identity");
  } finally {
    await v2.close();
  }
});

test("rate limit: Vercel client IP, bucket choice, decision, fail-open with the reason", async () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  assert.equal(clientIp(h({ "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIp(h({ "x-real-ip": "2001:db8::1" })), "2001:db8::1");
  assert.equal(clientIp(h({ "x-forwarded-for": "not-an-ip" })), null);
  assert.equal(bucketFor({ userId: "u1", ip: "1.2.3.4" }).key, "user:u1");
  assert.equal(bucketFor({ userId: null, ip: null }).key, GLOBAL_ANON_BUCKET_KEY);
  const rows = (r: unknown[]) => ({ query: async () => r }) as never;
  const denied = await checkRateLimit(rows([{ allowed: false, current_count: 21, retry_after: 17 }]), { userId: null, ip: "1.2.3.4" });
  assert.deepEqual(denied, { allowed: false, retryAfter: 17, bucket: "ip:1.2.3.4" });
  const anonDown = await checkRateLimit({ query: async () => { throw new Error("db down"); } } as never, { userId: null, ip: "1.2.3.4" });
  assert.equal(anonDown.allowed, false, "anonymous callers fail closed while the limiter is down");
  assert.equal(anonDown.retryAfter, 30);
  assert.equal(anonDown.limiterError, "db down");
  const userDown = await checkRateLimit({ query: async () => { throw new Error("socket closed"); } } as never, { userId: "u1", ip: "1.2.3.4" });
  assert.equal(userDown.allowed, true, "signed-in callers pass; the fail-closed budget ledger still bounds spend");
  assert.equal(userDown.limiterError, "socket closed");
  const empty = await checkRateLimit(rows([]), { userId: null, ip: "1.2.3.4" });
  assert.equal(empty.allowed, false);

  const v2 = await openV2Database();
  try {
    const caller = { userId: null, ip: "198.51.100.7" };
    for (let i = 0; i < 20; i++) assert.equal((await checkRateLimit(v2.server, caller)).allowed, true, `request ${i + 1}`);
    const over = await checkRateLimit(v2.server, caller);
    assert.equal(over.allowed, false);
    assert.ok(over.retryAfter >= 1 && over.retryAfter <= 60);
  } finally {
    await v2.close();
  }
});

test("request parsing accepts every documented target form and rejects the rest", () => {
  const ok = (b: unknown) => {
    const r = parseScanBody(b);
    assert.ok(r.ok, JSON.stringify(b));
    return r.ok ? r.target : null;
  };
  assert.deepEqual(ok({ target: "acme/lib" }), { kind: "github", owner: "acme", repo: "lib" });
  assert.deepEqual(ok({ target: "github:acme/lib", ref: "v1" }), { kind: "github", owner: "acme", repo: "lib", ref: "v1" });
  assert.deepEqual(ok({ target: "https://github.com/acme/lib" }), { kind: "github", owner: "acme", repo: "lib" });
  assert.deepEqual(ok({ target: "npm:left-pad@1.3.0" }), { kind: "npm", name: "left-pad", version: "1.3.0" });
  assert.deepEqual(ok({ target: "@scope/pkg" }), { kind: "npm", name: "@scope/pkg" });
  assert.deepEqual(ok({ ecosystem: "npm", package: "left-pad" }), { kind: "npm", name: "left-pad" });
  assert.deepEqual(ok({ ecosystem: "github", owner: "acme", repo: "lib", ref: "main" }), { kind: "github", owner: "acme", repo: "lib", ref: "main" });
  for (const bad of [null, [], {}, { target: "" }, { target: "not a target!" }, { ecosystem: "npm", package: "Bad Name" }]) assert.equal(parseScanBody(bad).ok, false);
  const tarball = parseScanBody({ target: "tarball:x" });
  assert.equal(tarball.ok && tarball.target.kind === "tarball", false);
  const sri = "sha256-" + createHash("sha256").update("x").digest("base64");
  const op = parseScanBody({ ecosystem: "tarball", url: "https://files.example/pkg-1.0.tar.gz", integrity: sri, label: "pypi/pkg@1.0" });
  assert.ok(op.ok && op.target.kind === "tarball" && op.target.integrity === sri);
  assert.equal(parseScanBody({ ecosystem: "tarball", url: "http://files.example/x.tgz", integrity: sri, label: "x" }).ok, false);
  assert.equal(parseScanBody({ ecosystem: "tarball", url: "https://files.example/x.tgz", integrity: "md5-x", label: "x" }).ok, false);
});

test("surfaces: headers, report URLs, replay subjects, realtime topic, status codes", () => {
  assert.equal(surfaceFromHeader("cli"), "cli");
  assert.equal(surfaceFromHeader("mcp"), "mcp");
  assert.equal(surfaceFromHeader("mcp-remote"), "web");
  assert.equal(surfaceFromHeader(null), "web");
  assert.equal(reportUrlFor("https://clauderabbit.in/x", { kind: "github", owner: "acme", repo: "lib" }), "https://clauderabbit.in/acme/lib");
  assert.equal(reportUrlFor("https://clauderabbit.in", { kind: "npm", name: "@scope/pkg" }), "https://clauderabbit.in/npm/%40scope/pkg");
  assert.equal(replaySubject("github:acme/lib"), "acme/lib");
  assert.equal(replaySubject("npm:@scope/pkg"), "npm:@scope/pkg");
  assert.equal(replaySubject("???"), null);
  assert.equal(realtimeChannel(PAYLOAD.run_id), `scan:${PAYLOAD.run_id}`);
  assert.equal(statusFor("rate_limited"), 429);
  assert.equal(statusFor("unauthorized"), 401);
  assert.equal(statusFor("invalid_target"), 400);
  assert.equal(statusFor("budget_exhausted"), 503);
});

test("OAuth PKCE S256 check", () => {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(pkceMatches(verifier, challenge), true);
  assert.equal(pkceMatches(verifier, challenge + "x"), false);
  assert.equal(pkceMatches("short", challenge), false);
});

test("remote MCP text: verdict, score, points taken off, evidence groups, not verified, URL, no ad; never a bare Safe", () => {
  const ad: Ad = { kind: "house", placement: "scan_result", id: "house-badge-v1", label: "Sponsored", headline: "Show this scan on acme/lib", body: "Add the badge.", url: "https://clauderabbit.in/badge/acme/lib" };
  const text = finalLineText({ type: "result", outcome: "fresh", run_id: PAYLOAD.run_id, report: PAYLOAD, report_url: "https://clauderabbit.in/acme/lib", ad, cost: null });
  assert.match(text, /Verdict: Malicious \(score 12\/100\)/);
  assert.match(text, /Observed when the code ran \(behaviour\):\n- POST/);
  assert.match(text, /Reputation signals \(separate from code and behaviour\):/);
  assert.match(text, /Not verified:\n- Behaviour outside/);
  assert.match(text, /Full report: https:\/\/clauderabbit\.in\/acme\/lib/);
  assert.doesNotMatch(text, /Sponsored/);
  assert.doesNotMatch(text, /\bSafe\b/);
  const err = finalLineText({ type: "error", code: "unauthorized", message: "sign in first", run_id: null, ad, signInUrl: "https://clauderabbit.in/cli-auth" });
  assert.match(err, /Sign in: https:\/\/clauderabbit\.in\/cli-auth/);
  assert.doesNotMatch(err, /Sponsored/);
});

test("oauth code grant: redirect_uri required when it was registered, client_id must match, verifier must match", async () => {
  const { codeGrantError, base64Url } = await import("../../lib/server/oauth.ts");
  const { createHash } = await import("node:crypto");
  const verifier = "v".repeat(43);
  const row = { client_id: "client-a", redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: base64Url(createHash("sha256").update(verifier).digest()), expires_at: new Date(Date.now() + 60_000).toISOString() };
  const ok = { clientId: "client-a", redirectUri: row.redirect_uri, verifier };
  assert.equal(codeGrantError(row, ok, Date.now()), null);
  assert.equal(codeGrantError(row, { ...ok, redirectUri: "" }, Date.now()), "invalid_grant", "omitting redirect_uri is refused");
  assert.equal(codeGrantError(row, { ...ok, redirectUri: "https://evil.example/cb" }, Date.now()), "invalid_grant");
  assert.equal(codeGrantError(row, { ...ok, clientId: "client-b" }, Date.now()), "invalid_client");
  assert.equal(codeGrantError(row, { ...ok, clientId: "" }, Date.now()), "invalid_client", "omitting client_id is refused");
  assert.equal(codeGrantError(row, { ...ok, verifier: "w".repeat(43) }, Date.now()), "invalid_grant");
  assert.equal(codeGrantError(row, ok, Date.now() + 120_000), "invalid_grant", "expired");
});

test("a report scored under the current rules survives the store and is still a cache hit", async () => {
  const { SCORE_RULES } = await import("../../lib/engine/score.ts");
  const { cachedCoverageComplete } = await import("../../lib/engine/orchestrator.ts");
  const payload: ReportPayload = { ...PAYLOAD, score_rules: SCORE_RULES, forensics: { coverage: { complete: true, failed: [], timed_out: [] } } };
  const row = reportsRowFor({ ...RECORD, report: payload });
  const stored: StoredReportRow = { id: 8, commit_sha: row.commit_sha, score: row.score, verdict: row.verdict, summary: row.summary, stats_json: row.stats_json, packages_json: row.packages_json, forensics_json: row.forensics_json, run_id: row.run_id, score_breakdown: row.score_breakdown, not_verified: row.not_verified };
  const back = payloadFromRows(stored, { id: PAYLOAD.run_id, subject: "acme/lib", model_id: "gpt-6-luna", template: "clauderabbit-detonate", timings: PAYLOAD.timings });
  assert.equal(back.score_rules, SCORE_RULES);
  assert.equal(cachedCoverageComplete(back), true, "read back from the database it must still serve as a hit");
  assert.equal(cachedCoverageComplete({ ...back, score_rules: SCORE_RULES - 1 }), false, "older rules score again");
});

test("remote MCP text lists score raises apart from the points taken off", () => {
  const ad: Ad = { kind: "house", placement: "scan_result", id: "house-badge-v1", label: "Sponsored", headline: "h", body: "b", url: "https://clauderabbit.in/badge/acme/lib" };
  const report = { ...PAYLOAD, score: 90, breakdown: [{ group: "reputation", code: "downloads", points: 2, detail: "many downloads" }, { group: "behaviour", code: "clean_run", points: 3, detail: "lifted to 90" }] } as typeof PAYLOAD;
  const text = finalLineText({ type: "result", outcome: "fresh", run_id: PAYLOAD.run_id, report, report_url: "https://clauderabbit.in/acme/lib", ad, cost: null });
  assert.doesNotMatch(text, /Points taken off:\n- \+/);
  assert.match(text, /Points added:\n- \+2 many downloads\n- \+3 lifted to 90/);
});
