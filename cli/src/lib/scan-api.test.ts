/**
 * Client side of the 2.0 scan API (DESIGN.md section 8.2): request shape and
 * headers, NDJSON parsing across chunk boundaries, the 401 sign-in path, and
 * the rendered output (verdict, score, not_verified, report URL, ad; never a
 * bare "Safe").
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatResponse, postScan, toStructured, type Ad, type EngineReport } from "./scan-api.js";

const AD: Ad = { kind: "house", placement: "scan_result", id: "house-badge-v1", label: "Sponsored", headline: "Show this scan on acme/lib", body: "Add the badge.", url: "https://clauderabbit.in/badge/acme/lib" };
const REPORT: EngineReport = {
  run_id: "11111111-1111-4111-8111-111111111111",
  target: "acme/lib",
  commit_sha: "a".repeat(40),
  score: 12,
  verdict: "Malicious",
  band: "red",
  summary: "The install hook sent a credential to a remote host.",
  headline: "Exfiltrates AWS credentials at install",
  evidence: { behaviour: ["POST to c2.cr-fixture.invalid carried the AWS canary"], code: ["postinstall runs beacon.js"], reputation: ["owner account is 3 days old"] },
  breakdown: [{ group: "behaviour", code: "canary_exfil", points: -70, detail: "canary" }],
  not_verified: ["Behaviour outside the observed install and entry windows."],
  model_id: "gpt-6-luna",
  template: "clauderabbit-detonate",
  timings: { detonate: 4000 },
};

function streamOf(text: string, cut: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, cut)));
      c.enqueue(enc.encode(text.slice(cut)));
      c.close();
    },
  });
}

test("postScan sends the token, client header and body, and parses split NDJSON", async () => {
  const lines =
    JSON.stringify({ type: "event", event: { run_id: REPORT.run_id, seq: 0, t_ms: 1, type: "stage", data: { name: "resolve", status: "start" } } }) + "\n" +
    JSON.stringify({ type: "result", outcome: "fresh", run_id: REPORT.run_id, report: REPORT, report_url: "https://clauderabbit.in/acme/lib", ad: AD }) + "\n";
  let seen: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(streamOf(lines, 37), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }) as unknown as typeof fetch;
  const events: string[] = [];
  const r = await postScan({ siteUrl: "https://clauderabbit.in/", scanTimeoutMs: 5000 }, { ecosystem: "github", owner: "acme", repo: "lib" }, "cr_cli_" + "0".repeat(64), "cli", (e) => events.push(e.type), fakeFetch);
  assert.ok(seen);
  const s = seen as { url: string; init: RequestInit };
  assert.equal(s.url, "https://clauderabbit.in/api/scan");
  const h = s.init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer cr_cli_" + "0".repeat(64));
  assert.equal(h["x-clauderabbit-client"], "cli");
  assert.deepEqual(JSON.parse(String(s.init.body)), { ecosystem: "github", owner: "acme", repo: "lib" });
  assert.deepEqual(events, ["stage"]);
  assert.equal(r.ok, true);
  const text = formatResponse(r);
  assert.match(text, /Verdict: Malicious {3}Score: 12\/100/);
  assert.match(text, /Not verified:\n {2}- Behaviour outside/);
  assert.match(text, /Report: https:\/\/clauderabbit\.in\/acme\/lib/);
  assert.match(text, /\[Sponsored\] Show this scan on acme\/lib/);
  assert.doesNotMatch(text, /\bSafe\b/);
  const json = toStructured(r);
  assert.deepEqual(json.notVerified, REPORT.not_verified);
  assert.deepEqual(json.ad, AD);
});

test("a 401 carries signInUrl and the ad through to the output", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ type: "error", code: "unauthorized", message: "sign in first", signInUrl: "https://clauderabbit.in/cli-auth", ad: AD }), { status: 401 })) as unknown as typeof fetch;
  const r = await postScan({ siteUrl: "https://clauderabbit.in", scanTimeoutMs: 5000 }, { ecosystem: "npm", package: "left-pad" }, "cr_cli_x", "mcp", undefined, fakeFetch);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 401);
  assert.equal(r.signInUrl, "https://clauderabbit.in/cli-auth");
  const text = formatResponse(r);
  assert.match(text, /Sign in at https:\/\/clauderabbit\.in\/cli-auth/);
  assert.match(text, /\[Sponsored\]/);
});

test("protectionBypass is sent only as x-vercel-protection-bypass, and only when set", async () => {
  const seen: Array<Record<string, string>> = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify({ type: "error", code: "unauthorized", message: "sign in first" }), { status: 401 });
  }) as unknown as typeof fetch;
  await postScan({ siteUrl: "https://preview.example", scanTimeoutMs: 5000, protectionBypass: "b".repeat(32) }, { ecosystem: "npm", package: "x" }, "cr_cli_x", "cli", undefined, fakeFetch);
  await postScan({ siteUrl: "https://preview.example", scanTimeoutMs: 5000 }, { ecosystem: "npm", package: "x" }, "cr_cli_x", "cli", undefined, fakeFetch);
  assert.equal(seen[0]["x-vercel-protection-bypass"], "b".repeat(32));
  assert.equal("x-vercel-protection-bypass" in seen[1], false);
});

test("a stream that ends without a final line is an error, not a report", async () => {
  const fakeFetch = (async () => new Response(streamOf('{"type":"event","event":{"type":"stage","seq":0,"t_ms":0,"data":{"name":"resolve","status":"start"}}}\n', 10), { status: 200 })) as unknown as typeof fetch;
  const r = await postScan({ siteUrl: "https://clauderabbit.in", scanTimeoutMs: 5000 }, { ecosystem: "npm", package: "x" }, "t", "cli", undefined, fakeFetch);
  assert.equal(r.ok, false);
});
