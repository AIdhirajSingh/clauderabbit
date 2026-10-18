/**
 * Server-side scan service shared by every surface (DESIGN.md section 8):
 * the web API route (`/api/scan`, NDJSON or SSE), the remote MCP route
 * (`/mcp`, in-process) and, through `/api/scan`, the CLI and stdio MCP.
 *
 * One pipeline: parse the target, identify the caller, apply the burst floor,
 * run `runScan` on the production deps with the v2 store (schema v2, role
 * cr_v2_server), follow a run that another request already started, and attach
 * an ad to every final line. Server-only; the database URL never leaves this
 * module's process.
 */

import { adFor, type AdTarget } from "../engine/ads";
import { identify, identityBackend, bearerToken, type Identity } from "../engine/auth";
import { DEFAULT_SITE_URL, isOperatorKey, loadEngineConfig, missingKeys, type EngineConfig } from "../engine/config";
import { productionDeps } from "../engine/deps";
import { runScan } from "../engine/orchestrator";
import { checkRateLimit, clientIp, type HeaderSource, type RateLimitDecision } from "../engine/ratelimit";
import { parseGithubTarget } from "../engine/resolve/github";
import { isValidNpmName, parseNpmTarget } from "../engine/resolve/npm";
import { validateOperatorTarball } from "../engine/resolve/tarball";
import type { V2Store } from "../engine/store";
import type { Ad, ErrorCode, ReportPayload, ScanCaller, ScanEvent, ScanTarget, Surface } from "../engine/types";

/** Request body cap for POST /api/scan. */
export const MAX_BODY_BYTES = 4096;
/** How often a follower checks a run another request owns. */
export const FOLLOW_POLL_MS = 400;

export type FinalLine =
  | { type: "result"; outcome: "cached" | "fresh"; run_id: string; report: ReportPayload; report_url: string; ad: Ad }
  | { type: "error"; code: ErrorCode; message: string; run_id: string | null; ad: Ad; signInUrl?: string; retryAfter?: number };

export type ParsedTarget = { ok: true; target: ScanTarget; regenerate: boolean; deviceId: string | null } | { ok: false; message: string };

function s(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Accepts `{ target: "owner/repo" | "github:owner/repo" | "npm:name[@version]" | url, ref?, deviceId? }`
 * or the structured `{ ecosystem: "github", owner, repo, ref? } | { ecosystem: "npm", package, version? }`
 * or the operator-only `{ ecosystem: "tarball", url, integrity, label }` (the route refuses it without a valid
 * `x-cr-operator-key`, and the orchestrator checks again).
 */
export function parseScanBody(body: unknown): ParsedTarget {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const deviceRaw = s(b.deviceId);
  const deviceId = deviceRaw && /^[A-Za-z0-9_-]{8,64}$/.test(deviceRaw) ? deviceRaw : null;
  const regenerate = false;
  if (b.ecosystem === "npm") {
    const name = s(b.package);
    if (!name || !isValidNpmName(name)) return { ok: false, message: "package must be a valid npm package name" };
    const version = s(b.version);
    return { ok: true, target: { kind: "npm", name, ...(version ? { version } : {}) }, regenerate, deviceId };
  }
  if (b.ecosystem === "tarball") {
    const url = s(b.url);
    const integrity = s(b.integrity);
    const label = s(b.label);
    if (!url || !integrity || !label) return { ok: false, message: "tarball targets need url, integrity and label" };
    try {
      validateOperatorTarball({ url, integrity, label });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "invalid tarball target" };
    }
    return { ok: true, target: { kind: "tarball", url, integrity, label }, regenerate, deviceId };
  }
  if (b.ecosystem === "github") {
    const spec = parseGithubTarget(`${s(b.owner) ?? ""}/${s(b.repo) ?? ""}`);
    if (!spec) return { ok: false, message: "owner and repo must name a GitHub repository" };
    const ref = s(b.ref);
    return { ok: true, target: { kind: "github", owner: spec.owner, repo: spec.repo, ...(ref ? { ref } : {}) }, regenerate, deviceId };
  }
  const raw = s(b.target);
  if (!raw || raw.length > 512) return { ok: false, message: "target is required: owner/repo, a GitHub URL, or npm:name[@version]" };
  const explicitNpm = /^npm:/i.test(raw) || /npmjs\.com\/package\//i.test(raw);
  if (!explicitNpm) {
    const gh = parseGithubTarget(raw);
    if (gh) {
      const ref = s(b.ref) ?? gh.ref;
      return { ok: true, target: { kind: "github", owner: gh.owner, repo: gh.repo, ...(ref ? { ref } : {}) }, regenerate, deviceId };
    }
  }
  const npm = parseNpmTarget(raw);
  if (npm) return { ok: true, target: { kind: "npm", name: npm.name, ...(npm.version ? { version: npm.version } : {}) }, regenerate, deviceId };
  return { ok: false, message: "target is not a GitHub repository or an npm package" };
}

export function adTargetOf(target: ScanTarget): AdTarget {
  if (target.kind === "github") return { kind: "github", name: `${target.owner}/${target.repo}` };
  if (target.kind === "npm") return { kind: "npm", name: target.name };
  return { kind: "tarball", name: target.label };
}

