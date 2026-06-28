/**
 * Shared "latest report for owner/repo" data access — used by BOTH the public
 * SSR report page (`app/[owner]/[repo]/page.tsx`, server client) and the SPA
 * (`components/spa/state.tsx`, browser client). Sharing one fetch + reshape path
 * means the two surfaces never drift: the SSR render and the in-app render of
 * the same commit are byte-identical (deterministic first == cached).
 *
 * Pure data access — it takes the Supabase client so either runtime can call it,
 * and never throws (returns null on any miss/error) so callers can render a
 * graceful state instead of crashing to a blank screen.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { reportRowToReport, type ReportRow } from "./report-row";
import type { Report } from "./types";

/** The exact column set the report view needs, with the owner row joined. */
export const REPORT_SELECT =
  "owner_login,repo_name,commit_sha,score,verdict,cached,deep,summary,confidence,scan_path,stats_json,packages_json,risky_json,logs_json,forensics_json,owners(github_login,display_name,account_age_label,established,public_repos,stars_total,sentiment,sentiment_score,reputation_json)";

/**
 * Latest report for (owner, repo) — newest by created_at, owner joined, fully
 * normalized via `reportRowToReport`. Returns null when none exists or the read
 * errors. Never throws.
 */
export async function fetchLatestReport(
  supabase: SupabaseClient,
  owner: string,
  repo: string,
): Promise<Report | null> {
  try {
    const { data, error } = await supabase
      .from("reports")
      .select(REPORT_SELECT)
      .eq("owner_login", owner)
      .eq("repo_name", repo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    // The joined `owners` arrives as an array or object depending on the client;
    // normalize to a single owner row (or null) for the reshape.
    const row = data as unknown as ReportRow & { owners?: unknown };
    const owners = Array.isArray(row.owners)
      ? (row.owners[0] ?? null)
      : (row.owners ?? null);
    return reportRowToReport({ ...row, owners } as ReportRow);
  } catch {
    return null;
  }
}

/**
 * Latest report for (owner, repo) via a direct anonymous PostgREST read — the
 * SPA path. Reports are PUBLIC (the SSR page reads them anonymously too), so the
 * in-app report view does NOT need the user's session; reading with the
 * publishable key keeps it identical to the SSR render and avoids the
 * authenticated-role read of the `reports` table hanging (observed: the OAuth
 * session token stalls this specific query). Hard timeout via AbortController so
 * a slow/stuck network can never leave the report screen spinning forever —
 * a timeout resolves to null and the caller shows a graceful error. Never throws.
 */
export async function fetchLatestReportRest(
  supabaseUrl: string,
  anonKey: string,
  owner: string,
  repo: string,
  timeoutMs = 10_000,
): Promise<Report | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const base = supabaseUrl.replace(/\/$/, "");
    const url =
      `${base}/rest/v1/reports?owner_login=eq.${encodeURIComponent(owner)}` +
      `&repo_name=eq.${encodeURIComponent(repo)}` +
      `&select=${encodeURIComponent(REPORT_SELECT)}` +
      `&order=created_at.desc&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0] as ReportRow & { owners?: unknown };
    const owners = Array.isArray(row.owners)
      ? (row.owners[0] ?? null)
      : (row.owners ?? null);
    return reportRowToReport({ ...row, owners } as ReportRow);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when `id` is a clean two-segment "owner/repo" slug (both parts non-empty,
 * exactly one "/"). The single source of truth for "is this a safe report id" —
 * used to gate both the on-demand fetch and any place the id is interpolated
 * into a URL (so a malformed id like "//evil.com/x" can never become a
 * protocol-relative link).
 */
export function isValidSlug(id: string | null): id is string {
  if (!id) return false;
  const parts = id.split("/");
  return parts.length === 2 && !!parts[0] && !!parts[1];
}

/** What `ensureActiveReport` should do for a given report id (pure decision). */
export type ReportFetchDecision =
  | { kind: "loaded" } // already in the store — render it
  | { kind: "in-flight" } // a fetch for this exact id is already running
  | { kind: "cached-error" } // this id already failed — do not auto-retry
  | { kind: "bad-id" } // not a fetchable "owner/repo" slug
  | { kind: "fetch"; owner: string; repo: string };

/**
 * Decide whether a report screen needs to fetch its report, purely from the
 * current state. Kept pure (no I/O) so the fetch-or-not logic is unit-testable:
 * it must never decide "fetch" for an already-loaded id, an in-flight id, or a
 * known-failed id (a negative cache that stops the error -> refetch loop), and
 * it must reject ids that are not a clean two-segment "owner/repo" slug.
 */
export function decideReportFetch(
  id: string | null,
  isLoaded: boolean,
  inFlightId: string | null,
  erroredId: string | null,
): ReportFetchDecision {
  if (!id) return { kind: "bad-id" };
  if (isLoaded) return { kind: "loaded" };
  if (inFlightId === id) return { kind: "in-flight" };
  if (erroredId === id) return { kind: "cached-error" };
  const parts = id.split("/");
  // Same rule as isValidSlug; inline so TypeScript narrows owner/repo to string.
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { kind: "bad-id" };
  return { kind: "fetch", owner: parts[0], repo: parts[1] };
}
