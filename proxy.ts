/**
 * Page proxy (Next.js 16's `proxy` convention, which replaces `middleware`;
 * Node.js runtime). Two jobs on every page request:
 *
 * 1. Content-Security-Policy with a fresh nonce (lib/csp.ts). The nonce goes on
 *    the REQUEST as `x-nonce` and inside a request `Content-Security-Policy`
 *    header, which is where Next.js reads it to stamp its own scripts during the
 *    render, and the same policy goes on the RESPONSE for the browser
 *    (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 *
 * 2. Supabase session refresh (@supabase/ssr), holding ONLY the publishable key
 *    (CLAUDE.md: the client/edge surface never sees a secret). The app's login is
 *    an in-SPA screen, so the proxy never redirects; it only rotates cookies. The
 *    canonical cookie-forwarding shape is kept: each refreshed cookie is written
 *    to the request and to a freshly re-created response, and that exact
 *    response is returned, or the rotated cookie is dropped.
 *
 * Not matched: JSON and protocol routes (`/api/*`, `/mcp`, `/oauth/token`,
 * `/oauth/register`, `/.well-known/*`; they read no cookie session and carry
 * API_CONTENT_SECURITY_POLICY from next.config.ts), the embeddable `/badge/*`,
 * build assets, and images. Skipping /api/scan also keeps a Supabase auth round
 * trip off the scan's critical path.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { makeNonce, pageContentSecurityPolicy } from "./lib/csp";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = makeNonce();
  const csp = pageContentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development", vercelToolbar: process.env.VERCEL_ENV === "preview" });

  // Rebuilt from request.headers each time, so cookies refreshed below are carried too.
  const forward = (): NextResponse => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  let response = forward();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // No Supabase env: no session to refresh; the page still gets its CSP.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = forward();
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Do not run code between createServerClient and getUser(), and do not remove
  // getUser(): it is what triggers the token refresh and the cookie write.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api/|mcp(?:/|$)|oauth/token|oauth/register|\\.well-known/|badge/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
    },
  ],
};
