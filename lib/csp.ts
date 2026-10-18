/**
 * The site Content-Security-Policy (used by next.config.ts headers()).
 *
 * self + the inline styles the design uses + Supabase for REST/auth (https) and
 * Realtime (wss) + data/https images. The two typefaces are self-hosted via
 * next/font, so `font-src 'self'` covers them (the `https:` there is for the ad overlay). frame-ancestors 'none'
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
 * the `https:` scheme for scripts, ad frames, ad beacons, and the overlay's styles, fonts and video. `http:` is left out
 * because an https page blocks mixed-content scripts regardless.
 */
export const GOOGLE_ADS_SCRIPT_SOURCES = ["https:"];
export const GOOGLE_ADS_FRAME_SOURCES = ["https:"];
export const GOOGLE_ADS_CONNECT_SOURCES = ["https:"];
/**
 * Observed on the 2.0 preview with the sample rewarded unit: the rewarded overlay in the top document
 * loads the Roboto stylesheet from fonts.googleapis.com (fonts from fonts.gstatic.com) and plays the
 * video creative from redirector.gvt1.com; under `default-src 'self'` both were blocked and the video
 * stayed black. Google's policy leaves these directives unrestricted, so they take the same `https:`.
 */
export const GOOGLE_ADS_STYLE_SOURCES = ["https:"];
export const GOOGLE_ADS_FONT_SOURCES = ["https:"];
export const GOOGLE_ADS_MEDIA_SOURCES = ["https:", "blob:"];
const SUPABASE_CONNECT = ["https://*.supabase.co", "https://*.supabase.in", "wss://*.supabase.co", "wss://*.supabase.in"];

export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https:",
    `font-src 'self' data: ${GOOGLE_ADS_FONT_SOURCES.join(" ")}`,
    `style-src 'self' 'unsafe-inline' ${GOOGLE_ADS_STYLE_SOURCES.join(" ")}`,
    `media-src 'self' ${GOOGLE_ADS_MEDIA_SOURCES.join(" ")}`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${GOOGLE_ADS_SCRIPT_SOURCES.join(" ")}`,
    `frame-src 'self' ${GOOGLE_ADS_FRAME_SOURCES.join(" ")}`,
    `connect-src 'self' ${[...SUPABASE_CONNECT, ...GOOGLE_ADS_CONNECT_SOURCES].join(" ")}`,
  ].join("; ");
}
