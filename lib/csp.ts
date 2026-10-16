/**
 * The site Content-Security-Policy (used by next.config.ts headers()).
 *
 * self + the inline styles the design uses + Supabase for REST/auth (https) and
 * Realtime (wss) + data/https images. The two typefaces are self-hosted via
 * next/font, so `font-src 'self'` covers them. Google AdSense needs its loader
 * script (pagead2.googlesyndication.com), the ad iframes (googleads.g.doubleclick.net,
 * tpc.googlesyndication.com, *.google.com) and its reporting calls; without these
 * the required web ad never renders. frame-ancestors 'none' clickjack-proofs the
 * app (the badge route re-opens framing).
 */
export const ADSENSE_SCRIPT_ORIGINS = ["https://pagead2.googlesyndication.com", "https://*.googlesyndication.com", "https://*.google.com", "https://*.gstatic.com", "https://*.adtrafficquality.google"];
export const ADSENSE_FRAME_ORIGINS = ["https://googleads.g.doubleclick.net", "https://tpc.googlesyndication.com", "https://*.googlesyndication.com", "https://*.google.com", "https://*.doubleclick.net"];
export const ADSENSE_CONNECT_ORIGINS = ["https://pagead2.googlesyndication.com", "https://*.googlesyndication.com", "https://*.google.com", "https://*.doubleclick.net", "https://*.adtrafficquality.google"];

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
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${ADSENSE_SCRIPT_ORIGINS.join(" ")}`,
    `frame-src 'self' ${ADSENSE_FRAME_ORIGINS.join(" ")}`,
    `connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co wss://*.supabase.in ${ADSENSE_CONNECT_ORIGINS.join(" ")}`,
  ].join("; ");
}
