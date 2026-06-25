/**
 * Auth callback — completes the server-side auth flow for both Google OAuth and
 * email magic-link / OTP sign-in.
 *
 * Two link shapes are handled so email sign-in works regardless of the template:
 *   - PKCE (`?code=...`): used by OAuth and by `@supabase/ssr` magic links.
 *     Exchanged for a session via `exchangeCodeForSession`.
 *   - Token-hash (`?token_hash=...&type=...`): the newer recommended email link
 *     shape. Verified via `verifyOtp`.
 * Either way the server client writes the session cookies (its `setAll` runs in
 * a route handler, where the cookie store IS writable), then we redirect to `/`
 * — the SPA, which reads the now-present session and flips into the dashboard.
 *
 * Because the cookies are written here (server-side), the browser Supabase client
 * the SPA boots with already has a valid session on the post-redirect load: it
 * fires `INITIAL_SESSION` (with the session), NOT `SIGNED_IN`. So we append
 * `?auth=ok` to the success redirect; the SPA reads that marker to know it just
 * returned from a real sign-in — routing to the dashboard and restoring the
 * pending repo — then strips the param from the URL.
 *
 * The server client holds only the publishable key (no secret ever here).
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Email OTP `type` values verifyOtp accepts via the token-hash flow. */
const EMAIL_OTP_TYPES = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
] as const;
type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number];

function asEmailOtpType(v: string | null): EmailOtpType | null {
  return v && (EMAIL_OTP_TYPES as readonly string[]).includes(v)
    ? (v as EmailOtpType)
    : null;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = asEmailOtpType(url.searchParams.get("type"));
  // `next` lets a caller route post-login elsewhere, but it MUST stay on this
  // origin — an absolute URL in `next` would otherwise let a crafted magic-link
  // redirect a freshly-authenticated user to an attacker site (open redirect).
  // Resolve against the origin, then accept only a same-origin path.
  const next = url.searchParams.get("next") ?? "/";
  const redirectTo = new URL("/", url.origin);
  try {
    const candidate = new URL(next, url.origin);
    if (candidate.origin === url.origin) {
      redirectTo.pathname = candidate.pathname;
      redirectTo.search = candidate.search;
    }
  } catch {
    // Malformed `next` — keep the safe root default.
  }

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      redirectTo.pathname = "/";
      redirectTo.search = "";
      redirectTo.searchParams.set("auth_error", "exchange_failed");
    } else {
      // Mark a real sign-in so the SPA routes to the dashboard on the
      // post-redirect load (where the browser client fires INITIAL_SESSION,
      // not SIGNED_IN). The SPA strips this param after consuming it.
      redirectTo.searchParams.set("auth", "ok");
    }
    return NextResponse.redirect(redirectTo);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (error) {
      redirectTo.pathname = "/";
      redirectTo.search = "";
      redirectTo.searchParams.set("auth_error", "otp_failed");
    } else {
      redirectTo.searchParams.set("auth", "ok");
    }
    return NextResponse.redirect(redirectTo);
  }

  // No recognizable auth params — bounce home with a flag the SPA can ignore.
  redirectTo.pathname = "/";
  redirectTo.searchParams.set("auth_error", "missing_code");
  return NextResponse.redirect(redirectTo);
}
