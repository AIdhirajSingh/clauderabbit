/**
 * GET /api/report?owner=...&repo=... : the latest public report for the SPA.
 * 2.0 reports live in schema v2, which the browser cannot read, so the SPA
 * asks the server: v2 first, then the 1.0 public report (`latestReport`).
 * Reports are public; the response is cacheable for a short time.
 */

import { isValidSlug } from "@/lib/report-fetch";
import { latestReport } from "@/lib/server/report-source";
import { hidesLegacyRoutes, plainNotFound } from "@/lib/server/preview-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEGMENT_RE = /^[A-Za-z0-9._@-]{1,214}$/;

export async function GET(req: Request): Promise<Response> {
  if (hidesLegacyRoutes()) return plainNotFound();
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner") ?? "";
  const repo = url.searchParams.get("repo") ?? "";
  if (!isValidSlug(`${owner}/${repo}`) || !SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) {
    return Response.json({ error: "invalid owner or repo" }, { status: 400 });
  }
  const report = await latestReport(owner, repo);
  if (!report) return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json({ report }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=120" } });
}
