/**
 * POST /api/scan/ads { run_id, slot }
 * One GPT ad impression rendered in one slot of that run's scan page
 * (components/cr/app/Ads.tsx): 'video', 'banner_1' to 'banner_3' or 'interstitial'.
 * Counted into v2.scan_ad_impressions for the run's unit economics (v2.scan_economics);
 * the store counts at most one every 25 s per run and slot (each slot refreshes no
 * faster than every 30 s).
 */

import { AD_SLOTS, createV2Store, type AdSlotName } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  let runId = "";
  let slot = "";
  try {
    const raw = await req.text();
    if (raw.length > 256) return new Response(null, { status: 400 });
    const b = JSON.parse(raw) as { run_id?: unknown; slot?: unknown };
    runId = typeof b.run_id === "string" ? b.run_id : "";
    slot = typeof b.slot === "string" ? b.slot : "";
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!UUID_RE.test(runId) || !(AD_SLOTS as readonly string[]).includes(slot)) return new Response(null, { status: 400 });
  try {
    const counted = await createV2Store(serverConfig()).recordAdImpression(runId, slot as AdSlotName);
    return Response.json({ counted });
  } catch {
    return new Response(null, { status: 503 });
  }
}
