/**
 * scripts/keyday-proof.mjs: parsing of the three surfaces' outputs, the proof
 * table row (forged calls, decoy reads, not verified, wall time, INR split),
 * secret scrubbing, and an end-to-end run of the web and MCP surfaces against
 * a local fake server (no network, nothing written under docs/).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as proof from "../scripts/keyday-proof.mjs";

const LEDGER = {
  version: 1,
  jev: { model: "typesafe-ai/jev", calls: 3, input_tokens: 9000, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, usd: 0.000378, price: null },
  luna: { model: "gpt-6-luna", calls: 1, input_tokens: 2400, output_tokens: 300, cached_input_tokens: 2048, cache_write_tokens: 0, usd: 0.00020568, price: null },
  sandbox: { seconds: 61.5, vcpu: 1, memory_gib: 2, usd_per_second: 0.000023, usd: 0.0014145, source: "e2b", as_of: "2026-10-18" },
  total_usd: 0.00199818,
  total_inr: 0.189747,
  fx: { usd_inr: 94.96, source: "frankfurter", as_of: "2026-10-16" },
  calls: [],
};

const REPORT = {
  run_id: "r1",
  target: "AIdhirajSingh/cr-fixture-phone-home",
  commit_sha: "280ab9649323556891ec399ac1da461598d6f4df",
  score: 8,
  verdict: "Malicious",
  band: "red",
  not_verified: ["Jev checks did not complete"],
  timings: { total: 9100 },
  cost: LEDGER,
  forensics: {
    forged_calls: [{ phase: "install", proto: "https", host: "c2.cr-fixture.invalid", port: 443, method: "POST", path: "/collect", req_bytes: 120, forged_kind: "json", canary_hits: ["AWS_SECRET_ACCESS_KEY"] }],
    files: [{ phase: "install", op: "read_decoy", path: "/home/cr/.aws/credentials", pid: 7 }, { phase: "install", op: "write", path: "/tmp/x", pid: 7 }],
  },
};

function ndjson(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

test("pinned targets are full 40-hex SHAs", () => {
  for (const t of Object.values(proof.TARGETS) as Array<{ sha: string }>) assert.match(t.sha, /^[0-9a-f]{40}$/);
});

test("NDJSON body: events and the final line, the row carries forge, decoy, cost and wall time", () => {
  const body = ndjson([
    { type: "event", event: { run_id: "r1", seq: 0, t_ms: 1, type: "stage", data: { name: "resolve", status: "start" } } },
    { type: "result", outcome: "fresh", run_id: "r1", report: REPORT, report_url: "https://x/AIdhirajSingh/cr-fixture-phone-home", cost: LEDGER },
  ]);
  const parsed = proof.parseNdjsonBody(body.slice(0, -1));
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.final.type, "result");
  const row = proof.summarize({ target: "fixture", surface: "web", wall_ms: 9400, events: parsed.events, result: proof.normaliseWeb(parsed.final) });
  assert.equal(row.verdict, "Malicious");
  assert.equal(row.forged_calls, 1);
  assert.equal(row.forged_with_canary, 1);
  assert.deepEqual(row.decoy_reads, ["/home/cr/.aws/credentials"]);
  assert.deepEqual(row.not_verified, ["Jev checks did not complete"]);
  assert.equal(row.within_10s, true);
  assert.equal(row.bare_safe, false);
  const cost = row.cost!;
  assert.equal(cost.jev_inr, Math.round(0.000378 * 94.96 * 1e6) / 1e6);
  assert.equal(cost.e2b_seconds, 61.5);
  assert.equal(cost.total_inr, 0.189747);
  const md = proof.tableMarkdown([row]);
  assert.match(md, /\| fixture \| web \| fresh \| Malicious \| 8 \| 1 \(1\) \| \/home\/cr\/\.aws\/credentials \|/);
  assert.match(md, /9\.40 \(within\)/);
});

test("error lines and pre-stream HTTP errors become error rows, never a verdict", () => {
  const e = proof.parseNdjsonBody(ndjson([{ type: "error", code: "internal", message: "database unavailable", run_id: null }]));
  const row = proof.summarize({ target: "fixture", surface: "web", wall_ms: 12000, result: proof.normaliseWeb(e.final) });
  assert.equal(row.ok, false);
  assert.equal(row.verdict, null);
  assert.match(row.error, /internal: database unavailable/);
  assert.equal(row.within_10s, false);
  assert.equal(proof.normaliseWeb(null).code, "no_final_line");
});

test("CLI --json and MCP structuredContent normalise to the same fields", () => {
  const cli = proof.normaliseCli({ ok: true, outcome: "cached", runId: "r1", verdict: "Malicious", score: 8, commitSha: "a", notVerified: ["x"], reportUrl: "u" });
  assert.deepEqual([cli.ok, cli.outcome, cli.verdict, cli.score], [true, "cached", "Malicious", 8]);
  assert.equal(proof.normaliseCli({ ok: false, error: "Sign-in failed" }).ok, false);
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Verdict"}],"structuredContent":{"ok":true,"outcome":"cached","runId":"r1","verdict":"Low risk","score":88,"notVerified":["y"]}}}\n\n';
  const msgs = proof.parseMcpBody(sse, "text/event-stream");
  const mcp = proof.normaliseMcp(msgs[0]);
  assert.deepEqual([mcp.ok, mcp.verdict, mcp.score, mcp.notVerified], [true, "Low risk", 88, ["y"]]);
  const err = proof.normaliseMcp({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "no" }], structuredContent: { ok: false, code: "unauthorized", message: "no" } } });
  assert.equal(err.code, "unauthorized");
  assert.equal(proof.normaliseMcp({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "x" } }).code, "jsonrpc_error");
});

test("scrub removes every secret value and ignores short ones", () => {
  assert.equal(proof.scrub("a SECRETVALUE123 b SECRETVALUE123", ["SECRETVALUE123", "ab"]), "a [REDACTED] b [REDACTED]");
});

function runHarness(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, ["scripts/keyday-proof.mjs", ...args], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (code: number | null) => resolve({ code, stdout, stderr }));
  });
}

test("end to end: web and MCP surfaces against a fake site send the bypass and token, save scrubbed records", async () => {
  const BYPASS = "bypass-secret-0123456789abcdef";
  const TOKEN = "cr_cli_" + "f".repeat(64);
  const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/api/scan") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Echo the bypass to prove the saved record is scrubbed.
        res.end(ndjson([{ type: "event", event: { run_id: "r1", seq: 0, t_ms: 1, type: "check", data: { name: "echo", ok: true, detail: String(req.headers["x-vercel-protection-bypass"]) } } }, { type: "result", outcome: "fresh", run_id: "r1", report: REPORT, report_url: "u", cost: LEDGER }]));
        return;
      }
      if (req.url === "/mcp") {
        const msg = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (msg.method === "initialize") res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } }));
        else res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Verdict: Malicious" }], structuredContent: { ok: true, outcome: "cached", runId: "r1", verdict: "Malicious", score: 8, notVerified: ["Jev checks did not complete"], reportUrl: "u" } } }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const out = mkdtempSync(join(tmpdir(), "keyday-proof-"));
  try {
    const env = { CR_PROOF_OUT_DIR: out, VERCEL_BYPASS: BYPASS, CR_PROOF_TOKEN: TOKEN };
    const web = await runHarness(["run", "--target", "fixture", "--surface", "web", "--site", `http://127.0.0.1:${port}`], env);
    assert.equal(web.code, 0, web.stderr);
    const mcp = await runHarness(["run", "--target", "fixture", "--surface", "mcp", "--site", `http://127.0.0.1:${port}/`], env);
    assert.equal(mcp.code, 0, mcp.stderr);

    const scan = seen.find((s) => s.url === "/api/scan")!;
    assert.equal(scan.headers["x-vercel-protection-bypass"], BYPASS);
    assert.deepEqual(JSON.parse(scan.body), { ecosystem: "github", owner: "AIdhirajSingh", repo: "cr-fixture-phone-home", ref: "280ab9649323556891ec399ac1da461598d6f4df" });
    const calls = seen.filter((s) => s.url === "/mcp");
    assert.deepEqual(calls.map((c) => JSON.parse(c.body).method), ["initialize", "tools/call"]);
    const toolCall = calls[1]!;
    assert.equal(toolCall.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(toolCall.body).params.arguments, { owner: "AIdhirajSingh", repo: "cr-fixture-phone-home", ref: "280ab9649323556891ec399ac1da461598d6f4df" });

    const webRec = readFileSync(join(out, "fixture-web.json"), "utf8");
    const mcpRec = readFileSync(join(out, "fixture-mcp.json"), "utf8");
    for (const s of [webRec, mcpRec, web.stdout, mcp.stdout]) {
      assert.equal(s.includes(BYPASS), false);
      assert.equal(s.includes(TOKEN), false);
    }
    assert.match(webRec, /\[REDACTED\]/);
    const webSummary = JSON.parse(webRec).summary;
    assert.equal(webSummary.forged_with_canary, 1);
    assert.deepEqual(webSummary.decoy_reads, ["/home/cr/.aws/credentials"]);
    assert.equal(JSON.parse(mcpRec).summary.outcome, "cached");

    const cli = await runHarness(["run", "--target", "fixture", "--surface", "cli", "--site", `http://127.0.0.1:${port}`], { CR_PROOF_OUT_DIR: out });
    assert.equal(cli.code, 1);
    assert.match(JSON.parse(readFileSync(join(out, "fixture-cli.json"), "utf8")).summary.error, /refusing to start a browser sign-in/);
  } finally {
    server.close();
    rmSync(out, { recursive: true, force: true });
  }
});
