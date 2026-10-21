/**
 * GET /api/me/scans: the signed-in user's scans, newest first, for the account
 * card. Guests get 401; nothing is stored about guests.
 */

import { createClient } from "@/lib/supabase/server";
import { createV2Store } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const store = createV2Store(serverConfig());
    const rows = await store.db.query<{ run_id: string; subject: string; commit_sha: string; score: number | null; verdict: string | null; scanned_at: string }>(
      `select distinct on (u.run_id) u.run_id::text as run_id, r.subject, r.commit_sha, rep.score, rep.verdict,
              to_char(u.scanned_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as scanned_at
         from v2.user_scans u
         join v2.scan_runs r on r.id = u.run_id
         left join v2.reports rep on rep.run_id = u.run_id
        where u.user_id = $1::uuid
        order by u.run_id, u.scanned_at desc`,
      [userId],
    );
    rows.sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
    return Response.json({ count: rows.length, scans: rows.slice(0, 200) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("my scans read failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "internal" }, { status: 503 });
  }
}
