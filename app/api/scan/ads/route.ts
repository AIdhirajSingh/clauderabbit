/**
 * POST /api/scan/ads { run_id }
 * One GPT ad impression rendered on the scan screen of that run (components/cr/app/Ads.tsx).
 * Counted into v2.scan_runs.ads_shown for the run's unit economics (v2.scan_economics);
 * the store counts at most one every 25 s per run (the slot refreshes no faster than every 30 s).
 */

import { createV2Store } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  let runId = "";
  try {
    const raw = await req.text();
    if (raw.length > 256) return new Response(null, { status: 400 });
    const b = JSON.parse(raw) as { run_id?: unknown };
    runId = typeof b.run_id === "string" ? b.run_id : "";
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!UUID_RE.test(runId)) return new Response(null, { status: 400 });
  try {
    const counted = await createV2Store(serverConfig()).recordAdImpression(runId);
    return Response.json({ counted });
  } catch {
    return new Response(null, { status: 503 });
  }
}
