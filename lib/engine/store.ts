/**
 * Persistence seam for the engine (DESIGN.md sections 4, 6, 7).
 *
 * The orchestrator talks to storage only through `ScanStore`: the SHA cache,
 * the per-(subject, SHA) running-run dedup, the event log that a database
 * trigger broadcasts on Realtime topic `scan:<run_id>`, the report row the
 * report pages read, and the daily spend floor. The production implementation
 * is `V2Store` below: schema v2 only (tables `v2.scan_runs`, `v2.scan_events`,
 * `v2.reports`, `v2.owners`, `v2.scan_budget`, function `v2.scan_budget_charge`,
 * migrations 20261016000000 to 20261016000003), reached as the role
 * `cr_v2_server`. Tests run it on PGlite and use an in-memory store under tests/support.
 */

import type { EngineConfig } from "./config";
import { ledgerFrom, type CostLedger } from "./cost";
import { postgresExecutor, sqlState, validateDatabaseUrl, type SqlExecutor } from "./db";
import type { OwnerCache, OwnerInfo } from "./reputation";
import { ranFrom } from "./ran";
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
  /** Supabase user id of the signed-in caller; null or absent for a guest (stored as null, shown as Anonymous). */
  userId?: string | null;
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
  /**
   * The request asked for the target's current version (no pinned commit or
   * version), so this commit is what the target is now: stored as ref 'latest',
   * which the danger board prefers over older commits scanned later.
   */
  current?: boolean;
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
  /** Marks a stored report as its target's current version (v2.reports.ref = 'latest'); see ReportRecord.current. */
  markCurrent?(ownerLogin: string, repoName: string, commitSha: string): Promise<void>;
  /** Insert a running row; when one is already running for the same key, return it instead. */
  claimRun(req: ClaimRequest): Promise<ClaimResult>;
  /** Append a batch of events (ordered by seq). */
  appendEvents(events: ScanEvent[]): Promise<void>;
  /** Upsert the report row and link it to the run. */
  saveReport(record: ReportRecord): Promise<void>;
  finishRun(runId: string, result: { status: "done" | "error"; errorCode?: ErrorCode; timings: Record<string, number>; cost?: CostLedger }): Promise<void>;
  /**
   * Add usage to today's budget. Returns false when the day is already over a
   * cap (the charge is not applied); a zero charge is a pure check.
   */
  chargeBudget(charge: BudgetCharge): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------
// Schema v2 implementation (cr_v2_server)
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

/** The `v2.reports` row the engine writes (DESIGN.md section 7.3). */
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
  check?: unknown;
  evidence?: unknown;
  source?: unknown;
}

function uiSeverity(v: unknown): UiSeverity {
  return v === "high" ? "high" : v === "medium" || v === "med" ? "med" : "low";
}

function findingToRisky(f: FindingLike): RiskyRow | null {
  if (!f || typeof f !== "object") return null;
  const where = typeof f.file === "string" && f.file ? ` (${f.file}${typeof f.line === "number" ? `:${f.line}` : ""})` : "";
  if (typeof f.check === "string") {
    // A Jev check answer: a judgement of code that was read, shown as code evidence with its pointers.
    const title = typeof f.title === "string" ? f.title : `Jev ${f.check} check`;
    const pointers = Array.isArray(f.evidence) ? f.evidence.filter((e): e is string => typeof e === "string").join("; ") : "";
    return { title: title.slice(0, 200), severity: uiSeverity(f.severity), kind: "code", detail: `${pointers}${where}`.slice(0, 1000) };
  }
  const rule = typeof f.rule === "string" ? f.rule : "static rule";
  const source = typeof f.source === "string" ? f.source : "static";
  const message = typeof f.message === "string" ? f.message : "";
  return { title: `${source}: ${rule}`.slice(0, 200), severity: uiSeverity(f.severity), kind: "code", detail: `${message}${where}`.slice(0, 1000) };
}

