/**
 * Server-only read of the latest 2.0 report for the public report pages: the stored v2.reports row, its run row
 * (rebuilt into the engine's ReportPayload by payloadFromRows) and the run's observed events (stages, forged calls,
 * file and process events, model transcripts). Cached in Next's data cache under the same tag a fresh scan expires
 * (lib/server/report-cache.ts reportTag), so a page never shows an older verdict than the one just saved.
 * Returns null when there is no 2.0 report; a read error is logged and also returns null (never cached).
 */

import { unstable_cache } from "next/cache";
import { eventFromRow, payloadFromRows, type StoredReportRow } from "@/lib/engine/store";
import type { ReportPayload, ScanEvent } from "@/lib/engine/types";
import { v2DbOrNull } from "@/lib/server/report-source";
import { REPORT_CACHE_SECONDS, reportTag } from "@/lib/server/report-cache";

export interface V2Report {
  owner: string;
  repo: string;
  createdAt: string | null;
  payload: ReportPayload;
  events: ScanEvent[];
}

const REPORT_SQL = `
select r.id::text as id, r.commit_sha, r.score, r.verdict, r.summary, r.stats_json, r.packages_json, r.forensics_json,
       r.run_id::text as run_id, r.score_breakdown, r.not_verified,
       to_char(r.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
       s.subject, s.model_id, s.template, s.timings, s.cost
  from v2.reports r
  left join v2.scan_runs s on s.id = r.run_id
 where r.owner_login = $1 and r.repo_name = $2
 -- The same pick as the danger board (lib/server/board-v2.ts): the current version first, by its latest scan.
 order by (r.ref is not distinct from 'latest') desc,
          case when r.ref is not distinct from 'latest' then r.updated_at else r.created_at end desc
 limit 1`;

/** Only the event kinds the report shows; the raw stdout of a build can be large and is not rendered. */
const EVENTS_SQL = `
select run_id::text as run_id, seq, t_ms, type, data
  from v2.scan_events
 where run_id = $1::uuid and type in ('stage', 'forged_call', 'file', 'process', 'transcript')
   and (type <> 'transcript' or data->>'source' like 'jev.%')
 order by seq asc
 limit 4000`;

type Row = StoredReportRow & {
  updated_at: string | null;
  subject: string | null;
  model_id: string | null;
  template: string | null;
  timings: unknown;
  cost: unknown;
};

async function readStrict(owner: string, repo: string): Promise<V2Report | null> {
  const db = v2DbOrNull();
  if (!db) return null;
  const rows = await db.query<Row>(REPORT_SQL, [owner, repo]);
  const row = rows[0];
  if (!row) return null;
  const runId = row.run_id ?? "";
  const payload = payloadFromRows(row, {
    id: runId,
    subject: row.subject ?? `${owner}/${repo}`,
    model_id: row.model_id,
    template: row.template,
    timings: row.timings,
    cost: row.cost,
  });
  const events: ScanEvent[] = [];
  if (runId) {
    const evRows = await db.query<{ run_id: string; seq: number; t_ms: number; type: string; data: unknown }>(EVENTS_SQL, [runId]);
    for (const r of evRows) {
      const e = eventFromRow(r);
      if (e) events.push(e);
    }
  }
  return { owner, repo, createdAt: row.updated_at, payload, events };
}

/**
 * The shown report's identity (its run and save time), read uncached on every request. A scan that runs on the
 * runner sandbox cannot expire this server's data cache, so the cached read below is keyed on it: a newer saved
 * report is a new cache entry and shows at once.
 */
async function latestKey(owner: string, repo: string): Promise<string> {
  const db = v2DbOrNull();
  if (!db) return "none";
  const rows = await db.query<{ k: string }>(
    `select coalesce(r.run_id::text, '') || '@' || r.updated_at::text as k from v2.reports r
      where r.owner_login = $1 and r.repo_name = $2
      order by (r.ref is not distinct from 'latest') desc,
               case when r.ref is not distinct from 'latest' then r.updated_at else r.created_at end desc
      limit 1`,
    [owner, repo],
  );
  return rows[0]?.k ?? "none";
}

export async function latestV2Report(owner: string, repo: string): Promise<V2Report | null> {
  try {
    const key = await latestKey(owner, repo);
    return await unstable_cache(() => readStrict(owner, repo), ["latest-v2-report-v4", owner, repo, key], {
      revalidate: REPORT_CACHE_SECONDS,
      tags: [reportTag(owner, repo)],
    })();
  } catch (err) {
    console.error("v2 report read failed:", err instanceof Error ? err.message.slice(0, 200) : String(err));
    return null;
  }
}
