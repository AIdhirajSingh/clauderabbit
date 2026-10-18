#!/usr/bin/env node
/**
 * Key-day live proof harness (docs/runs/2.0-keyday.md step 6).
 *
 * One target on one surface per invocation, so the scan budget is spent one
 * deliberate call at a time. Saves the full raw output with the client-side
 * wall time and the server's timings and cost ledger to
 * docs/runs/keyday-proof/<target>-<surface>[-<tag>].json.
 *
 *   node scripts/keyday-proof.mjs run --target fixture --surface web --site <preview origin> [--tag rescan]
 *   node scripts/keyday-proof.mjs table                     # markdown table from the saved files
 *   node scripts/keyday-proof.mjs one-oh                    # one 1.0 scan of expressjs/express on production
 *   node scripts/keyday-proof.mjs token --user <uuid> --out <file>   # operator: issue a cr_cli_ token
 *
 * Surfaces:
 *   web  POST <site>/api/scan, NDJSON, no sign-in (the web app's path)
 *   cli  the repo's own CLI (cli/dist/index.js) with --api <site> --json, HOME pointed at a scratch dir
 *        holding the cr_cli_ token, so ~/.clauderabbit is never touched
 *   mcp  Streamable HTTP JSON-RPC to <site>/mcp: initialize, then tools/call scan
 *
 * Environment (values are never printed, and are scrubbed from every saved file):
 *   VERCEL_BYPASS        Vercel automation-bypass secret for the protected Preview
 *   CR_PROOF_TOKEN       cr_cli_ token of a signed-in account (cli and mcp surfaces)
 *   CR_PROOF_HOME        scratch HOME for the CLI (cli surface)
 *   CR_V2_DATABASE_URL   cr_v2_server connection string (token subcommand only)
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = process.env.CR_PROOF_OUT_DIR ? resolve(process.env.CR_PROOF_OUT_DIR) : join(ROOT, "docs", "runs", "keyday-proof");
export const BUDGET_MS = 10_000;

/** The three budgeted targets, each pinned to one commit. */
export const TARGETS = {
  fixture: { owner: "AIdhirajSingh", repo: "cr-fixture-phone-home", sha: "280ab9649323556891ec399ac1da461598d6f4df" },
  openclaw: { owner: "openclaw", repo: "openclaw", sha: "104730ba84765f16915cfe2150b368e6344a019d" },
  express: { owner: "expressjs", repo: "express", sha: "0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8" },
};
export const SURFACES = ["web", "cli", "mcp"];

/** 1.0 production scan endpoint and its public publishable key (docs/INFRASTRUCTURE.md). */
const ONE_OH_FUNCTION = "https://mjvlczaytkhvsolnhhkz.supabase.co/functions/v1/scan";
const ONE_OH_PUBLISHABLE = "sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B";

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[k] = next;
        i++;
      } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** Replace every secret value in a string with [REDACTED]. Empty or short values are ignored. */
export function scrub(text, secrets) {
  let s = text;
  for (const v of secrets) if (typeof v === "string" && v.length >= 8) s = s.split(v).join("[REDACTED]");
  return s;
}

/** Split complete NDJSON lines from a buffer; the trailing partial line is returned as rest. */
export function splitNdjson(buffer) {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const objects = [];
  const bad = [];
  for (const line of parts) {
    if (!line.trim()) continue;
    try {
      objects.push(JSON.parse(line));
    } catch {
      bad.push(line.slice(0, 200));
    }
  }
  return { objects, bad, rest };
}

/** Parse a whole NDJSON body into events and the final line. */
export function parseNdjsonBody(text) {
  const { objects, bad, rest } = splitNdjson(text.endsWith("\n") ? text : `${text}\n`);
  const events = objects.filter((o) => o?.type === "event").map((o) => o.event);
  const final = [...objects].reverse().find((o) => o?.type === "result" || o?.type === "error") ?? null;
  return { events, final, unparsed: bad.concat(rest.trim() ? [rest.slice(0, 200)] : []) };
}

