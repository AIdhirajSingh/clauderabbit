/**
 * GET /api/runs/<runId>/report: the run's status and, once done, the report this
 * run wrote. The scan page reads it on load (cached commits open straight to the
 * result) and when the live stream ends.
 */

import { createV2Store } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";
import { loadRunReport } from "@/lib/server/board-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await ctx.params;
  if (!UUID_RE.test(runId)) return Response.json({ error: "invalid_run_id" }, { status: 400 });
  try {
    const store = createV2Store(serverConfig());
    const run = await loadRunReport(store.db, runId);
    if (!run) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(run, { headers: { "Cache-Control": run.status === "running" ? "no-store" : "public, max-age=60" } });
  } catch (err) {
    console.error("run report read failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "internal" }, { status: 503 });
  }
}
