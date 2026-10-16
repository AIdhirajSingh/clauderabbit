/**
 * Persistence seam for the engine (DESIGN.md sections 4, 6, 7).
 *
 * The orchestrator talks to storage only through `ScanStore`: the SHA cache,
 * the per-(subject, SHA) running-run dedup, the event log that a database
 * trigger broadcasts on Realtime topic `scan:<run_id>`, the report row the
 * existing pages read, and the daily spend floor. The Supabase implementation
 * (tables `scan_runs`, `scan_events`, `reports`, `scan_budget`, RPC
 * `scan_budget_charge`, migrations 20261016000001 to 20261016000003) is
 * `SupabaseStore` below; tests use an in-memory implementation under tests/support.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EngineConfig } from "./config";
import type { OwnerCache, OwnerInfo } from "./reputation";
import { bandFor } from "./score";
import { EngineError, SCAN_EVENT_TYPES, type ErrorCode, type ReportPayload, type ScanEvent, type ScanEventType, type ScoreDelta, type Verdict } from "./types";

export type TargetKind = "github" | "npm" | "tarball";

export interface CachedRun {
  runId: string;
  report: ReportPayload;
  /** The stored events of that run, ordered by seq. */
  events: ScanEvent[];
}

export interface ClaimRequest {
  runId: string;
  targetKind: TargetKind;
  /** `owner/repo`, `npm:<name>` or `tarball:<label>`. */
  subject: string;
  /** Git SHA, or `<version>+<sha512 integrity>` for npm and tarball targets. */
  commitSha: string;
  modelId: string;
  template: string;
}

export type ClaimResult = { status: "claimed"; runId: string } | { status: "running"; runId: string };

/** Everything the reports-table mapping needs (DESIGN.md section 7.3). */
export interface ReportRecord {
  runId: string;
  targetKind: TargetKind;
  subject: string;
  /** `owner_login` / `repo_name` for the existing pages (`npm` + package name for npm). */
  ownerLogin: string;
  repoName: string;
  commitSha: string;
  report: ReportPayload;
  /** Per-surface report fields: dependency list with OSV results, findings, stage chapters. */
  packages: unknown;
  risky: unknown;
  logs: unknown;
  stats: unknown;
}

export interface BudgetCharge {
  sandboxSeconds: number;
  tokens: number;
  capSeconds: number;
  capTokens: number;
}

