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
import { cacheHitLedger, type CostLedger } from "../engine/cost";
import { identify, identityBackend, bearerToken, type Identity } from "../engine/auth";
import { DEFAULT_SITE_URL, fullInstallDeadlines, isOperatorKey, loadEngineConfig, missingKeys, type EngineConfig } from "../engine/config";
import { productionDeps } from "../engine/deps";
import { runScan, type RunScanOptions } from "../engine/orchestrator";
import { checkDailyQuota, checkRateLimit, clientIp, type HeaderSource, type RateLimitDecision } from "../engine/ratelimit";
import { parseGithubTarget } from "../engine/resolve/github";
import { isValidNpmName, parseNpmTarget } from "../engine/resolve/npm";
import { validateOperatorTarball } from "../engine/resolve/tarball";
import type { SqlExecutor } from "../engine/db";
import type { V2Store } from "../engine/store";
import type { Ad, ErrorCode, ReportPayload, ScanCaller, ScanEvent, ScanTarget, Surface } from "../engine/types";

/** Request body cap for POST /api/scan. */
export const MAX_BODY_BYTES = 4096;
/** How often a follower checks a run another request owns. */
export const FOLLOW_POLL_MS = 400;

export type FinalLine =
  | { type: "result"; outcome: "cached" | "fresh"; run_id: string; report: ReportPayload; report_url: string; ad: Ad; cost: CostLedger | null }
  | { type: "error"; code: ErrorCode; message: string; run_id: string | null; ad: Ad; signInUrl?: string; retryAfter?: number };

export type ParsedTarget = { ok: true; target: ScanTarget; regenerate: boolean; deviceId: string | null; full?: boolean; fresh?: boolean; testInstallLimitS?: number } | { ok: false; message: string };

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
  const r = parseScanTarget(body);
  if (!r.ok) return r;
  const b = body as Record<string, unknown>;
  // Test hook, honoured on a Vercel Preview only (the route checks): a shorter
  // install limit, to exercise "Keep installing?" on a repo that installs quickly.
  const t = b.test_install_limit_s;
  const testInstallLimitS = typeof t === "number" && Number.isInteger(t) && t >= 5 && t <= 59 ? t : undefined;
  return { ...r, full: b.full === true, ...(b.fresh === true ? { fresh: true } : {}), ...(testInstallLimitS ? { testInstallLimitS } : {}) };
}