/**
 * Map an engine report record onto the v2.reports row the report pages read.
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
      jev_model_id: r.jev_model_id ?? null,
      score_rules: r.score_rules ?? null,
      label: r.label ?? null,
      reputation_section: r.reputation_section ?? null,
      luna_report: r.luna_report ?? null,
      partial: r.partial ?? null,
      partial_reason: r.partial_reason ?? null,
      ran: r.ran ?? null,
      template: r.template,
      cost: r.cost ?? null,
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
  id: number | string;
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
export function payloadFromRows(row: StoredReportRow, run: { id: string; subject: string; model_id: string | null; template: string | null; timings: unknown; cost?: unknown }): ReportPayload {
  const stats = row.stats_json ?? {};
  const ev = (stats.evidence ?? {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(row.verdict as Verdict) ? (row.verdict as Verdict) : null;
  if (!verdict) throw new EngineError("internal", `stored report ${row.id} has a verdict outside the 2.0 set`);
  const ledger = ledgerFrom(run.cost) ?? ledgerFrom(stats.cost);
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
    ...(typeof stats.jev_model_id === "string" ? { jev_model_id: stats.jev_model_id } : {}),
    ...(typeof stats.score_rules === "number" ? { score_rules: stats.score_rules } : {}),
    ...(typeof stats.label === "string" ? { label: stats.label } : {}),
    ...(stats.reputation_section && typeof stats.reputation_section === "object" ? { reputation_section: stats.reputation_section as ReportPayload["reputation_section"] } : {}),
    ...(lunaReportFrom(stats.luna_report) ? { luna_report: lunaReportFrom(stats.luna_report)! } : {}),
    ...(stats.partial === true ? { partial: true } : {}),
    ...(stats.partial === true && typeof stats.partial_reason === "string" ? { partial_reason: stats.partial_reason } : {}),
    ...(ranFrom(stats.ran) ? { ran: ranFrom(stats.ran)! } : {}),
    ...(ledger ? { cost: ledger } : {}),
  };
}

/** The two stored report paragraphs, or null when the row predates them or they are malformed. */
export function lunaReportFrom(v: unknown): ReportPayload["luna_report"] | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.what_ran === "string" && typeof o.what_matters === "string" && o.what_ran && o.what_matters ? { what_ran: o.what_ran, what_matters: o.what_matters } : null;
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

function fail(what: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw new EngineError("internal", `${what}: ${message.slice(0, 300)}`);
}

async function run<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof EngineError) throw err;
    fail(what, err);
  }
}

export interface DoneRun {
  runId: string;
  subject: string;
  commitSha: string;
}

export interface DoneRunRow {
  id: string;
  subject: string;
  model_id: string | null;
  template: string | null;
  timings: unknown;
  cost: unknown;
  report_id: string;
}

/** One entry of a signed-in user's scan history (`V2Store.listUserScans`). */
export interface UserScanRow {
  run_id: string;
  subject: string;
  commit_sha: string;
  /** Null while the run's report row is not written yet. */
  score: number | null;
  verdict: Verdict | null;
  /** ISO-8601 UTC: when this user last received this run's result. */
  scanned_at: string;
}

/** Upper bound on history rows one read returns. */
export const MAX_USER_SCANS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunRow {
  id: string;
  subject: string;
  commit_sha: string;
  status: string;
  error_code: string | null;
}

