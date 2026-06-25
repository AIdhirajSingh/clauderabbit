/**
 * Session-refresh proxy (@supabase/ssr) — Next.js 16's `proxy` convention,
 * which replaces the deprecated `middleware`. The `proxy` runtime is Node.js,
 * which is exactly what `@supabase/ssr`'s `createServerClient` wants.
 *
 * Runs on every matched request and keeps the Supabase auth cookie fresh so a
 * logged-in session survives navigation and the access token is rotated before
 * it expires. It holds ONLY the publishable key (CLAUDE.md: the client/edge
 * surface never sees a secret).
 *
 * This app's login is an in-SPA screen (there is no `/login` route), so the
 * proxy does NOT redirect unauthenticated users anywhere — it only refreshes
 * cookies. The canonical @supabase/ssr cookie-forwarding shape is followed
 * exactly: write each refreshed cookie to BOTH the request and a freshly
 * re-created response, then return that exact response unmodified, or the
 * rotated cookie is dropped and sessions silently expire.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // If env is missing we cannot refresh a session — pass the request through
  // untouched rather than throwing (the SPA still renders its logged-out flow).
  if (!url || !key) return supabaseResponse;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: do not run code between createServerClient and getUser(), and do
  // not remove getUser() — it is what triggers the token refresh + cookie write.
  await supabase.auth.getUser();

  // Return the exact supabaseResponse so the refreshed cookies are sent back.
  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets:
     * - _next/static / _next/image (build output + optimized images)
     * - favicon.ico and common image extensions
     * Everything else (the SPA, /auth/callback, /owner/repo pages) refreshes the
     * session cookie on each request.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
