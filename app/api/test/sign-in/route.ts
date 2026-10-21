/**
 * GET /api/test/sign-in: Preview-only. Signs the fixed test account in
 * server-side, sets the Supabase session cookies, and redirects to `/app`.
 * 404 everywhere else (production included). See lib/server/test-signin.ts.
 *
 * The password comes from the Preview-scoped sensitive env var
 * CR_TEST_ACCOUNT_PASSWORD and never leaves the server; the caller types and
 * sees nothing.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { crossSiteRequest, signInTestAccount, testSignInEnabled } from "@/lib/server/test-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function GET(request: Request): Promise<Response> {
  if (!testSignInEnabled()) return new Response("Not Found", { status: 404, headers: HEADERS });
  if (crossSiteRequest(request.headers)) {
    return Response.json({ error: "cross_site_request_refused" }, { status: 403, headers: HEADERS });
  }
  const password = process.env.CR_TEST_ACCOUNT_PASSWORD;
  if (!password) {
    return Response.json({ error: "test_account_not_configured" }, { status: 503, headers: HEADERS });
  }

  const supabase = await createClient();
  const result = await signInTestAccount(supabase.auth, password);
  if (!result.ok) {
    console.error("test sign-in failed:", result.reason, result.detail);
    return Response.json({ error: result.reason, detail: result.detail }, { status: 502, headers: HEADERS });
  }

  // `auth=ok` is the same marker app/auth/callback/route.ts appends after a
  // real sign-in, so the SPA treats this load as a fresh sign-in.
  const to = new URL("/app", request.url);
  to.searchParams.set("auth", "ok");
  const res = NextResponse.redirect(to, 303);
  for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
  return res;
}