/** Parse a Streamable HTTP response body: plain JSON, or SSE `data:` frames carrying JSON-RPC. */
export function parseMcpBody(text, contentType = "") {
  if (contentType.includes("text/event-stream") || /^(event|data):/m.test(text.trimStart().slice(0, 10))) {
    const msgs = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        msgs.push(JSON.parse(payload));
      } catch {
        // ignore a non-JSON frame
      }
    }
    return msgs;
  }
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

function inr(usd, fx) {
  return typeof usd === "number" && typeof fx === "number" ? Math.round(usd * fx * 1e6) / 1e6 : null;
}

/** Cost split in INR from a CostLedger (lib/engine/cost.ts), or null when the surface did not return one. */
export function costSplit(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  const fx = ledger.fx?.usd_inr;
  return {
    jev_inr: inr(ledger.jev?.usd, fx),
    luna_inr: inr(ledger.luna?.usd, fx),
    e2b_inr: inr(ledger.sandbox?.usd, fx),
    total_inr: typeof ledger.total_inr === "number" ? ledger.total_inr : null,
    jev_tokens: ledger.jev ? { input: ledger.jev.input_tokens, output: ledger.jev.output_tokens, calls: ledger.jev.calls } : null,
    luna_tokens: ledger.luna ? { input: ledger.luna.input_tokens, cached: ledger.luna.cached_input_tokens, output: ledger.luna.output_tokens, calls: ledger.luna.calls } : null,
    e2b_seconds: ledger.sandbox?.seconds ?? null,
    usd_inr: fx ?? null,
  };
}

/**
 * Forensic facts from a full report (web surface) or from the event stream.
 * Returns null fields when the surface's output does not carry them (CLI and MCP
 * return the structured summary, not the forensics).
 */
export function forensicFacts(report, events = []) {
  const f = report?.forensics;
  const forged = Array.isArray(f?.forged_calls) ? f.forged_calls : events.filter((e) => e?.type === "forged_call").map((e) => e.data);
  const files = Array.isArray(f?.files) ? f.files : events.filter((e) => e?.type === "file").map((e) => e.data);
  const haveForensics = Array.isArray(f?.forged_calls) || events.length > 0;
  if (!haveForensics) return { forged_calls: null, forged_with_canary: null, decoy_reads: null, forged_hosts: null };
  return {
    forged_calls: forged.length,
    forged_with_canary: forged.filter((c) => Array.isArray(c?.canary_hits) && c.canary_hits.length > 0).length,
    decoy_reads: files.filter((x) => x?.op === "read_decoy").map((x) => x.path),
    forged_hosts: [...new Set(forged.map((c) => `${c?.method ?? c?.proto ?? "?"} ${c?.host}${c?.path ?? ""}`))].slice(0, 10),
  };
}

/** One row of the proof table from a saved run record. */
export function summarize(record) {
  const r = record.result ?? {};
  const report = r.report ?? null;
  const facts = forensicFacts(report, record.events ?? []);
  return {
    target: record.target,
    surface: record.surface,
    tag: record.tag ?? null,
    ok: r.ok === true,
    outcome: r.outcome ?? null,
    error: r.ok === true ? null : (r.code ? `${r.code}: ${r.message ?? ""}` : (record.error ?? "no result")),
    verdict: r.verdict ?? report?.verdict ?? null,
    score: r.score ?? report?.score ?? null,
    commit_sha: r.commitSha ?? report?.commit_sha ?? null,
    not_verified: r.notVerified ?? report?.not_verified ?? null,
    ...facts,
    wall_ms: record.wall_ms ?? null,
    within_10s: typeof record.wall_ms === "number" ? record.wall_ms <= BUDGET_MS : null,
    server_timings: report?.timings ?? null,
    cost: costSplit(r.cost ?? report?.cost ?? null),
    bare_safe: String(r.verdict ?? report?.verdict ?? "").trim() === "Safe",
  };
}