/** Public report page for a target: `/owner/repo` or `/npm/<name>`. */
export function reportUrlFor(siteUrl: string, target: ScanTarget): string {
  const origin = new URL(siteUrl).origin;
  if (target.kind === "github") return `${origin}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  if (target.kind === "npm") return `${origin}/npm/${target.name.split("/").map(encodeURIComponent).join("/")}`;
  return `${origin}/`;
}

/** Supabase Realtime topic a run's events are broadcast on (public channel, event name = type). */
export function realtimeChannel(runId: string): string {
  return `scan:${runId}`;
}

/** The scan_runs subject for a replay target: `owner/repo` or `npm:<name>`. */
export function replaySubject(target: string): string | null {
  const t = target.trim();
  if (/^npm:/i.test(t)) {
    const n = parseNpmTarget(t);
    return n ? `npm:${n.name}` : null;
  }
  const g = parseGithubTarget(t);
  return g ? `${g.owner}/${g.repo}` : null;
}

export function surfaceFromHeader(v: string | null): Surface {
  return v === "cli" ? "cli" : v === "mcp" ? "mcp" : "web";
}

export function serverConfig(): EngineConfig {
  return loadEngineConfig(process.env);
}

export interface CallerContext {
  config: EngineConfig;
  store: V2Store;
  identity: Identity | null;
  caller: ScanCaller;
}

/** Build the caller from request headers. Identity failures are null identity, never a throw. */
export async function callerFrom(headers: HeaderSource, surface: Surface, deviceId: string | null, config: EngineConfig, store: V2Store): Promise<CallerContext> {
  let identity: Identity | null = null;
  try {
    identity = await identify(identityBackend(store.db, config), bearerToken(headers.get("authorization")));
  } catch {
    identity = null;
  }
  const operator = isOperatorKey(config, headers.get("x-cr-operator-key"));
  return { config, store, identity, caller: { surface, userId: identity?.userId ?? null, ip: clientIp(headers), deviceId, operator } };
}

export async function rateLimitFor(ctx: CallerContext): Promise<RateLimitDecision | null> {
  if (ctx.caller.operator) return null;
  return checkRateLimit(ctx.store.db, ctx.caller);
}

export function adForSurface(config: EngineConfig, surface: Surface, target: ScanTarget | null): Ad {
  return adFor(surface, { siteUrl: config.siteUrl, adsense: config.adsense, target: target ? adTargetOf(target) : null });
}

/**
 * The ad for a response when the server config can fail to load (config error
 * paths, replay routes): the configured ad when the config loads, otherwise our
 * house ad on the default site URL. Every response carries an ad.
 */
export function adForRequest(surface: Surface, target: ScanTarget | null): Ad {
  try {
    return adForSurface(serverConfig(), surface, target);
  } catch {
    return adFor(surface, { siteUrl: DEFAULT_SITE_URL, adsense: { clientId: null, slotId: null, adtest: "on" }, target: target ? adTargetOf(target) : null });
  }
}

/** NAMES of the server env vars a fresh scan needs that are absent. */
export function missingServerKeys(config: EngineConfig): string[] {
  return missingKeys(config);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Follow a run another request owns: stream its stored events as they land and
 * return its report when it finishes. Bounded by the scan deadline plus slack.
 */
export async function followRun(store: V2Store, runId: string, opts: { deadlineMs: number; now: () => number; onEvent?: (e: ScanEvent) => void; signal?: AbortSignal }): Promise<{ report: ReportPayload } | { error: ErrorCode; message: string }> {
  const until = opts.now() + opts.deadlineMs;
  let lastSeq = -1;
  while (opts.now() < until && !opts.signal?.aborted) {
    const events = await store.loadEvents(runId);
    for (const e of events) {
      if (e.seq > lastSeq) {
        lastSeq = e.seq;
        opts.onEvent?.(e);
      }
    }
    const run = await store.loadRun(runId);
    if (!run) return { error: "internal", message: "the run being followed no longer exists" };
    if (run.status === "error") return { error: (run.error_code as ErrorCode) ?? "internal", message: `the scan this request joined ended with ${run.error_code ?? "an error"}` };
    if (run.status === "done") {
      const hit = await store.findCached(run.subject, run.commit_sha);
      if (hit && hit.runId === runId) return { report: hit.report };
      return { error: "internal", message: "the joined scan finished without a stored report" };
    }
    await sleep(FOLLOW_POLL_MS, opts.signal);
  }
  return { error: "timeout", message: "the joined scan did not finish before the deadline" };
}

/** Run one scan end to end on the production pipeline and produce the final line. */
export async function executeScan(ctx: CallerContext, target: ScanTarget, regenerate: boolean, opts: { onEvent?: (e: ScanEvent) => void; signal?: AbortSignal }): Promise<FinalLine> {
  const { config, store, caller } = ctx;
  const ad = adForSurface(config, caller.surface, target);
  const deps = productionDeps(config, store);
  const outcome = await runScan({ target, caller, regenerate: regenerate && caller.operator }, deps, { onEvent: opts.onEvent });
  const reportUrl = reportUrlFor(config.siteUrl, target);
  if (outcome.kind === "error") return { type: "error", code: outcome.code, message: outcome.message, run_id: outcome.runId, ad };
  if (outcome.kind === "attached") {
    const followed = await followRun(store, outcome.runId, { deadlineMs: config.deadlines.scanMs + 15_000, now: deps.now, onEvent: opts.onEvent, signal: opts.signal });
    if ("report" in followed) return { type: "result", outcome: "fresh", run_id: outcome.runId, report: followed.report, report_url: reportUrl, ad };
    return { type: "error", code: followed.error, message: followed.message, run_id: outcome.runId, ad };
  }
  return { type: "result", outcome: outcome.kind, run_id: outcome.runId, report: outcome.report, report_url: reportUrl, ad };
}

/** HTTP status for a pre-stream error code. */
export function statusFor(code: ErrorCode): number {
  switch (code) {
    case "invalid_target":
      return 400;
    case "unauthorized":
      return 401;
    case "not_found":
    case "private_repo":
      return 404;
    case "rate_limited":
      return 429;
    case "too_large":
      return 413;
    case "budget_exhausted":
    case "capacity":
    case "internal":
      return 503;
    default:
      return 502;
  }
}