/** ISO-8601 UTC text for a timestamptz column, identical on every driver. */
const iso = (col: string) => `to_char(${col} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * ScanStore on schema v2, as the cr_v2_server role. Server-only. Reads the
 * replay surfaces need are methods here too.
 */
/**
 * CR_FRESH_SINCE, an ISO time: stored runs that finished before it are not served from the cache and the danger
 * board rescans their targets (lib/server/board-refresh.ts). Unset or unparsable: no cutoff.
 */
export function freshSince(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.CR_FRESH_SINCE?.trim();
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The longest any run may stay 'running': its runner sandbox lives at most 30 minutes
 * (lib/server/runner.ts RUNNER_UNATTENDED_MS), plus five minutes to write its rows.
 */
export const RUN_MAX_MS = 35 * 60_000;

/**
 * End runs that can no longer finish, so no run reads as 'running' forever:
 * - 'stale' after five quiet minutes (no event). Quiet, not since start: on its runner a
 *   scan may build for longer after a Yes, writing events as it goes. Last activity is the
 *   start plus the latest event's t_ms.
 * - 'timeout' once it is older than RUN_MAX_MS, whatever it last wrote.
 * Neither writes a report, so an ended run is never scored. With a run id, only that run.
 */
export async function expireStaleRuns(db: SqlExecutor, runId?: string): Promise<void> {
  await db.query(
    `update v2.scan_runs r
        set status = 'error',
            error_code = case when r.started_at < now() - make_interval(secs => $2::double precision) then 'timeout' else 'stale' end,
            finished_at = now()
      where r.status = 'running'
        and ($1::uuid is null or r.id = $1::uuid)
        and (r.started_at < now() - make_interval(secs => $2::double precision)
             or r.started_at + make_interval(secs => coalesce((select max(e.t_ms) from v2.scan_events e where e.run_id = r.id), 0) / 1000.0)
                < now() - interval '5 minutes')`,
    [runId ?? null, RUN_MAX_MS / 1000],
  );
}

/** End one run that its runner left 'running' (the runner stopped without a final line). No-op once it has ended. */
export async function abandonRun(db: SqlExecutor, runId: string, errorCode: ErrorCode): Promise<void> {
  await db.query("update v2.scan_runs set status = 'error', error_code = $2, finished_at = now() where id = $1::uuid and status = 'running'", [runId, errorCode]);
}

export class V2Store implements ScanStore {
  readonly db: SqlExecutor;
  private readonly now: () => number;

  constructor(db: SqlExecutor, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  readonly ownerCache: OwnerCache = {
    get: async (login) => {
      const rows = await run("owners read", () =>
        this.db.query<{ github_login: string; created_at_github: string | null; public_repos: number | null; reputation_json: unknown; fetched_ms: number }>(
          `select github_login, ${iso("created_at_github")} as created_at_github, public_repos, reputation_json,
                  (extract(epoch from fetched_at) * 1000)::float8 as fetched_ms
             from v2.owners where github_login = $1`,
          [login],
        ),
      );
      const data = rows[0];
      if (!data) return null;
      const fetched = Number(data.fetched_ms);
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
      await run("owners write", () =>
        this.db.query(
          `insert into v2.owners (github_login, created_at_github, public_repos, established, reputation_json, fetched_at)
           values ($1, $2::timestamptz, $3::int, $4::boolean, $5::text::jsonb, $6::timestamptz)
           on conflict (github_login) do update
              set created_at_github = excluded.created_at_github,
                  public_repos      = excluded.public_repos,
                  established       = excluded.established,
                  reputation_json   = excluded.reputation_json,
                  fetched_at        = excluded.fetched_at`,
          [
            info.login,
            Number.isFinite(created) ? new Date(created).toISOString() : null,
            Math.max(0, Math.round(info.publicRepos)),
            ageDays > 365 && info.publicRepos >= 3,
            JSON.stringify({ type: info.type, source: "github-users-api" }),
            new Date(this.now()).toISOString(),
          ],
        ),
      );
    },
  };

  async findLatestDoneRun(subject: string, commitSha: string, notBefore: string | null = null): Promise<DoneRunRow | null> {
    const rows = await run("scan_runs read", () =>
      this.db.query<DoneRunRow>(
        `select id::text as id, subject, model_id, template, timings, cost, report_id::text as report_id
           from v2.scan_runs
          where subject = $1 and commit_sha = $2 and status = 'done' and report_id is not null
            and ($3::timestamptz is null or finished_at >= $3::timestamptz)
          order by finished_at desc nulls last, started_at desc
          limit 1`,
        [subject, commitSha, notBefore],
      ),
    );
    return rows[0] ?? null;
  }

  /** Stored events of a run ordered by seq. */
  async loadEvents(runId: string): Promise<ScanEvent[]> {
    const rows = await run("scan_events read", () =>
      this.db.query<EventRow>(`select run_id::text as run_id, seq, t_ms, type, data from v2.scan_events where run_id = $1::uuid order by seq asc limit ${MAX_REPLAY_EVENTS}`, [runId]),
    );
    const out: ScanEvent[] = [];
    for (const row of rows) {
      const e = eventFromRow(row);
      if (e) out.push(e);
    }
    return out;
  }

  /** The run row for replay by id. */
  async loadRun(runId: string): Promise<RunRow | null> {
    const rows = await run("scan_runs read", () =>
      this.db.query<RunRow>("select id::text as id, subject, commit_sha, status, error_code from v2.scan_runs where id = $1::uuid", [runId]),
    );
    return rows[0] ?? null;
  }

  async markCurrent(ownerLogin: string, repoName: string, commitSha: string): Promise<void> {
    await run("reports mark current", () =>
      this.db.query("update v2.reports set ref = 'latest', updated_at = now() where owner_login = $1 and repo_name = $2 and commit_sha = $3", [ownerLogin, repoName, commitSha]),
    );
  }

  async findCached(subject: string, commitSha: string): Promise<CachedRun | null> {
    // Runs finished before CR_FRESH_SINCE (the production launch of 2.0) are never served as a cache hit.
    const runRow = await this.findLatestDoneRun(subject, commitSha, freshSince());
    if (!runRow) return null;
    const rows = await run("reports read", () =>
      this.db.query<StoredReportRow>(
        `select id::text as id, commit_sha, score, verdict, summary, stats_json, packages_json, forensics_json,
                run_id::text as run_id, score_breakdown, not_verified
           from v2.reports where id = $1::bigint`,
        [runRow.report_id],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    // A regenerate can overwrite the shared reports row; serve only the row this run wrote.
    if (row.run_id !== runRow.id) return null;
    return { runId: runRow.id, report: payloadFromRows(row, runRow), events: await this.loadEvents(runRow.id) };
  }

  async claimRun(req: ClaimRequest): Promise<ClaimResult> {
    await run("expire_stale_runs", () => expireStaleRuns(this.db));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.db.query(
          `insert into v2.scan_runs (id, target_kind, subject, commit_sha, status, model_id, template, user_id)
           values ($1::uuid, $2, $3, $4, 'running', $5, $6, $7::uuid)`,
          [req.runId, req.targetKind, req.subject, req.commitSha, req.modelId, req.template, req.userId && UUID_RE.test(req.userId) ? req.userId : null],
        );
        return { status: "claimed", runId: req.runId };
      } catch (err) {
        if (sqlState(err) !== "23505") fail("scan_runs insert", err);
      }
      const rows = await run("scan_runs read", () =>
        this.db.query<{ id: string }>("select id::text as id from v2.scan_runs where subject = $1 and commit_sha = $2 and status = 'running' limit 1", [req.subject, req.commitSha]),
      );
      if (rows[0]) return { status: "running", runId: rows[0].id };
      // The other run finished between the insert and the read; claim again.
    }
    throw new EngineError("internal", "scan_runs claim did not settle after a retry");
  }

  async appendEvents(events: ScanEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += EVENT_INSERT_CHUNK) {
      const chunk = JSON.stringify(events.slice(i, i + EVENT_INSERT_CHUNK).map(eventToRow));
      await run("scan_events insert", () =>
        this.db.query(
          `insert into v2.scan_events (run_id, seq, t_ms, type, data)
           select x.run_id, x.seq, x.t_ms, x.type, x.data
             from jsonb_to_recordset($1::text::jsonb) as x(run_id uuid, seq integer, t_ms integer, type text, data jsonb)
            order by x.seq`,
          [chunk],
        ),
      );
    }
  }

  async saveReport(record: ReportRecord): Promise<void> {
    const r = reportsRowFor(record);
    const rows = await run("reports upsert", () =>
      this.db.query<{ id: string }>(
        `with saved as (
           insert into v2.reports (owner_login, repo_name, commit_sha, score, verdict, summary, scan_path, deep, cached,
                                   stats_json, packages_json, risky_json, logs_json, forensics_json, run_id, score_breakdown, not_verified, ref)
           values ($1, $2, $3, $4::int, $5, $6, 'run', true, false,
                   $7::text::jsonb, $8::text::jsonb, $9::text::jsonb, $10::text::jsonb, $11::text::jsonb, $12::uuid, $13::text::jsonb, $14::text::jsonb,
                   case when $15::boolean then 'latest' end)
           on conflict (owner_login, repo_name, commit_sha) do update
              set score = excluded.score, verdict = excluded.verdict, summary = excluded.summary, ref = coalesce(excluded.ref, v2.reports.ref),
                  stats_json = excluded.stats_json, packages_json = excluded.packages_json, risky_json = excluded.risky_json,
                  logs_json = excluded.logs_json, forensics_json = excluded.forensics_json, run_id = excluded.run_id,
                  score_breakdown = excluded.score_breakdown, not_verified = excluded.not_verified, cached = false
           returning id
         )
         update v2.scan_runs set report_id = (select id from saved) where id = $12::uuid
         returning report_id::text as id`,
        [
          r.owner_login,
          r.repo_name,
          r.commit_sha,
          r.score,
          r.verdict,
          r.summary,
          JSON.stringify(r.stats_json),
          JSON.stringify(r.packages_json),
          JSON.stringify(r.risky_json),
          JSON.stringify(r.logs_json),
          JSON.stringify(r.forensics_json),
          r.run_id,
          JSON.stringify(r.score_breakdown),
          JSON.stringify(r.not_verified),
          record.current === true,
        ],
      ),
    );
    if (!rows[0]?.id) throw new EngineError("internal", `scan_runs link: run ${record.runId} not found`);
  }

  async finishRun(runId: string, result: { status: "done" | "error"; errorCode?: ErrorCode; timings: Record<string, number>; cost?: CostLedger }): Promise<void> {
    await run("scan_runs finish", () =>
      this.db.query("update v2.scan_runs set status = $2, error_code = $3, finished_at = $4::timestamptz, timings = $5::text::jsonb, cost = $6::text::jsonb where id = $1::uuid", [
        runId,
        result.status,
        result.errorCode ?? null,
        new Date(this.now()).toISOString(),
        JSON.stringify(result.timings),
        result.cost ? JSON.stringify(result.cost) : null,
      ]),
    );
  }

  /**
   * Record that a signed-in user received this run's result (fresh, cached or
   * attached). Guests are never recorded: callers pass only a verified user id.
   */
  async recordUserScan(userId: string, runId: string): Promise<void> {
    if (!UUID_RE.test(userId) || !UUID_RE.test(runId)) throw new EngineError("internal", "user_scans insert: user id and run id must be uuids");
    await run("user_scans insert", () =>
      this.db.query("insert into v2.user_scans (user_id, run_id, scanned_at) values ($1::uuid, $2::uuid, $3::timestamptz)", [userId, runId, new Date(this.now()).toISOString()]),
    );
  }

  /**
   * One ad impression in one slot of this run's scan page (v2.scan_ad_impressions):
   * 'video', 'banner_1' to 'banner_3' or 'interstitial'. At most one per run and slot
   * every 25 s is counted, so no slot's count can outpace its 30 s refresh. Returns
   * whether it was counted.
   */
  async recordAdImpression(runId: string, slot: AdSlotName): Promise<boolean> {
    if (!UUID_RE.test(runId) || !AD_SLOTS.includes(slot)) return false;
    const rows = await run("ad impression", () =>
      this.db.query<{ id: string }>(
        `insert into v2.scan_ad_impressions (run_id, slot)
         select $1::uuid, $2
          where exists (select 1 from v2.scan_runs where id = $1::uuid)
            and not exists (select 1 from v2.scan_ad_impressions where run_id = $1::uuid and slot = $2 and at > now() - interval '25 seconds')
         returning id::text as id`,
        [runId, slot],
      ),
    );
    return rows.length > 0;
  }

  /**
   * A signed-in user's scans, newest first, one entry per run (its latest
   * scanned_at), joined to the run and to the report row that run wrote.
   */
  async listUserScans(userId: string, limit = 50): Promise<UserScanRow[]> {
    if (!UUID_RE.test(userId)) return [];
    const n = Math.max(1, Math.min(Math.floor(limit) || 1, MAX_USER_SCANS));
    const rows = await run("user_scans read", () =>
      this.db.query<{ run_id: string; subject: string; commit_sha: string; score: number | null; verdict: string | null; scanned_at: string }>(
        `select u.run_id::text as run_id, sr.subject, sr.commit_sha, r.score, r.verdict, ${iso("u.scanned_at")} as scanned_at
           from (select run_id, max(scanned_at) as scanned_at from v2.user_scans where user_id = $1::uuid group by run_id) u
           join v2.scan_runs sr on sr.id = u.run_id
           left join v2.reports r on r.id = sr.report_id
          order by u.scanned_at desc
          limit $2::int`,
        [userId, n],
      ),
    );
    return rows.map((r) => ({
      run_id: r.run_id,
      subject: r.subject,
      commit_sha: r.commit_sha,
      score: typeof r.score === "number" ? r.score : null,
      verdict: VERDICTS.includes(r.verdict as Verdict) ? (r.verdict as Verdict) : null,
      scanned_at: r.scanned_at,
    }));
  }

  async chargeBudget(charge: BudgetCharge): Promise<boolean> {
    const rows = await run("scan_budget_charge", () =>
      this.db.query<{ ok: boolean }>("select v2.scan_budget_charge($1::int, $2::int, $3::int, $4::int) as ok", [
        Math.max(0, Math.round(charge.sandboxSeconds)),
        Math.max(0, Math.round(charge.tokens)),
        charge.capSeconds,
        charge.capTokens,
      ]),
    );
    return rows[0]?.ok === true;
  }
}

/** The cr_v2_server connection from server config. Throws with env var NAMES only. */
export function v2Executor(config: EngineConfig): SqlExecutor {
  if (!config.databaseUrl) throw new EngineError("internal", "server is missing required configuration: CR_V2_DATABASE_URL");
  const bad = validateDatabaseUrl(config.databaseUrl);
  if (bad) throw new EngineError("internal", bad);
  return postgresExecutor(config.databaseUrl);
}

/** The scan page's ad slots, counted separately (v2.scan_ad_impressions.slot). */
export const AD_SLOTS = ["video", "banner_1", "banner_2", "banner_3", "interstitial"] as const;
export type AdSlotName = (typeof AD_SLOTS)[number];

export function createV2Store(config: EngineConfig): V2Store {
  return new V2Store(v2Executor(config));
}
