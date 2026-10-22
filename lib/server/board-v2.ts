/**
 * Reads behind the 2.0 app screen: the danger board (every scan, most dangerous
 * first) and one run's report by run id. Server only; the store's connection is
 * the cr_v2_server role, which the publishable key never reaches.
 */

import type { SqlExecutor } from "@/lib/engine/db";
import { payloadFromRows, type StoredReportRow } from "@/lib/engine/store";
import type { ReportPayload, ScoreDelta } from "@/lib/engine/types";
import { FILTER_VERDICTS, topFinding, type BoardFilter } from "@/lib/cr/verdict";
import { TEST_FIXTURE_REPO_RE } from "./public-lists";

export const BOARD_PAGE = 30;

export interface BoardRow {
  run_id: string | null;
  owner_login: string;
  repo_name: string;
  commit_sha: string;
  score: number;
  verdict: string;
  finding: string;
  created_at: string;
}

interface RawBoardRow {
  run_id: string | null;
  owner_login: string;
  repo_name: string;
  commit_sha: string;
  score: number;
  verdict: string;
  score_breakdown: ScoreDelta[] | null;
  created_at: string;
}

/**
 * One row per scanned target, most dangerous first: the target's current version
 * (the last scan that asked for it without pinning a commit or version, ref
 * 'latest'), else its newest scan; then by score
 * ascending, then newest). Only real scans written by a run: tarball (operator)
 * runs and our own test fixture repos (lib/server/public-lists.ts) stay off the
 * board. `offset` paginates; `filter` narrows by the latest scan's verdict.
 */
export async function listBoard(db: SqlExecutor, filter: BoardFilter, offset: number, limit = BOARD_PAGE): Promise<{ rows: BoardRow[]; next: number | null }> {
  const verdicts = filter === "all" ? null : FILTER_VERDICTS[filter];
  const rows = await db.query<RawBoardRow>(
    `select run_id, owner_login, repo_name, commit_sha, score, verdict, score_breakdown, created_at
       from (select distinct on (owner_login, repo_name)
                    run_id::text as run_id, owner_login, repo_name, commit_sha, score, verdict, score_breakdown,
                    created_at as created_at_ts,
                    to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
               from v2.reports
              where owner_login <> 'tarball' and run_id is not null and repo_name !~* $4
              order by owner_login, repo_name, (ref is not distinct from 'latest') desc,
                       case when ref is not distinct from 'latest' then updated_at else created_at end desc) latest
      where ($1::text[] is null or verdict = any($1::text[]))
      order by score asc, created_at_ts desc
      limit $2 offset $3`,
    [verdicts, limit + 1, offset, TEST_FIXTURE_REPO_RE],
  );
  const page = rows.slice(0, limit).map((r) => ({
    run_id: r.run_id,
    owner_login: r.owner_login,
    repo_name: r.repo_name,
    commit_sha: r.commit_sha,
    score: r.score,
    verdict: r.verdict,
    finding: topFinding(Array.isArray(r.score_breakdown) ? r.score_breakdown : []),
    created_at: r.created_at,
  }));
  return { rows: page, next: rows.length > limit ? offset + limit : null };
}

export interface RunReport {
  run_id: string;
  subject: string;
  commit_sha: string;
  status: "running" | "done" | "error";
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
  report: ReportPayload | null;
  report_created_at: string | null;
}

/** The run and, when it finished, the report this run wrote (never a later run's row). */
export async function loadRunReport(db: SqlExecutor, runId: string): Promise<RunReport | null> {
  const runs = await db.query<{
    id: string; subject: string; commit_sha: string; status: "running" | "done" | "error"; error_code: string | null;
    started_at: string; finished_at: string | null; model_id: string | null; template: string | null; timings: unknown; cost: unknown;
  }>(
    `select id::text as id, subject, commit_sha, status, error_code, model_id, template, timings, cost,
            to_char(started_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
            to_char(finished_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished_at
       from v2.scan_runs where id = $1::uuid`,
    [runId],
  );
  const run = runs[0];
  if (!run) return null;
  let report: ReportPayload | null = null;
  let reportCreated: string | null = null;
  if (run.status === "done") {
    const rows = await db.query<StoredReportRow & { created_at: string }>(
      `select id::text as id, commit_sha, score, verdict, summary, stats_json, packages_json, forensics_json,
              run_id::text as run_id, score_breakdown, not_verified,
              to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
         from v2.reports where run_id = $1::uuid limit 1`,
      [runId],
    );
    if (rows[0]) {
      report = payloadFromRows(rows[0], run);
      reportCreated = rows[0].created_at;
    }
  }
  return {
    run_id: run.id,
    subject: run.subject,
    commit_sha: run.commit_sha,
    status: run.status,
    error_code: run.error_code,
    started_at: run.started_at,
    finished_at: run.finished_at,
    report,
    report_created_at: reportCreated,
  };
}
