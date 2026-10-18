/**
 * Where a public report page reads its report from (server-only).
 *
 * 2.0 writes reports to `v2.reports`, which only the server role
 * cr_v2_server can read. A page asks for the latest report of owner/repo:
 * the v2 report when one exists, otherwise the 1.0 report from
 * `public.reports` through the existing anonymous read (read-only; 2.0 never
 * writes a 1.0 table). Both go through `reportRowToReport`, so the page
 * renders either one the same way. Never throws.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SqlExecutor } from "@/lib/engine/db";
import { v2Executor } from "@/lib/engine/store";
import { fetchLatestReport } from "@/lib/report-fetch";
import { fetchV2Report, fetchV2Score } from "@/lib/server/report-v2";
import { serverConfig } from "@/lib/server/scan-service";
import { createClient } from "@/lib/supabase/server";
import type { Report } from "@/lib/types";

/** The v2 connection when the server is configured for it, else null. */
export function v2DbOrNull(): SqlExecutor | null {
  try {
    return v2Executor(serverConfig());
  } catch {
    return null;
  }
}

async function anonClient(): Promise<SupabaseClient | null> {
  try {
    return (await createClient()) as unknown as SupabaseClient;
  } catch {
    return null;
  }
}

/** Latest report: v2 first, then the 1.0 public report. Null on miss or error. */
export async function latestReport(owner: string, repo: string): Promise<Report | null> {
  const db = v2DbOrNull();
  if (db) {
    try {
      const v2 = await fetchV2Report(db, owner, repo);
      if (v2) return v2;
    } catch (err) {
      console.error("v2 report read failed:", err instanceof Error ? err.message.slice(0, 200) : String(err));
    }
  }
  const anon = await anonClient();
  return anon ? fetchLatestReport(anon, owner, repo) : null;
}

/** Latest score for the badge: v2 first, then the 1.0 public report. */
export async function latestScore(owner: string, repo: string): Promise<number | null> {
  const db = v2DbOrNull();
  if (db) {
    try {
      const v2 = await fetchV2Score(db, owner, repo);
      if (v2 !== null) return v2;
    } catch (err) {
      console.error("v2 score read failed:", err instanceof Error ? err.message.slice(0, 200) : String(err));
    }
  }
  const anon = await anonClient();
  if (!anon) return null;
  try {
    const { data } = await anon.from("reports").select("score").eq("owner_login", owner).eq("repo_name", repo).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const score = (data as { score?: unknown } | null)?.score;
    return typeof score === "number" ? score : null;
  } catch {
    return null;
  }
}
