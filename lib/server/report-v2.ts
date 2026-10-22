/**
 * Reads of 2.0 reports from schema v2 as cr_v2_server (server-only, no
 * framework imports so tests run them on PGlite). The page-facing fallback
 * to the 1.0 public report lives in `report-source.ts`.
 */

import type { SqlExecutor } from "../engine/db";
import { type ReportSlug } from "../report-fetch";
import { reportRowToReport, type ReportRow } from "../report-row";
import type { Report } from "../types";
import { TEST_FIXTURE_REPO_RE } from "./public-lists";

const V2_REPORT_SQL = `
select r.owner_login, r.repo_name, r.commit_sha, r.score, r.verdict, r.cached, r.deep, r.summary,
       r.confidence::float8 as confidence, r.scan_path, r.stats_json, r.packages_json, r.risky_json,
       r.logs_json, r.forensics_json, r.not_verified,
       case when o.id is null then null else jsonb_build_object(
         'github_login', o.github_login, 'display_name', o.display_name, 'account_age_label', o.account_age_label,
         'established', o.established, 'public_repos', o.public_repos, 'stars_total', o.stars_total,
         'sentiment', o.sentiment, 'sentiment_score', o.sentiment_score, 'reputation_json', o.reputation_json) end as owners
  from v2.reports r
  left join v2.owners o on o.github_login = r.owner_login
 where r.owner_login = $1 and r.repo_name = $2
 order by r.created_at desc
 limit 1`;

/** Latest v2 report for owner/repo, or null. Throws on a database error. */
export async function fetchV2Report(db: SqlExecutor, owner: string, repo: string): Promise<Report | null> {
  const rows = await db.query<ReportRow>(V2_REPORT_SQL, [owner, repo]);
  return rows[0] ? reportRowToReport(rows[0]) : null;
}

/** Latest v2 score for owner/repo, or null. Throws on a database error. */
export async function fetchV2Score(db: SqlExecutor, owner: string, repo: string): Promise<number | null> {
  const rows = await db.query<{ score: number }>("select score from v2.reports where owner_login = $1 and repo_name = $2 order by created_at desc limit 1", [owner, repo]);
  return typeof rows[0]?.score === "number" ? rows[0].score : null;
}

/** Most recently updated v2 report slugs, one per owner/repo, without test fixtures (public-lists.ts). Throws on a database error. */
export async function fetchV2Slugs(db: SqlExecutor, limit = 2000): Promise<ReportSlug[]> {
  const rows = await db.query<{ owner_login: string; repo_name: string; lastmod: string }>(
    `select owner_login, repo_name, to_char(max(updated_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as lastmod
       from v2.reports where repo_name !~* $2 group by owner_login, repo_name order by max(updated_at) desc limit $1::int`,
    [Math.max(1, Math.min(limit, 50_000)), TEST_FIXTURE_REPO_RE],
  );
  return rows.map((r) => ({ owner: r.owner_login, repo: r.repo_name, lastmod: r.lastmod }));
}