/** Normalise the three surfaces' final outputs into one shape. */
export function normaliseWeb(final) {
  if (!final) return { ok: false, code: "no_final_line", message: "stream ended without a result or error line" };
  if (final.type === "error") return { ok: false, code: final.code, message: final.message, run_id: final.run_id ?? null };
  return { ok: true, outcome: final.outcome, run_id: final.run_id, report: final.report, report_url: final.report_url, cost: final.cost ?? null, verdict: final.report?.verdict, score: final.report?.score, commitSha: final.report?.commit_sha, notVerified: final.report?.not_verified };
}

export function normaliseCli(json) {
  if (!json || typeof json !== "object") return { ok: false, code: "no_json", message: "CLI printed no JSON object" };
  if (json.ok !== true) return { ok: false, code: json.code ?? "cli_error", message: json.message ?? json.error ?? "" };
  return { ok: true, outcome: json.outcome, run_id: json.runId, verdict: json.verdict, score: json.score, commitSha: json.commitSha, notVerified: json.notVerified, report_url: json.reportUrl };
}

export function normaliseMcp(callResponse) {
  const res = callResponse?.result;
  if (!res) return { ok: false, code: "jsonrpc_error", message: JSON.stringify(callResponse?.error ?? callResponse ?? null).slice(0, 500) };
  const sc = res.structuredContent ?? {};
  if (res.isError || sc.ok !== true) return { ok: false, code: sc.code ?? "tool_error", message: sc.message ?? (res.content?.[0]?.text ?? "").slice(0, 500) };
  return { ok: true, outcome: sc.outcome, run_id: sc.runId, verdict: sc.verdict, score: sc.score, commitSha: sc.commitSha, notVerified: sc.notVerified, report_url: sc.reportUrl };
}

function bypassHeaders() {
  const b = process.env.VERCEL_BYPASS?.trim();
  return b ? { "x-vercel-protection-bypass": b } : {};
}

function secretValues() {
  return [process.env.VERCEL_BYPASS, process.env.CR_PROOF_TOKEN, process.env.CR_V2_DATABASE_URL, process.env.CR_OPERATOR_KEY].filter(Boolean);
}

