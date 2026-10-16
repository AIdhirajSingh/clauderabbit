/**
 * GET /api/runs/<runId>/events: replay of one run's stored events, ordered by
 * seq (DESIGN.md section 6). Public: events are already public on Realtime.
 */

import { createSupabaseStore } from "@/lib/engine/store";
import { realtimeChannel, serverConfig } from "@/lib/server/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }): Promise<Response> {
  const { runId } = await ctx.params;
  if (!UUID_RE.test(runId)) return Response.json({ error: "invalid_run_id" }, { status: 400 });
  let store;
  try {
    store = createSupabaseStore(serverConfig());
  } catch (err) {
    return Response.json({ error: "internal", message: err instanceof Error ? err.message : "configuration error" }, { status: 503 });
  }
  const run = await store.loadRun(runId);
  if (!run) return Response.json({ error: "not_found" }, { status: 404 });
  const events = await store.loadEvents(runId);
  return Response.json(
    { run_id: run.id, subject: run.subject, commit_sha: run.commit_sha, status: run.status, error_code: run.error_code, realtime_channel: realtimeChannel(run.id), events: events.map((e) => ({ ...e, replayed: true })) },
    { headers: { "Cache-Control": run.status === "running" ? "no-store" : "public, max-age=60" } },
  );
}
