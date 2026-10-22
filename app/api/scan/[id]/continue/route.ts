/**
 * POST /api/scan/<id>/continue
 * Yes on "Keep installing to scan it fully?": the running scan's install keeps
 * going, in the same run, inside its budget (lib/engine/sandbox/e2b.ts
 * continueRunInstall). Returns how many detonation VMs were told; 0 when the run
 * has no running install (it already finished, or never had one).
 */

import { continueRunInstall } from "@/lib/engine/sandbox/e2b";
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
    return Response.json({ continued: await continueRunInstall(config.e2bApiKey, id) });
  } catch {
    return new Response(null, { status: 503 });
  }
}