export interface ScanStore {
  readonly ownerCache: OwnerCache;
  /** Latest completed run for this subject and SHA, with its events. */
  findCached(subject: string, commitSha: string): Promise<CachedRun | null>;
  /** Insert a running row; when one is already running for the same key, return it instead. */
  claimRun(req: ClaimRequest): Promise<ClaimResult>;
  /** Append a batch of events (ordered by seq). */
  appendEvents(events: ScanEvent[]): Promise<void>;
  /** Upsert the report row and link it to the run. */
  saveReport(record: ReportRecord): Promise<void>;
  finishRun(runId: string, result: { status: "done" | "error"; errorCode?: ErrorCode; timings: Record<string, number> }): Promise<void>;
  /**
   * Add usage to today's budget. Returns false when the day is already over a
   * cap (the charge is not applied); a zero charge is a pure check.
   */
  chargeBudget(charge: BudgetCharge): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------
// Supabase implementation
// ---------------------------------------------------------------------------------------------------

/** Owner rows older than this are refreshed from GitHub. */
export const OWNER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Upper bound on events read back for one run (the engine persists at most 600). */
export const MAX_REPLAY_EVENTS = 1000;
/** Events per insert request. */
const EVENT_INSERT_CHUNK = 200;

type UiSeverity = "high" | "med" | "low";
type UiKind = "behavior" | "code" | "rep";

export interface RiskyRow {
  title: string;
  severity: UiSeverity;
  kind: UiKind;
  detail: string;
}

export interface LogRow {
  ch: string;
  kind: "ok" | "warn" | "bad";
  lines: string[];
}

/** The `reports` row the engine writes (DESIGN.md section 7.3). */
export interface ReportsUpsertRow {
  owner_login: string;
  repo_name: string;
  commit_sha: string;
  score: number;
  verdict: string;
  summary: string;
  scan_path: "run";
  deep: true;
  cached: false;
  stats_json: Record<string, unknown>;
  packages_json: unknown;
  risky_json: RiskyRow[];
  logs_json: LogRow[];
  forensics_json: unknown;
  run_id: string;
  score_breakdown: ScoreDelta[];
  not_verified: string[];
}

interface FindingLike {
  severity?: unknown;
  title?: unknown;
  message?: unknown;
  rule?: unknown;
  file?: unknown;
  line?: unknown;
  rationale?: unknown;
  reader?: unknown;
  source?: unknown;
}

function uiSeverity(v: unknown): UiSeverity {
  return v === "high" ? "high" : v === "medium" || v === "med" ? "med" : "low";
}

function findingToRisky(f: FindingLike): RiskyRow | null {
  if (!f || typeof f !== "object") return null;
  const where = typeof f.file === "string" && f.file ? ` (${f.file}${typeof f.line === "number" ? `:${f.line}` : ""})` : "";
  if (typeof f.reader === "string") {
    const title = typeof f.title === "string" ? f.title : "Reader finding";
    const detail = typeof f.rationale === "string" ? f.rationale : "";
    return { title: title.slice(0, 200), severity: uiSeverity(f.severity), kind: "code", detail: `${detail}${where}`.slice(0, 1000) };
  }
  const rule = typeof f.rule === "string" ? f.rule : "static rule";
  const source = typeof f.source === "string" ? f.source : "static";
  const message = typeof f.message === "string" ? f.message : "";
  return { title: `${source}: ${rule}`.slice(0, 200), severity: uiSeverity(f.severity), kind: "code", detail: `${message}${where}`.slice(0, 1000) };
}

/**
 * Map an engine report record onto the reports row the existing pages read.
 * Behaviour, code and reputation evidence stay in separate `kind`s.
 */
export function reportsRowFor(record: ReportRecord): ReportsUpsertRow {
  const r = record.report;
  const risky: RiskyRow[] = [];
  for (const text of r.evidence.behaviour) risky.push({ title: "Observed when run", severity: r.score < 60 ? "high" : "low", kind: "behavior", detail: text.slice(0, 1000) });
  if (Array.isArray(record.risky)) {
    for (const f of record.risky as FindingLike[]) {
      const row = findingToRisky(f);
      if (row) risky.push(row);
    }
  }
  for (const text of r.evidence.reputation) risky.push({ title: "Reputation signal", severity: "low", kind: "rep", detail: text.slice(0, 1000) });

  const logs: LogRow[] = [];
  if (Array.isArray(record.logs)) {
    for (const l of record.logs as Array<{ name?: unknown; ms?: unknown }>) {
      if (typeof l?.name !== "string" || typeof l.ms !== "number") continue;
      logs.push({ ch: l.name, kind: "ok", lines: [`${Math.round(l.ms)} ms`] });
    }
  }

  const stats = record.stats && typeof record.stats === "object" ? (record.stats as Record<string, unknown>) : {};
  return {
    owner_login: record.ownerLogin,
    repo_name: record.repoName,
    commit_sha: record.commitSha,
    score: r.score,
    verdict: r.verdict,
    summary: r.summary,
    scan_path: "run",
    deep: true,
    cached: false,
    stats_json: {
      ...stats,
      target: r.target,
      headline: r.headline,
      evidence: r.evidence,
      writer: r.writer,
      band: r.band,
      model_id: r.model_id,
      template: r.template,
    },
    packages_json: record.packages ?? null,
    risky_json: risky.slice(0, 200),
    logs_json: logs,
    forensics_json: r.forensics ?? null,
    run_id: record.runId,
    score_breakdown: r.breakdown,
    not_verified: r.not_verified,
  };
}

/** The reports columns findCached reads back. */
export interface StoredReportRow {
  id: number;
  commit_sha: string;
  score: number;
  verdict: string;
  summary: string | null;
  stats_json: Record<string, unknown> | null;
  packages_json: unknown;
  forensics_json: unknown;
  run_id: string | null;
  score_breakdown: unknown;
  not_verified: unknown;
}

const VERDICTS: readonly Verdict[] = ["No threats observed", "Low risk", "Caution", "High risk", "Malicious"];

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Rebuild the ReportPayload of a completed run from its reports row and run row. */
export function payloadFromRows(row: StoredReportRow, run: { id: string; subject: string; model_id: string | null; template: string | null; timings: unknown }): ReportPayload {
  const stats = row.stats_json ?? {};
  const ev = (stats.evidence ?? {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(row.verdict as Verdict) ? (row.verdict as Verdict) : null;
  if (!verdict) throw new EngineError("internal", `stored report ${row.id} has a verdict outside the 2.0 set`);
  const timings: Record<string, number> = {};
  if (run.timings && typeof run.timings === "object") {
    for (const [k, v] of Object.entries(run.timings as Record<string, unknown>)) if (typeof v === "number") timings[k] = v;
  }
  return {
    run_id: run.id,
    target: typeof stats.target === "string" ? stats.target : run.subject,
    commit_sha: row.commit_sha,
    score: row.score,
    verdict,
    band: bandFor(row.score),
    summary: row.summary ?? "",
    headline: typeof stats.headline === "string" ? stats.headline : "",
    evidence: { behaviour: strArray(ev.behaviour), code: strArray(ev.code), reputation: strArray(ev.reputation) },
    breakdown: Array.isArray(row.score_breakdown) ? (row.score_breakdown as ScoreDelta[]) : [],
    not_verified: strArray(row.not_verified),
    forensics: row.forensics_json ?? null,
    packages: row.packages_json ?? null,
    model_id: run.model_id ?? (typeof stats.model_id === "string" ? stats.model_id : ""),
    template: run.template ?? (typeof stats.template === "string" ? stats.template : ""),
    timings,
    writer: stats.writer === "model" ? "model" : "deterministic",
  };
}

interface EventRow {
  run_id: string;
  seq: number;
  t_ms: number;
  type: string;
  data: unknown;
}

export function eventFromRow(row: EventRow): ScanEvent | null {
  if (!SCAN_EVENT_TYPES.includes(row.type as ScanEventType)) return null;
  return { run_id: row.run_id, seq: row.seq, t_ms: row.t_ms, type: row.type, data: row.data } as ScanEvent;
}

export function eventToRow(e: ScanEvent): EventRow {
  return { run_id: e.run_id, seq: e.seq, t_ms: Math.max(0, Math.round(e.t_ms)), type: e.type, data: e.data };
}

interface DbError {
  code?: string;
  message: string;
}

function fail(what: string, err: DbError): never {
  throw new EngineError("internal", `${what}: ${err.message}`);
}

export interface DoneRun {
  runId: string;
  subject: string;
  commitSha: string;
}

/**
 * ScanStore on Supabase. Server-only: it is built from the secret key, which
 * never reaches a client. Reads the replay surfaces need are methods here too.
 */
export class SupabaseStore implements ScanStore {
  readonly db: SupabaseClient;
  private readonly now: () => number;

  constructor(db: SupabaseClient, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  readonly ownerCache: OwnerCache = {
    get: async (login) => {
      const { data, error } = await this.db
        .from("owners")
        .select("github_login, created_at_github, public_repos, reputation_json, fetched_at")
        .eq("github_login", login)
        .maybeSingle();
      if (error) fail("owners read", error);
      if (!data) return null;
      const fetched = Date.parse(String(data.fetched_at));
      if (!Number.isFinite(fetched) || this.now() - fetched > OWNER_TTL_MS) return null;
      const rep = (data.reputation_json ?? {}) as Record<string, unknown>;
      return {
        login: String(data.github_login),
        type: typeof rep.type === "string" ? rep.type : "User",
        createdAt: typeof data.created_at_github === "string" ? data.created_at_github : null,
        publicRepos: typeof data.public_repos === "number" ? data.public_repos : 0,
      } satisfies OwnerInfo;
    },
    put: async (info) => {
      const created = info.createdAt ? Date.parse(info.createdAt) : NaN;
      const ageDays = Number.isFinite(created) ? (this.now() - created) / 86_400_000 : 0;
      const { error } = await this.db.from("owners").upsert(
        {
          github_login: info.login,
          created_at_github: info.createdAt,
          public_repos: info.publicRepos,
          established: ageDays > 365 && info.publicRepos >= 3,
          reputation_json: { type: info.type, source: "github-users-api" },
          fetched_at: new Date(this.now()).toISOString(),
        },
        { onConflict: "github_login" },
      );
      if (error) fail("owners write", error);
    },
  };

  async findLatestDoneRun(subject: string, commitSha: string): Promise<{ id: string; subject: string; model_id: string | null; template: string | null; timings: unknown; report_id: number } | null> {
    const { data, error } = await this.db
      .from("scan_runs")
      .select("id, subject, model_id, template, timings, report_id")
      .eq("subject", subject)
      .eq("commit_sha", commitSha)
      .eq("status", "done")
      .not("report_id", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail("scan_runs read", error);
    return (data as { id: string; subject: string; model_id: string | null; template: string | null; timings: unknown; report_id: number } | null) ?? null;
  }

  /** Stored events of a run ordered by seq. */
  async loadEvents(runId: string): Promise<ScanEvent[]> {
    const { data, error } = await this.db
      .from("scan_events")
      .select("run_id, seq, t_ms, type, data")
      .eq("run_id", runId)
      .order("seq", { ascending: true })
      .limit(MAX_REPLAY_EVENTS);
    if (error) fail("scan_events read", error);
    const out: ScanEvent[] = [];
    for (const row of (data ?? []) as EventRow[]) {
      const e = eventFromRow(row);
      if (e) out.push(e);
    }
    return out;
  }

  /** The run row for replay by id. */
  async loadRun(runId: string): Promise<{ id: string; subject: string; commit_sha: string; status: string; error_code: string | null } | null> {
    const { data, error } = await this.db.from("scan_runs").select("id, subject, commit_sha, status, error_code").eq("id", runId).maybeSingle();
    if (error) fail("scan_runs read", error);
    return (data as { id: string; subject: string; commit_sha: string; status: string; error_code: string | null } | null) ?? null;
  }

  async findCached(subject: string, commitSha: string): Promise<CachedRun | null> {
    const run = await this.findLatestDoneRun(subject, commitSha);
    if (!run) return null;
    const { data, error } = await this.db
      .from("reports")
      .select("id, commit_sha, score, verdict, summary, stats_json, packages_json, forensics_json, run_id, score_breakdown, not_verified")
      .eq("id", run.report_id)
      .maybeSingle();
    if (error) fail("reports read", error);
    if (!data) return null;
    const row = data as StoredReportRow;
    // A regenerate can overwrite the shared reports row; serve only the row this run wrote.
    if (row.run_id !== run.id) return null;
    return { runId: run.id, report: payloadFromRows(row, run), events: await this.loadEvents(run.id) };
  }

  async claimRun(req: ClaimRequest): Promise<ClaimResult> {
    const expired = await this.db.rpc("expire_stale_runs");
    if (expired.error) fail("expire_stale_runs", expired.error);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await this.db.from("scan_runs").insert({
        id: req.runId,
        target_kind: req.targetKind,
        subject: req.subject,
        commit_sha: req.commitSha,
        status: "running",
        model_id: req.modelId,
        template: req.template,
      });
      if (!error) return { status: "claimed", runId: req.runId };
      if (error.code !== "23505") fail("scan_runs insert", error);
      const { data, error: readErr } = await this.db
        .from("scan_runs")
        .select("id")
        .eq("subject", req.subject)
        .eq("commit_sha", req.commitSha)
        .eq("status", "running")
        .limit(1)
        .maybeSingle();
      if (readErr) fail("scan_runs read", readErr);
      if (data) return { status: "running", runId: String((data as { id: string }).id) };
      // The other run finished between the insert and the read; claim again.
    }
    throw new EngineError("internal", "scan_runs claim did not settle after a retry");
  }

  async appendEvents(events: ScanEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += EVENT_INSERT_CHUNK) {
      const { error } = await this.db.from("scan_events").insert(events.slice(i, i + EVENT_INSERT_CHUNK).map(eventToRow));
      if (error) fail("scan_events insert", error);
    }
  }

  async saveReport(record: ReportRecord): Promise<void> {
    const row = reportsRowFor(record);
    const { data, error } = await this.db.from("reports").upsert(row, { onConflict: "owner_login,repo_name,commit_sha" }).select("id").single();
    if (error) fail("reports upsert", error);
    const link = await this.db.from("scan_runs").update({ report_id: (data as { id: number }).id }).eq("id", record.runId);
    if (link.error) fail("scan_runs link", link.error);
  }

  async finishRun(runId: string, result: { status: "done" | "error"; errorCode?: ErrorCode; timings: Record<string, number> }): Promise<void> {
    const { error } = await this.db
      .from("scan_runs")
      .update({ status: result.status, error_code: result.errorCode ?? null, finished_at: new Date(this.now()).toISOString(), timings: result.timings })
      .eq("id", runId);
    if (error) fail("scan_runs finish", error);
  }

  async chargeBudget(charge: BudgetCharge): Promise<boolean> {
    const { data, error } = await this.db.rpc("scan_budget_charge", {
      p_sandbox_seconds: Math.max(0, Math.round(charge.sandboxSeconds)),
      p_tokens: Math.max(0, Math.round(charge.tokens)),
      p_cap_seconds: charge.capSeconds,
      p_cap_tokens: charge.capTokens,
    });
    if (error) fail("scan_budget_charge", error);
    return data === true;
  }
}

/** Service client from the server secret. Throws with env var NAMES only. */
export function serviceClient(config: EngineConfig, fetchImpl?: typeof fetch): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    throw new EngineError("internal", "server is missing required configuration: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY");
  }
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

export function createSupabaseStore(config: EngineConfig, fetchImpl?: typeof fetch): SupabaseStore {
  return new SupabaseStore(serviceClient(config, fetchImpl));
}