async function runWeb(site, t) {
  const t0 = performance.now();
  const res = await fetch(`${site}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", "x-clauderabbit-client": "web", ...bypassHeaders() },
    body: JSON.stringify({ ecosystem: "github", owner: t.owner, repo: t.repo, ref: t.sha }),
  });
  const text = await res.text();
  const wall = performance.now() - t0;
  const parsed = parseNdjsonBody(text);
  return { http_status: res.status, wall_ms: Math.round(wall), raw: text, events: parsed.events, result: normaliseWeb(parsed.final ?? (res.ok ? null : safeJson(text))), unparsed: parsed.unparsed };
}

function safeJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? { type: "error", code: v.code ?? v.error ?? `http`, message: v.message ?? text.slice(0, 300) } : null;
  } catch {
    return { type: "error", code: "http", message: text.slice(0, 300) };
  }
}

function runProcess(cmd, args, env) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

async function runCli(site, t) {
  const home = process.env.CR_PROOF_HOME;
  const token = process.env.CR_PROOF_TOKEN;
  if (!home || !token) throw new Error("cli surface needs CR_PROOF_HOME and CR_PROOF_TOKEN (a cr_cli_ token); refusing to start a browser sign-in");
  const cli = join(ROOT, "cli", "dist", "index.js");
  const env = { PATH: process.env.PATH, HOME: home, NO_COLOR: "1", CLAUDE_RABBIT_SCAN_TIMEOUT_MS: "190000" };
  if (process.env.VERCEL_BYPASS) env.CLAUDE_RABBIT_PROTECTION_BYPASS = process.env.VERCEL_BYPASS;
  const login = await runProcess(process.execPath, [cli, "login", "--token", token], env);
  if (login.code !== 0) throw new Error(`clauderabbit login --token failed: ${login.stderr.trim()}`);
  const t0 = performance.now();
  const out = await runProcess(process.execPath, [cli, "scan", `${t.owner}/${t.repo}`, "--ref", t.sha, "--json", "--api", site], env);
  const wall = performance.now() - t0;
  let json = null;
  try {
    json = JSON.parse(out.stdout);
  } catch {
    json = null;
  }
  return { exit_code: out.code, wall_ms: Math.round(wall), raw: out.stdout, stderr: out.stderr, events: [], result: normaliseCli(json) };
}

async function mcpPost(site, body) {
  const res = await fetch(`${site}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${process.env.CR_PROOF_TOKEN ?? ""}`,
      ...bypassHeaders(),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, messages: parseMcpBody(text, res.headers.get("content-type") ?? "") };
}

async function runMcp(site, t) {
  if (!process.env.CR_PROOF_TOKEN) throw new Error("mcp surface needs CR_PROOF_TOKEN (a cr_cli_ token)");
  const init = await mcpPost(site, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "keyday-proof", version: "1.0.0" } } });
  const t0 = performance.now();
  const call = await mcpPost(site, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "scan", arguments: { owner: t.owner, repo: t.repo, ref: t.sha } } });
  const wall = performance.now() - t0;
  const callMsg = call.messages.find((m) => m?.id === 2) ?? call.messages[0] ?? null;
  return { http_status: call.status, initialize: { status: init.status, body: init.text.slice(0, 2000) }, wall_ms: Math.round(wall), raw: call.text, events: [], result: call.status === 200 ? normaliseMcp(callMsg) : { ok: false, code: `http_${call.status}`, message: call.text.slice(0, 500) } };
}

export function outFile(target, surface, tag) {
  return join(OUT_DIR, `${target}-${surface}${tag ? `-${tag}` : ""}.json`);
}

async function cmdRun(args) {
  const target = String(args.target ?? "");
  const surface = String(args.surface ?? "");
  const site = String(args.site ?? "").replace(/\/+$/, "");
  const t = TARGETS[target];
  if (!t) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(", ")}`);
  if (!SURFACES.includes(surface)) throw new Error(`--surface must be one of ${SURFACES.join(", ")}`);
  if (!/^https?:\/\//.test(site)) throw new Error("--site must be the preview origin, e.g. https://clauderabbit-git-20-<team>.vercel.app");
  const tag = typeof args.tag === "string" ? args.tag : null;
  const file = outFile(target, surface, tag);
  const startedAt = new Date().toISOString();
  let body;
  try {
    body = surface === "web" ? await runWeb(site, t) : surface === "cli" ? await runCli(site, t) : await runMcp(site, t);
  } catch (err) {
    body = { error: err instanceof Error ? err.message : String(err), result: { ok: false, code: "harness", message: err instanceof Error ? err.message : String(err) } };
  }
  const record = { target, surface, tag, repo: `${t.owner}/${t.repo}`, pinned_sha: t.sha, site, started_at: startedAt, ...body };
  record.summary = summarize(record);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, scrub(JSON.stringify(record, null, 2), secretValues()) + "\n");
  process.stdout.write(scrub(JSON.stringify({ file: file.replace(`${ROOT}/`, ""), summary: record.summary }, null, 2), secretValues()) + "\n");
  return record.summary.ok ? 0 : 1;
}

export function tableMarkdown(rows) {
  const head = "| target | surface | outcome | verdict | score | forged calls (with canary) | decoy reads caught | not verified | wall s vs 10 s | cost INR (Jev / Luna / E2B = total) |\n|---|---|---|---|---|---|---|---|---|---|";
  const fmt = (v) => (v === null || v === undefined ? "n/a" : String(v));
  const lines = rows.map((r) => {
    const forged = r.forged_calls === null ? "n/a" : `${r.forged_calls} (${r.forged_with_canary})`;
    const decoy = r.decoy_reads === null ? "n/a" : (r.decoy_reads.length ? r.decoy_reads.join(", ") : "0");
    const nv = Array.isArray(r.not_verified) ? r.not_verified.join("; ").replace(/\|/g, "/") : "n/a";
    const wall = r.wall_ms === null ? "n/a" : `${(r.wall_ms / 1000).toFixed(2)} (${r.within_10s ? "within" : "over"})`;
    const c = r.cost;
    const cost = c ? `${fmt(c.jev_inr)} / ${fmt(c.luna_inr)} / ${fmt(c.e2b_inr)} = ${fmt(c.total_inr)}` : "n/a";
    const label = r.tag ? `${r.surface} (${r.tag})` : r.surface;
    return `| ${r.target} | ${label} | ${r.ok ? r.outcome : `error ${r.error}`} | ${fmt(r.verdict)} | ${fmt(r.score)} | ${forged} | ${decoy} | ${nv} | ${wall} | ${cost} |`;
  });
  return [head, ...lines].join("\n");
}

