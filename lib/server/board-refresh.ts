/**
 * Keeps the danger board on the current scoring rules. A board row whose shown
 * scan was scored under an older SCORE_RULES, or finished before CR_FRESH_SINCE, is stale; on a board read the server
 * rescans stale targets in the background (after the response), at their current
 * version, at most BOARD_REFRESH_CONCURRENCY scans running at once across the
 * whole service. Until a target's new scan lands the board shows its last result.
 * A rescan is an ordinary scan: the forge, the per-scan reset and every rail apply.
 */

import type { SqlExecutor } from "@/lib/engine/db";
import { SCORE_RULES } from "@/lib/engine/score";
import { freshSince } from "@/lib/engine/store";
import type { ScanTarget } from "@/lib/engine/types";
import { TEST_FIXTURE_REPO_RE } from "./public-lists";

export const BOARD_REFRESH_CONCURRENCY = 5;

/** The board's targets whose shown scan is under older rules and not being scanned now, oldest rules first. */
export async function staleBoardSubjects(db: SqlExecutor, rules = SCORE_RULES, limit = BOARD_REFRESH_CONCURRENCY, since: string | null = freshSince()): Promise<string[]> {
  const rows = await db.query<{ subject: string }>(
    `with latest as (
       select distinct on (owner_login, repo_name) run_id, stats_json->>'score_rules' as rules
         from v2.reports
        where owner_login <> 'tarball' and run_id is not null and repo_name !~* $3
        order by owner_login, repo_name, (ref is not distinct from 'latest') desc,
                 case when ref is not distinct from 'latest' then updated_at else created_at end desc)
     select sr.subject
       from latest l join v2.scan_runs sr on sr.id = l.run_id
      where (coalesce(l.rules, '') <> $1::text or ($4::timestamptz is not null and coalesce(sr.finished_at, sr.started_at) < $4::timestamptz))
        and not exists (select 1 from v2.scan_runs x where x.subject = sr.subject and x.status = 'running')
      order by coalesce(nullif(l.rules, '')::int, 0) asc, sr.subject
      limit $2`,
    [String(rules), limit, TEST_FIXTURE_REPO_RE, since],
  );
  return rows.map((r) => r.subject);
}

/** Scans running now, service-wide (the concurrency floor for background rescans). */
export async function runningScans(db: SqlExecutor): Promise<number> {
  const rows = await db.query<{ n: number }>("select count(*)::int as n from v2.scan_runs where status = 'running' and started_at > now() - interval '10 minutes'");
  return rows[0]?.n ?? 0;
}

/** A board subject ("owner/repo" or "npm:name") as a scan target at its current version. */
export function targetForSubject(subject: string): ScanTarget | null {
  if (subject.startsWith("npm:")) {
    const name = subject.slice(4);
    return /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name) ? { kind: "npm", name } : null;
  }
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(subject);
  return m ? { kind: "github", owner: m[1]!, repo: m[2]! } : null;
}

/** How many stale targets this read may start: up to the concurrency limit, minus what is already running. */
export function refreshSlots(running: number): number {
  return Math.max(0, BOARD_REFRESH_CONCURRENCY - running);
}
