/**
 * POST /api/scan/<id>/heartbeat
 * The scan page sends one every 10 s while it is open. Each extends the run's
 * heartbeat-kept VMs (full-install scans only) by HEARTBEAT_GRACE_MS (30 s), so a
 * closed tab stops them within 30 s. Ordinary scans have no heartbeat-kept VMs and
 * are untouched.
 */

import { HEARTBEAT_GRACE_MS } from "@/lib/engine/config";
import { extendRunSandboxes } from "@/lib/engine/sandbox/e2b";
import { serverConfig } from "@/lib/server/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID_RE.test(id)) return new Response(null, { status: 400 });
  try {
    const config = serverConfig();
    if (!config.e2bApiKey) return new Response(null, { status: 503 });
    const extended = await extendRunSandboxes(config.e2bApiKey, id, HEARTBEAT_GRACE_MS);
    return Response.json({ extended });
  } catch {
    return new Response(null, { status: 503 });
  }
}
