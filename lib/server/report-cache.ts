/**
 * Cached report reads for the public report pages (server-only).
 *
 * Every page renders per request now (the CSP nonce in proxy.ts needs it), so
 * the report DATA is what gets cached: `unstable_cache` keeps the latest report
 * per owner/repo in Next's data cache for REPORT_CACHE_SECONDS, tagged
 * `report:<owner>/<repo>`. A fresh 2.0 scan expires the tag the moment its
 * report row is saved (`invalidateReport`, called from the scan routes), so a
 * page never shows an older verdict than the one just persisted. A read error
 * is never cached: the strict reader throws, and the page falls back to an
 * uncached read.
 */

import { revalidateTag, unstable_cache } from "next/cache";
import type { Report } from "@/lib/types";
import { latestReport, latestReportStrict } from "./report-source";

export const REPORT_CACHE_SECONDS = 600;

export function reportTag(owner: string, repo: string): string {
  return `report:${owner}/${repo}`.slice(0, 256);
}

export async function cachedLatestReport(owner: string, repo: string): Promise<Report | null> {
  try {
    return await unstable_cache(() => latestReportStrict(owner, repo), ["latest-report-v1", owner, repo], {
      revalidate: REPORT_CACHE_SECONDS,
      tags: [reportTag(owner, repo)],
    })();
  } catch (err) {
    console.error("cached report read failed:", err instanceof Error ? err.message.slice(0, 200) : String(err));
    return latestReport(owner, repo);
  }
}

/** Expire the cached report of owner/repo now (the next page view reads the database). */
export function invalidateReport(owner: string, repo: string): void {
  try {
    revalidateTag(reportTag(owner, repo), { expire: 0 });
  } catch (err) {
    // Outside a Next request scope (tests, scripts) there is no data cache to expire.
    console.error("report cache invalidation skipped:", err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
}