function cmdTable() {
  let names = [];
  try {
    names = readdirSync(OUT_DIR).filter((n) => n.endsWith(".json") && !n.startsWith("one-oh"));
  } catch {
    names = [];
  }
  const rows = names.sort().map((n) => summarize(JSON.parse(readFileSync(join(OUT_DIR, n), "utf8"))));
  process.stdout.write(`${tableMarkdown(rows)}\n`);
  return 0;
}

/** One 1.0 scan through the production edge function the clauderabbit.in web app calls. */
async function cmdOneOh() {
  const t0 = performance.now();
  const res = await fetch(ONE_OH_FUNCTION, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ONE_OH_PUBLISHABLE, Authorization: `Bearer ${ONE_OH_PUBLISHABLE}` },
    body: JSON.stringify({ owner: "expressjs", repo: "express" }),
  });
  const text = await res.text();
  const wall = Math.round(performance.now() - t0);
  // The 1.0 edge function streams its own NDJSON line shapes (not 2.0's event/result lines), so every
  // line is kept as sent; a non-streamed reply (cache path, errors) is one JSON object.
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const { objects, bad, rest } = splitNdjson(text.endsWith("\n") ? text : `${text}\n`);
    parsed = { ndjson_lines: objects, unparsed: bad.concat(rest.trim() ? [rest] : []) };
  }
  const record = { surface: "1.0 edge function scan (what https://clauderabbit.in calls)", url: ONE_OH_FUNCTION, http_status: res.status, content_type: res.headers.get("content-type"), wall_ms: wall, started_at: new Date(Date.now() - wall).toISOString(), body: parsed ?? text.slice(0, 20000) };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, "one-oh-expressjs-express.json");
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(`${file.replace(`${ROOT}/`, "")} http=${res.status} wall_ms=${wall} bytes=${text.length}\n`);
  return res.ok ? 0 : 1;
}

/**
 * Operator path for a cr_cli_ token without a browser: call v2.issue_cli_token(<user uuid>) as
 * cr_v2_server and write the plaintext token to a mode 0600 file. Prints only its length.
 * Needs the v2 migrations applied and the cr_v2_server password set (gate A).
 */
async function cmdToken(args) {
  const user = String(args.user ?? "");
  const out = String(args.out ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(user)) throw new Error("--user must be the auth.users uuid of the signed-in account");
  if (!out) throw new Error("--out <file> is required (a path in the session scratch directory)");
  const url = process.env.CR_V2_DATABASE_URL;
  if (!url) throw new Error("CR_V2_DATABASE_URL is not set");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { prepare: false, max: 1, ssl: "require", connect_timeout: 10 });
  try {
    const rows = await sql`select v2.issue_cli_token(${user}::uuid) as token`;
    const token = rows[0]?.token;
    if (typeof token !== "string" || !token.startsWith("cr_cli_")) throw new Error("v2.issue_cli_token returned no cr_cli_ token");
    writeFileSync(out, `CR_PROOF_TOKEN=${token}\n`, { mode: 0o600 });
    process.stdout.write(`wrote CR_PROOF_TOKEN (${token.length} chars) to ${out}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (cmd === "run") return cmdRun(args);
  if (cmd === "table") return cmdTable();
  if (cmd === "one-oh") return cmdOneOh();
  if (cmd === "token") return cmdToken(args);
  process.stderr.write("usage: keyday-proof.mjs run --target <fixture|openclaw|express> --surface <web|cli|mcp> --site <origin> [--tag t] | table | one-oh | token --user <uuid> --out <file>\n");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${scrub(err instanceof Error ? err.message : String(err), secretValues())}\n`);
      process.exitCode = 1;
    },
  );
}
