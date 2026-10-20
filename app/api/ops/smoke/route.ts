/**
 * POST /api/ops/smoke: operator-only smoke detonation on a Preview deployment
 * (lib/server/ops-smoke.ts). Answers 404 on production, without the operator
 * key, and for every other method.
 */

import { handleOpsSmoke } from "@/lib/server/ops-smoke";

export const runtime = "nodejs";
// Next to the v2 database (Supabase ap-south-1): every scan, cache and token query is one short hop.
export const preferredRegion = "bom1";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  return handleOpsSmoke(req, process.env);
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export const GET = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
