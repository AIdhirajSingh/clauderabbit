/**
 * Data and surface seams (DESIGN.md sections 4, 6, 7.3, 8): the reports-row
 * mapping and its round trip back to a ReportPayload, event row mapping,
 * SupabaseStore against a recording PostgREST double, auth and rate-limit
 * wrappers with stub RPCs, request parsing, report URLs, the branch script's
 * production refusal, and the remote MCP text rendering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerToken, identify } from "../../lib/engine/auth.ts";
import { bucketFor, checkRateLimit, clientIp, GLOBAL_ANON_BUCKET_KEY } from "../../lib/engine/ratelimit.ts";
import { eventFromRow, eventToRow, payloadFromRows, reportsRowFor, SupabaseStore, type ReportRecord, type StoredReportRow } from "../../lib/engine/store.ts";
import type { Ad, ReportPayload, ScanEvent } from "../../lib/engine/types.ts";
import { finalLineText } from "../../lib/server/report-text.ts";
import { parseScanBody, realtimeChannel, replaySubject, reportUrlFor, statusFor, surfaceFromHeader } from "../../lib/server/scan-service.ts";
import { pkceMatches } from "../../lib/server/oauth.ts";
import { createClient } from "@supabase/supabase-js";
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
    { reader: "install", file: "package.json", line: null, severity: "medium", verdict: "suspicious", title: "postinstall runs a network beacon", rationale: "beacon.js posts env vars", reach: "install" },
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

/** A PostgREST double: records each request, answers from a queue. */
function restDouble(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : null });
    const a = answers.shift() ?? { status: 200, body: [] };
    return new Response(a.body === null ? null : JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const db = createClient("https://branch.supabase.test", "sb_secret_test_only", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchImpl } });
  return { db, calls };
}

test("SupabaseStore.claimRun expires stale runs, inserts, and attaches on the dedup conflict", async () => {
  const { db, calls } = restDouble([
    { status: 200, body: 0 },
    { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint \"uq_scan_runs_running\"" } },
    { status: 200, body: { id: "22222222-2222-4222-8222-222222222222" } },
  ]);
  const store = new SupabaseStore(db);
  const r = await store.claimRun({ runId: PAYLOAD.run_id, targetKind: "github", subject: "acme/lib", commitSha: PAYLOAD.commit_sha, modelId: "gpt-6-luna", template: "t" });
  assert.deepEqual(r, { status: "running", runId: "22222222-2222-4222-8222-222222222222" });
  assert.match(calls[0]!.url, /\/rest\/v1\/rpc\/expire_stale_runs$/);
  assert.equal(calls[1]!.method, "POST");
  assert.match(calls[1]!.url, /\/rest\/v1\/scan_runs/);
  assert.equal(JSON.parse(calls[1]!.body!).status, "running");
  assert.match(calls[2]!.url, /status=eq\.running/);
});

test("SupabaseStore.chargeBudget calls scan_budget_charge and appendEvents inserts rows", async () => {
  const { db, calls } = restDouble([{ status: 200, body: false }, { status: 201, body: null }]);
  const store = new SupabaseStore(db);
  assert.equal(await store.chargeBudget({ sandboxSeconds: 9.4, tokens: 100, capSeconds: 20000, capTokens: 20000000 }), false);
  assert.deepEqual(JSON.parse(calls[0]!.body!), { p_sandbox_seconds: 9, p_tokens: 100, p_cap_seconds: 20000, p_cap_tokens: 20000000 });
  await store.appendEvents([{ run_id: PAYLOAD.run_id, seq: 0, t_ms: 1, type: "stage", data: { name: "resolve", status: "start" } }]);
  assert.match(calls[1]!.url, /\/rest\/v1\/scan_events/);
  assert.deepEqual(JSON.parse(calls[1]!.body!), [{ run_id: PAYLOAD.run_id, seq: 0, t_ms: 1, type: "stage", data: { name: "resolve", status: "start" } }]);
});

