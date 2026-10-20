/**
 * GET /api/scan/replay?target=<github:owner/repo|npm:name>&sha=<sha or version key>
 * Replays the latest completed run for that subject and SHA (DESIGN.md section 6).
 */

import { createV2Store } from "@/lib/engine/store";
import { adForRequest, realtimeChannel, replaySubject, serverConfig, surfaceFromHeader } from "@/lib/server/scan-service";

export const runtime = "nodejs";
// Next to the v2 database (Supabase ap-south-1): every scan, cache and token query is one short hop.
export const preferredRegion = "bom1";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ad = adForRequest(surfaceFromHeader(req.headers.get("x-clauderabbit-client")), null);
  const subject = replaySubject(url.searchParams.get("target") ?? "");
  const sha = (url.searchParams.get("sha") ?? "").trim();
  if (!subject || !sha || sha.length > 300) return Response.json({ error: "invalid_target", message: "target and sha are required", ad }, { status: 400 });
  let store;
  try {
    store = createV2Store(serverConfig());
  } catch (err) {
    return Response.json({ error: "internal", message: err instanceof Error ? err.message : "configuration error", ad }, { status: 503 });
  }
  const run = await store.findLatestDoneRun(subject, sha);
  if (!run) return Response.json({ error: "not_found", ad }, { status: 404 });
  const events = await store.loadEvents(run.id);
  return Response.json(
    { run_id: run.id, subject, commit_sha: sha, realtime_channel: realtimeChannel(run.id), events: events.map((e) => ({ ...e, replayed: true })), ad },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
