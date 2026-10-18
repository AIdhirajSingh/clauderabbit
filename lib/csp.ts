/**
 * The site Content-Security-Policy.
 *
 * Pages (everything `proxy.ts` matches) get a strict, per-request nonce policy:
 *
 *   script-src 'nonce-<random>' 'strict-dynamic' https: 'unsafe-inline'
 *
 * This is the policy Google supports for GPT and AdSense
 * (developers.google.com/publisher-tag/guides/content-security-policy and
 * support.google.com/adsense/answer/16283098). A CSP3 browser runs only scripts
 * that carry the request's nonce, plus scripts those scripts create
 * ('strict-dynamic'), which is how Next's runtime chunks, gpt.js and
 * adsbygoogle.js load. 'strict-dynamic' makes a CSP3 browser ignore both `https:`
 * and 'unsafe-inline'; they are there only as the CSP2 fallback, exactly as
 * Google documents. An injected `<script>` without the nonce is refused.
 * `'unsafe-eval'` is added only in development (React's dev tooling uses eval).
 *
 * Next.js reads the nonce from the request's Content-Security-Policy header and
 * stamps it on its own scripts; the root layout reads `x-nonce` for the theme
 * init script. A nonce only works on a page rendered per request, so every page
 * renders dynamically (report data stays cached through `unstable_cache`).
 *
 * The other directives list the hosts the GPT rewarded overlay and the AdSense
 * unit were seen to use on the 2.0 preview (docs/runs/2.0-keyday.md steps 5 and
 * 8): ad frames and beacons on doubleclick.net, googlesyndication.com,
 * google.com and adtrafficquality.google; the overlay's Roboto stylesheet and
 * fonts; its video creative on gvt1.com / googlevideo.com. `img-src` keeps
 * `https:` because the app itself shows avatars from arbitrary OAuth CDNs
 * (components/spa/components/Sidebar.tsx); an image cannot run script.
 *
 * Routes the proxy does not run on (JSON APIs, MCP, OAuth endpoints) get
 * API_CONTENT_SECURITY_POLICY from next.config.ts; the embeddable badge keeps
 * its own `frame-ancestors *`.
 */

/** Script hosts are not listed: Google supports only nonce + 'strict-dynamic' for its tags. */
export const GOOGLE_ADS_FRAME_SOURCES = [
  "https://*.doubleclick.net",
  "https://*.googlesyndication.com",
  "https://*.google.com",
  "https://*.adtrafficquality.google",
];
export const GOOGLE_ADS_CONNECT_SOURCES = [
  "https://*.doubleclick.net",
  "https://*.googlesyndication.com",
  "https://*.google.com",
  "https://*.adtrafficquality.google",
];
export const GOOGLE_ADS_STYLE_SOURCES = ["https://fonts.googleapis.com"];
export const GOOGLE_ADS_FONT_SOURCES = ["https://fonts.gstatic.com"];
export const GOOGLE_ADS_MEDIA_SOURCES = ["blob:", "https://*.gvt1.com", "https://*.googlevideo.com", "https://*.doubleclick.net", "https://*.googlesyndication.com"];
const SUPABASE_CONNECT = ["https://*.supabase.co", "https://*.supabase.in", "wss://*.supabase.co", "wss://*.supabase.in"];

/**
 * Vercel injects its toolbar (vercel.live/_next-live/feedback/feedback.js) into
 * Preview deployments only; the hosts below are the ones Vercel documents for it
 * (vercel.com/docs/vercel-toolbar/managing-toolbar, "Using a Content Security Policy").
 * They are added only when VERCEL_ENV is "preview", never on production.
 */
export const VERCEL_TOOLBAR = {
  frame: ["https://vercel.live"],
  connect: ["https://vercel.live", "wss://ws-us3.pusher.com"],
  style: ["https://vercel.live"],
  font: ["https://vercel.live", "https://assets.vercel.com"],
};

/** For JSON / text endpoints: nothing loads, nothing frames them. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** 128 random bits, base64 (the CSP nonce grammar is base64 / base64url). */
export function makeNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

const NONCE_RE = /^[A-Za-z0-9+/_-]{16,64}={0,2}$/;

export function pageContentSecurityPolicy(nonce: string, opts: { dev?: boolean; vercelToolbar?: boolean } = {}): string {
  const tb = opts.vercelToolbar ? VERCEL_TOOLBAR : { frame: [], connect: [], style: [], font: [] };
  if (!NONCE_RE.test(nonce)) throw new Error("invalid CSP nonce");
  const script = [`'nonce-${nonce}'`, "'strict-dynamic'", "https:", "'unsafe-inline'", ...(opts.dev ? ["'unsafe-eval'"] : [])];
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `script-src ${script.join(" ")}`,
    `style-src 'self' 'unsafe-inline' ${[...GOOGLE_ADS_STYLE_SOURCES, ...tb.style].join(" ")}`,
    `font-src 'self' data: ${[...GOOGLE_ADS_FONT_SOURCES, ...tb.font].join(" ")}`,
    "img-src 'self' data: blob: https:",
    `media-src 'self' ${GOOGLE_ADS_MEDIA_SOURCES.join(" ")}`,
    `frame-src 'self' ${[...GOOGLE_ADS_FRAME_SOURCES, ...tb.frame].join(" ")}`,
    `connect-src 'self' ${[...SUPABASE_CONNECT, ...GOOGLE_ADS_CONNECT_SOURCES, ...tb.connect].join(" ")}`,
  ].join("; ");
}