test("SupabaseStore surfaces database errors instead of swallowing them", async () => {
  const { db } = restDouble([{ status: 500, body: { code: "XX000", message: "boom" } }]);
  await assert.rejects(new SupabaseStore(db).finishRun(PAYLOAD.run_id, { status: "done", timings: {} }), /scan_runs finish: boom/);
});

test("auth: bearer parsing, cr_cli_ tokens via verify_cli_token, malformed tokens never reach the RPC", async () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  const token = "cr_cli_" + "f".repeat(64);
  const uid = "33333333-3333-4333-8333-333333333333";
  let rpcCalls = 0;
  const db = { rpc: async (name: string, args: Record<string, unknown>) => { rpcCalls++; assert.equal(name, "verify_cli_token"); return { data: args.p_token === token ? uid : null, error: null }; }, auth: { getUser: async () => ({ data: { user: null }, error: { message: "bad jwt" } }) } };
  assert.deepEqual(await identify(db as never, token), { userId: uid, via: "cli_token" });
  assert.equal(await identify(db as never, "cr_cli_short"), null);
  assert.equal(rpcCalls, 1);
  assert.equal(await identify(db as never, "a.b.c"), null);
  assert.equal(await identify(db as never, null), null);
});

test("rate limit: Vercel client IP, bucket choice, decision, fail-open with the reason", async () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  assert.equal(clientIp(h({ "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIp(h({ "x-real-ip": "2001:db8::1" })), "2001:db8::1");
  assert.equal(clientIp(h({ "x-forwarded-for": "not-an-ip" })), null);
  assert.equal(bucketFor({ userId: "u1", ip: "1.2.3.4" }).key, "user:u1");
  assert.equal(bucketFor({ userId: null, ip: null }).key, GLOBAL_ANON_BUCKET_KEY);
  const denied = await checkRateLimit({ rpc: async () => ({ data: [{ allowed: false, current_count: 21, retry_after: 17 }], error: null }) } as never, { userId: null, ip: "1.2.3.4" });
  assert.deepEqual(denied, { allowed: false, retryAfter: 17, bucket: "ip:1.2.3.4" });
  const open = await checkRateLimit({ rpc: async () => ({ data: null, error: { message: "db down" } }) } as never, { userId: null, ip: "1.2.3.4" });
  assert.equal(open.allowed, true);
  assert.equal(open.limiterError, "db down");
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

test("remote MCP text: verdict, score, evidence groups, not verified, URL, ad; never a bare Safe", () => {
  const ad: Ad = { kind: "house", placement: "scan_result", id: "house-badge-v1", label: "Sponsored", headline: "Show this scan on acme/lib", body: "Add the badge.", url: "https://clauderabbit.in/badge/acme/lib" };
  const text = finalLineText({ type: "result", outcome: "fresh", run_id: PAYLOAD.run_id, report: PAYLOAD, report_url: "https://clauderabbit.in/acme/lib", ad });
  assert.match(text, /Verdict: Malicious \(score 12\/100\)/);
  assert.match(text, /Observed when the code ran \(behaviour\):\n- POST/);
  assert.match(text, /Reputation signals \(separate from code and behaviour\):/);
  assert.match(text, /Not verified:\n- Behaviour outside/);
  assert.match(text, /Full report: https:\/\/clauderabbit\.in\/acme\/lib/);
  assert.match(text, /\[Sponsored\] Show this scan on acme\/lib/);
  assert.doesNotMatch(text, /\bSafe\b/);
  const err = finalLineText({ type: "error", code: "unauthorized", message: "sign in first", run_id: null, ad, signInUrl: "https://clauderabbit.in/cli-auth" });
  assert.match(err, /Sign in: https:\/\/clauderabbit\.in\/cli-auth/);
  assert.match(err, /\[Sponsored\]/);
});