function parseScanTarget(body: unknown): ParsedTarget {
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

/**
 * Put a result a signed-in caller received into their history (v2.user_scans).
 * Guests (no user id) are never recorded. Best effort: a history write that
 * fails never fails the scan, and the message carries no id or secret.
 */
export async function recordUserScan(store: Pick<V2Store, "recordUserScan">, userId: string | null, runId: string): Promise<void> {
  if (!userId) return;
  try {
    await store.recordUserScan(userId, runId);
  } catch (err) {
    console.error("user scan history write failed:", err instanceof Error ? err.message.slice(0, 200) : "unknown error");
  }
}

/**
 * The gate a CLI or MCP cache miss passes before any VM boots: a signed-in key within its daily quota. The web and
 * the operator have none; stored reports never reach it.
 */
export function freshScanGate(db: SqlExecutor, caller: ScanCaller): (() => Promise<{ allowed: true } | { allowed: false; message: string; code?: "unauthorized" | "rate_limited" }>) | undefined {
  if (caller.surface === "web" || caller.operator) return undefined;
  if (!caller.userId) return async () => ({ allowed: false, code: "unauthorized", message: "a fresh scan needs a ClaudeRabbit account: run `clauderabbit login`; stored reports are free" });
  return () => checkDailyQuota(db, caller);
}

/** Run one scan end to end on the production pipeline and produce the final line. */
export async function executeScan(
  ctx: CallerContext,
  target: ScanTarget,
  regenerate: boolean,
  opts: Pick<RunScanOptions, "onEvent" | "background" | "onPersisted"> & { signal?: AbortSignal; full?: boolean; fresh?: boolean; testInstallMs?: number; runId?: string },
): Promise<FinalLine> {
  const { store, caller } = ctx;
  const full = opts.full === true;
  const base = opts.testInstallMs ? { ...ctx.config, deadlines: { ...ctx.config.deadlines, installMs: opts.testInstallMs } } : ctx.config;
  const config = full ? { ...base, deadlines: fullInstallDeadlines(base.deadlines), heartbeatSandboxes: true } : base;
  const ad = adForSurface(config, caller.surface, target);
  const deps = { ...productionDeps(config, store), ...(opts.runId ? { newRunId: () => opts.runId! } : {}) };
  const beforeFresh = freshScanGate(store.db, caller);
  const outcome = await runScan({ target, caller, regenerate: regenerate && caller.operator, ...(full ? { full } : {}), ...(opts.fresh ? { fresh: true } : {}) }, deps, { onEvent: opts.onEvent, background: opts.background, onPersisted: opts.onPersisted, ...(beforeFresh ? { beforeFresh } : {}), ...(full && opts.signal ? { stop: opts.signal } : {}) });
  const reportUrl = reportUrlFor(config.siteUrl, target);
  if (outcome.kind === "miss") return { type: "error", code: "internal", message: "no stored run", run_id: null, ad };
  if (outcome.kind === "error") return { type: "error", code: outcome.code, message: outcome.message, run_id: outcome.runId, ad, ...(outcome.code === "unauthorized" ? { signInUrl: `${config.siteUrl}/cli-auth` } : {}) };
  if (outcome.kind === "attached") {
    const followed = await followRun(store, outcome.runId, { deadlineMs: config.deadlines.scanMs + 15_000, now: deps.now, onEvent: opts.onEvent, signal: opts.signal });
    // The joined run's cost belongs to the request that started it; this request spent nothing.
    if ("report" in followed) await recordUserScan(store, caller.userId, outcome.runId);
    if ("report" in followed) return { type: "result", outcome: "fresh", run_id: outcome.runId, report: followed.report, report_url: reportUrl, ad, cost: cacheHitLedger({ jevModel: config.jevModelId, lunaModel: config.modelId, fx: config.fx }) };
    return { type: "error", code: followed.error, message: followed.message, run_id: outcome.runId, ad };
  }
  // Fresh: this request's ledger. Cached: no model call and no sandbox ran, so a zero ledger.
  const cost = outcome.kind === "fresh" ? (outcome.report.cost ?? null) : cacheHitLedger({ jevModel: config.jevModelId, lunaModel: config.modelId, fx: config.fx });
  await recordUserScan(store, caller.userId, outcome.runId);
  return { type: "result", outcome: outcome.kind, run_id: outcome.runId, report: outcome.report, report_url: reportUrl, ad, cost };
}

/**
 * The stored run for this target, served from the request itself: its events replay through onEvent and its final
 * line comes back. Null when there is none (nothing was claimed or booted), so the caller starts a fresh scan.
 */
export async function probeStored(ctx: CallerContext, target: ScanTarget, onEvent: (e: ScanEvent) => void): Promise<FinalLine | null> {
  const { store, caller, config } = ctx;
  const deps = productionDeps(config, store);
  const outcome = await runScan({ target, caller, regenerate: false }, deps, { onEvent: (e) => { if (e.replayed) onEvent(e); }, cacheOnly: true });
  if (outcome.kind !== "cached") return null;
  await recordUserScan(store, caller.userId, outcome.runId);
  return { type: "result", outcome: "cached", run_id: outcome.runId, report: outcome.report, report_url: reportUrlFor(config.siteUrl, target), ad: adForSurface(config, caller.surface, target), cost: cacheHitLedger({ jevModel: config.jevModelId, lunaModel: config.modelId, fx: config.fx }) };
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
