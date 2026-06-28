/**
 * DB `reports` row → `Report` mapping for the server-rendered public page.
 *
 * The `reports` table stores the structured findings as `*_json` columns and
 * references an `owners` row for the reputation signal. This module reshapes a
 * row (optionally joined with its owner) into the same `Report` shape the SPA
 * uses, so `lib/report-view.buildReportView` derives an identical `RepoView`.
 *
 * Mirrors the edge function's `reshapeCached` (it builds the same object from
 * the same columns), then runs it through `normalizeReport` for a single
 * coercion path shared with live scan responses.
 */

import { normalizeReport } from "./scan";
import type { Report } from "./types";

/** A `reports` row, optionally with its joined `owners` record. */
export interface ReportRow {
  owner_login: string;
  repo_name: string;
  commit_sha: string;
  score: number;
  verdict: string;
  cached: boolean;
  deep: boolean;
  summary: string | null;
  confidence: number | null;
  scan_path: string;
  stats_json: unknown;
  packages_json: unknown;
  risky_json: unknown;
  logs_json: unknown;
  /** The dynamic sandbox forensic record (`forensic-record@1`), or null. */
  forensics_json?: unknown;
  owners?: OwnerRow | null;
}

/** An `owners` row (the reputation cache). */
export interface OwnerRow {
  github_login: string;
  display_name: string | null;
  account_age_label: string | null;
  established: boolean;
  public_repos: number | null;
  stars_total: number | null;
  sentiment: string | null;
  sentiment_score: number | null;
  reputation_json?: unknown;
}

/** Format an integer with k/M suffixes, matching the edge function's helper. */
function formatNumber(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Reputation for a row: the persisted DETERMINISTIC view (`reputation_json`) when
 * present, so the SSR/cached render matches the fresh scan exactly — including
 * `forks`, which the legacy stats/columns path could not recover. Mirrors the
 * edge function's `reputationFromOwner` (BUG-17). Falls back to columns for
 * rows persisted before this view existed.
 */
function reputationFromOwner(
  owner: OwnerRow | null,
  starsFallback: string,
): { stars: string; forks: string; sentiment: string; sentScore: number } {
  const rj = owner?.reputation_json;
  if (rj && typeof rj === "object") {
    const r = rj as Record<string, unknown>;
    if (typeof r.stars === "string") {
      return {
        stars: r.stars,
        forks: typeof r.forks === "string" ? r.forks : "—",
        sentiment: typeof r.sentiment === "string" ? r.sentiment : (owner?.sentiment ?? ""),
        sentScore: typeof r.sentScore === "number" ? r.sentScore : (owner?.sentiment_score ?? 0),
      };
    }
  }
  return {
    stars: starsFallback,
    forks: "—",
    sentiment: owner?.sentiment ?? "",
    sentScore: owner?.sentiment_score ?? 0,
  };
}

/** Reshape a `reports` row (and optional joined owner) into a `Report`. */
export function reportRowToReport(row: ReportRow): Report {
  const owner = row.owners ?? null;
  const statsJson = (row.stats_json ?? {}) as Record<string, unknown>;

  // Prefer the stats blob's stars; fall back to the owner cache's total.
  const stars =
    typeof statsJson.stars === "string"
      ? statsJson.stars
      : formatNumber(owner?.stars_total ?? null);

  return normalizeReport({
    id: `${row.owner_login}/${row.repo_name}`,
    owner: row.owner_login,
    name: row.repo_name,
    score: row.score,
    verdict: row.verdict,
    cached: row.cached,
    deep: row.deep,
    summary: row.summary ?? "",
    ownerHistory: {
      handle: owner?.github_login ?? row.owner_login,
      name: owner?.display_name ?? row.owner_login,
      age: owner?.account_age_label ?? "unknown",
      established: owner?.established ?? false,
      repos: owner?.public_repos ?? 0,
      note: "",
    },
    reputation: reputationFromOwner(owner, stars),
    stats: {
      loc: typeof statsJson.loc === "string" ? statsJson.loc : "—",
      packages:
        typeof statsJson.packages === "number" ? statsJson.packages : 0,
      stars,
      created:
        typeof statsJson.created === "string" ? statsJson.created : "unknown",
    },
    packages: row.packages_json,
    risky: row.risky_json,
    logs: row.logs_json,
    // `normalizeReport` accepts `forensics` or `forensics_json` and coerces it
    // to the strict `Forensics` shape; a null/absent column omits the section.
    forensics_json: row.forensics_json,
  });
}
