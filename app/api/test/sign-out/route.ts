/**
 * GET /api/test/sign-out: Preview-only. Clears the Supabase session cookies
 * for this browser and redirects to `/`. 404 everywhere else.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { crossSiteRequest, testSignInEnabled } from "@/lib/server/test-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function GET(request: Request): Promise<Response> {
  if (!testSignInEnabled()) return new Response("Not Found", { status: 404, headers: HEADERS });
  if (crossSiteRequest(request.headers)) {
    return Response.json({ error: "cross_site_request_refused" }, { status: 403, headers: HEADERS });
  }
  const supabase = await createClient();
  // scope "local": end only this browser's session, not every session of the account.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) console.error("test sign-out:", error.message);
  const res = NextResponse.redirect(new URL("/", request.url), 303);
  for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
  return res;
}
