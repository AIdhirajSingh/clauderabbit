/**
 * The site Content-Security-Policy (used by next.config.ts headers()).
 *
 * self + the inline styles the design uses + Supabase for REST/auth (https) and
 * Realtime (wss) + data/https images. The two typefaces are self-hosted via
 * next/font, so `font-src 'self'` covers them. frame-ancestors 'none'
 * clickjack-proofs the app (the badge route re-opens framing).
 *
 * Google ads on the web: the GPT rewarded ad during a scan
 * (securepubads.g.doubleclick.net/tag/js/gpt.js) and the AdSense unit on report
 * pages (pagead2.googlesyndication.com/pagead/js/adsbygoogle.js). Google's CSP
 * guidance for both (developers.google.com/publisher-tag/guides/content-security-policy
 * and support.google.com/adsense/answer/16283098) supports only a policy shaped
 * like `script-src 'nonce-{random}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic'
 * https: http:` with no frame-src or connect-src restriction, and states that a
 * domain allowlist is unsupported because the domains the ad code uses change
 * over time. This site has no per-request nonce (its pages are statically
 * rendered), so the policy uses the form Google's policy takes without a nonce:
 * the `https:` scheme for scripts, ad frames and ad beacons. `http:` is left out
 * because an https page blocks mixed-content scripts regardless.
 */
export const GOOGLE_ADS_SCRIPT_SOURCES = ["https:"];
export const GOOGLE_ADS_FRAME_SOURCES = ["https:"];
export const GOOGLE_ADS_CONNECT_SOURCES = ["https:"];
const SUPABASE_CONNECT = ["https://*.supabase.co", "https://*.supabase.in", "wss://*.supabase.co", "wss://*.supabase.in"];

export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${GOOGLE_ADS_SCRIPT_SOURCES.join(" ")}`,
    `frame-src 'self' ${GOOGLE_ADS_FRAME_SOURCES.join(" ")}`,
    `connect-src 'self' ${[...SUPABASE_CONNECT, ...GOOGLE_ADS_CONNECT_SOURCES].join(" ")}`,
  ].join("; ");
}
