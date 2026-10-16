#!/usr/bin/env node
/**
 * Score the labeled set (tests/labeled/set.json) through a deployed /api/scan and write
 * docs/runs/2.0-labeled-results.md.
 *
 *   CR_OPERATOR_KEY=... node scripts/labeled-run.mjs --site https://<preview>.vercel.app [--concurrency 4]
 *       [--only <id,id>] [--limit N] [--out docs/runs/2.0-labeled-results.md] [--regenerate]
 *   node scripts/labeled-run.mjs --dry-run      validate the set and print the request plan; no network
 *
 * Every scan runs on the server (Vercel + E2B). This script only sends JSON and reads the NDJSON stream;
 * no package bytes ever reach this machine.
 *
 * Env:
 *   CR_OPERATOR_KEY                   required for the PyPI tarball entries (operator target) and lifts the
 *                                     burst rate limit for the run; sent as x-cr-operator-key.
 *   VERCEL_AUTOMATION_BYPASS_SECRET   optional, sent as x-vercel-protection-bypass for a protected preview.
 *
 * Scoring rules:
 *   - positive class = malicious. A scan "flags" a target when its verdict is "High risk" or "Malicious"
 *     (score below 60). Precision and recall are computed over available scans only.
 *   - escalation = share of available scans whose verdict is "Caution" or worse (score below 80): the
 *     results a person has to read before installing.
 *   - a target whose artifact is gone (not_found, integrity) or whose scan errors is "unavailable": it is
 *     listed, and never counted as a pass.
 *   - a GitHub result whose commit_sha is not the pinned SHA, or an npm result whose commit_sha does not
 *     start with "<version>+", is a pin mismatch and counts as a failure.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SET = path.join(ROOT, "tests/labeled/set.json");
const FLAG_VERDICTS = new Set(["High risk", "Malicious"]);
const ESCALATE_VERDICTS = new Set(["Caution", "High risk", "Malicious"]);
const ALL_VERDICTS = new Set(["No threats observed", "Low risk", "Caution", "High risk", "Malicious"]);

function parseArgs(argv) {
  const o = { site: null, concurrency: 4, only: null, limit: null, out: path.join(ROOT, "docs/runs/2.0-labeled-results.md"), dryRun: false, regenerate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--site") o.site = next().replace(/\/+$/, "");
    else if (a === "--concurrency") o.concurrency = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (a === "--only") o.only = new Set(next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--limit") o.limit = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (a === "--out") o.out = path.resolve(next());
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--regenerate") o.regenerate = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export function validateSet(doc) {
  const errors = [];
  if (!doc || !Array.isArray(doc.entries)) return ["set.json has no entries array"];
  const ids = new Set();
  for (const e of doc.entries) {
    const where = e?.id ?? "(no id)";
    if (!e?.id || ids.has(e.id)) errors.push(`${where}: missing or duplicate id`);
    ids.add(e?.id);
    if (e.expected !== "clean" && e.expected !== "malicious") errors.push(`${where}: expected must be clean or malicious`);
    if (e.kind === "github") {
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(e.target ?? "")) errors.push(`${where}: github target must be owner/repo`);
      if (!/^[0-9a-f]{40}$/.test(e.pin?.sha ?? "")) errors.push(`${where}: github pin.sha must be a full 40-hex SHA`);
    } else if (e.kind === "npm") {
      if (!/^npm:.+@.+$/.test(e.target ?? "")) errors.push(`${where}: npm target must be npm:name@version`);
      if (!e.pin?.version || !/^sha(512|256)-/.test(e.pin?.integrity ?? "")) errors.push(`${where}: npm pin needs version and SRI integrity`);
    } else if (e.kind === "tarball") {
      if (!/^https:\/\//.test(e.target ?? "")) errors.push(`${where}: tarball target must be an https URL`);
      if (!e.label || !/^sha(512|256)-/.test(e.pin?.integrity ?? "")) errors.push(`${where}: tarball needs label and SRI integrity`);
    } else errors.push(`${where}: unknown kind ${e.kind}`);
    if (e.expected === "malicious" && !/^MAL-\d{4}-\d+$/.test(e.source?.osv_id ?? "")) errors.push(`${where}: malicious entries need an OSV MAL- id`);
  }
  return errors;
}

export function requestFor(e) {
  if (e.kind === "github") {
    const [owner, repo] = e.target.split("/");
    return { ecosystem: "github", owner, repo, ref: e.pin.sha };
  }
  if (e.kind === "npm") {
    const spec = e.target.slice("npm:".length);
    const at = spec.lastIndexOf("@");
    return { ecosystem: "npm", package: spec.slice(0, at), version: e.pin.version };
  }
  return { ecosystem: "tarball", url: e.target, integrity: e.pin.integrity, label: e.label };
}

async function readFinal(res) {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("ndjson")) {
    const text = await res.text();
    try {
      return { final: JSON.parse(text), events: 0 };
    } catch {
      return { final: { type: "error", code: `http_${res.status}`, message: text.slice(0, 200) }, events: 0 };
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final = null;
  let events = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === "event") events++;
      else if (msg.type === "result" || msg.type === "error") final = msg;
    }
    if (done) break;
  }
  if (buf.trim()) {
    const msg = JSON.parse(buf.trim());
    if (msg.type === "result" || msg.type === "error") final = msg;
  }
  return { final: final ?? { type: "error", code: "no_final_line", message: "stream ended without a result line" }, events };
}

export function judge(e, final) {
  if (final.type !== "result") return { status: "unavailable", reason: `${final.code ?? final.error}: ${final.message ?? ""}`.trim() };
  const r = final.report ?? {};
  if (!ALL_VERDICTS.has(r.verdict)) return { status: "fail", reason: `verdict outside the five words: ${JSON.stringify(r.verdict)}` };
  if (!Array.isArray(r.not_verified) || r.not_verified.length === 0) return { status: "fail", reason: "not_verified is empty" };
  if (!final.ad) return { status: "fail", reason: "result carries no ad" };
  if (e.kind === "github" && r.commit_sha !== e.pin.sha) return { status: "fail", reason: `pin mismatch: scanned ${r.commit_sha}` };
  if (e.kind === "npm" && !String(r.commit_sha ?? "").startsWith(`${e.pin.version}+`)) return { status: "fail", reason: `pin mismatch: scanned ${r.commit_sha}` };
  const flagged = FLAG_VERDICTS.has(r.verdict);
  const pass = e.expected === "malicious" ? flagged : !flagged;
  return { status: pass ? "pass" : "fail", flagged, escalated: ESCALATE_VERDICTS.has(r.verdict), reason: pass ? "" : e.expected === "malicious" ? "missed: not flagged" : "false alarm: flagged" };
}

export function metrics(rows) {
  const avail = rows.filter((r) => r.status !== "unavailable");
  const tp = avail.filter((r) => r.expected === "malicious" && r.flagged).length;
  const fp = avail.filter((r) => r.expected === "clean" && r.flagged).length;
  const fn = avail.filter((r) => r.expected === "malicious" && !r.flagged).length;
  const tn = avail.filter((r) => r.expected === "clean" && !r.flagged).length;
  const walls = avail.map((r) => r.wallMs).sort((a, b) => a - b);
  const pct = (p) => (walls.length ? walls[Math.min(walls.length - 1, Math.floor((p / 100) * walls.length))] : null);
  return {
    total: rows.length,
    available: avail.length,
    unavailable: rows.length - avail.length,
    tp, fp, fn, tn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    escalation: avail.length ? avail.filter((r) => r.escalated).length / avail.length : null,
    p50: pct(50), p90: pct(90), max: walls.length ? walls[walls.length - 1] : null,
  };
}

function fmtRate(x) {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

export function renderMarkdown(site, rows, m, startedAt) {
  const lines = [
    "# ClaudeRabbit 2.0 labeled-set results",
    "",
    `Run: ${startedAt} against \`${site}/api/scan\` by \`node scripts/labeled-run.mjs\`. Set: \`tests/labeled/set.json\`.`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Entries | ${m.total} (available ${m.available}, unavailable ${m.unavailable}) |`,
    `| Confusion (malicious = positive, flagged = High risk or Malicious) | TP ${m.tp}, FP ${m.fp}, FN ${m.fn}, TN ${m.tn} |`,
    `| Precision | ${fmtRate(m.precision)} |`,
    `| Recall | ${fmtRate(m.recall)} |`,
    `| Escalation (Caution or worse) | ${fmtRate(m.escalation)} |`,
    `| Wall time p50 / p90 / max | ${m.p50 ?? "n/a"} ms / ${m.p90 ?? "n/a"} ms / ${m.max ?? "n/a"} ms |`,
    "",
    "| id | expected | verdict | score | status | wall ms | engine total ms | events | note |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.expected} | ${r.verdict ?? ""} | ${r.score ?? ""} | ${r.status} | ${r.wallMs} | ${r.engineMs ?? ""} | ${r.events} | ${(r.reason ?? "").replace(/\|/g, "/")} |`);
  }
  return lines.join("\n") + "\n";
}

async function scanOne(site, e, opts) {
  const headers = { "content-type": "application/json", accept: "application/x-ndjson" };
  if (process.env.CR_OPERATOR_KEY) headers["x-cr-operator-key"] = process.env.CR_OPERATOR_KEY;
  if (opts.regenerate) headers["x-cr-regenerate"] = "1";
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const t0 = Date.now();
  let final;
  let events = 0;
  try {
    const res = await fetch(`${site}/api/scan`, { method: "POST", headers, body: JSON.stringify(requestFor(e)), signal: AbortSignal.timeout(180_000) });
    ({ final, events } = await readFinal(res));
  } catch (err) {
    final = { type: "error", code: "client", message: err instanceof Error ? err.message : String(err) };
  }
  const wallMs = Date.now() - t0;
  const j = judge(e, final);
  const report = final.type === "result" ? final.report : null;
  const engineMs = report?.timings ? Object.values(report.timings).reduce((a, b) => Math.max(a, Number(b) || 0), 0) : null;
  return { id: e.id, expected: e.expected, verdict: report?.verdict ?? null, score: report?.score ?? null, outcome: final.outcome ?? null, wallMs, engineMs, events, ...j };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = JSON.parse(readFileSync(SET, "utf8"));
  const errors = validateSet(doc);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  let entries = doc.entries;
  if (opts.only) entries = entries.filter((e) => opts.only.has(e.id));
  if (opts.limit) entries = entries.slice(0, opts.limit);
  const counts = { clean: entries.filter((e) => e.expected === "clean").length, malicious: entries.filter((e) => e.expected === "malicious").length };
  if (opts.dryRun) {
    for (const e of entries) console.log(`${e.id}\t${JSON.stringify(requestFor(e))}`);
    console.log(`dry run: ${entries.length} entries valid (clean ${counts.clean}, malicious ${counts.malicious}); no request sent`);
    return;
  }
  if (!opts.site) throw new Error("--site is required (the deployed preview origin)");
  if (entries.some((e) => e.kind === "tarball") && !process.env.CR_OPERATOR_KEY) throw new Error("CR_OPERATOR_KEY is required: the set holds operator tarball entries");
  const startedAt = new Date().toISOString();
  const rows = new Array(entries.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, entries.length) }, async () => {
      while (next < entries.length) {
        const k = next++;
        rows[k] = await scanOne(opts.site, entries[k], opts);
        const r = rows[k];
        console.log(`${r.status.padEnd(11)} ${r.id} ${r.verdict ?? ""} ${r.score ?? ""} ${r.wallMs}ms ${r.reason ?? ""}`);
      }
    }),
  );
  const m = metrics(rows);
  writeFileSync(opts.out, renderMarkdown(opts.site, rows, m, startedAt));
  console.log(`precision ${fmtRate(m.precision)} recall ${fmtRate(m.recall)} escalation ${fmtRate(m.escalation)} unavailable ${m.unavailable}; wrote ${path.relative(ROOT, opts.out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
