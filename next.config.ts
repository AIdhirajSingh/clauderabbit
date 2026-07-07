import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Hide the on-screen dev indicator/watermark (a clean preview surface; it never
  // shipped to production anyway, but the local preview is the demo surface).
  devIndicators: false,
  // Inlines above-the-fold critical CSS and defers the rest, instead of a
  // render-blocking <link> for the whole stylesheet — a real Lighthouse LCP
  // finding on the homepage (two small render-blocking CSS chunks costing
  // ~460ms of simulated-mobile LCP). Requires the `critters` devDependency.
  experimental: {
    optimizeCss: true,
  },
  // Pin the workspace root to THIS project so Turbopack doesn't infer it from a
  // parent lockfile (the git-worktree layout has a lockfile above us). Absolute
  // path per the Next 16 turbopack.root contract.
  turbopack: {
    root: __dirname,
  },
  // @sparticuz/chromium (app/api/export/pdf) ships its Chromium binary as a
  // brotli file it locates relative to its own package directory at runtime.
  // Left un-externalized, Next's server bundler relocates/tree-shakes the
  // package and that lookup fails on Vercel ("input directory .../bin does not
  // exist" — a documented bundler-compat requirement of the package, verified
  // live on a real deploy). Externalizing keeps the package's real on-disk
  // layout intact in the deployed function.
  serverExternalPackages: ["@sparticuz/chromium"],
  // Externalizing alone isn't enough: Next's output file tracer decides which
  // files actually get COPIED into the deployed function by static analysis,
  // and @sparticuz/chromium resolves its binary path dynamically at runtime,
  // so the tracer misses it (verified live: the JS loads fine but
  // ".../bin does not exist" at runtime). Force the trace to include it.
  outputFileTracingIncludes: {
    "/api/export/pdf": ["./node_modules/@sparticuz/chromium/**"],
  },
  // The /api/deep route shells out to `sandbox/orchestrate.sh` and reads
  // `sandbox/results/*` from the REAL filesystem at runtime (process.cwd()), so
  // Next's file tracer can't statically resolve those paths and conservatively
  // bundles the whole project into that function. Exclude those heavy/irrelevant
  // SOURCE trees to keep the serverless function small and under platform size
  // limits.
  //
  // Real production bug this caused (fixed): `node_modules/**` AND `.next/**`
  // were ALSO in this list. The route is gated closed on Vercel
  // (CR_ALLOW_LOCAL_DEEP unset), but that gate check runs INSIDE the handler —
  // Vercel still has to load and evaluate the route module's top-level imports
  // (including `@supabase/supabase-js`, used by `confirmForensicsAttached`) on
  // every cold start, gate or no gate. Turbopack bundles that kind of
  // node_modules dependency into its OWN compiled chunk file under
  // `.next/server/chunks/` (not a raw copy of the `node_modules/` source), so
  // excluding `.next/**` stripped that chunk out of the deployed function too —
  // both exclusions pointed at the same real dependency by two different
  // paths. Every real invocation 500'd with `Error [ChunkLoadError] ... Cannot
  // find module '.next/server/chunks/[root-of-the-server]__*.js`
  // (MODULE_NOT_FOUND)` before the gate ever ran — silently, since the
  // client-facing toast treats any dispatch failure as the same honest
  // "sandbox unavailable" message. Removing both lets the tracer include only
  // what this route actually needs (still nowhere near the full project).
  outputFileTracingExcludes: {
    "/api/deep": [
      "sandbox/**",
      "docs/**",
      "design-source/**",
      "supabase/**",
      "tests/**",
      "public/**",
    ],
  },
  // Security headers (production-grade) + the embeddable trust badge.
  async headers() {
    // Hardening headers safe on every route (they don't affect embedding).
    const base = [
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
      { key: "X-DNS-Prefetch-Control", value: "on" },
    ];
    // A functional CSP: self + the inline styles the design uses + Supabase for the
    // anon REST/auth reads + data/https images. The two typefaces (Instrument Serif +
    // Geist) are self-hosted via next/font — their files are served from our own origin
    // and the @font-face CSS is inlined — so no external font host needs to be allowed;
    // `font-src 'self'` covers the self-hosted woff2 files. This is strictly tighter than
    // allowing fonts.googleapis.com / fonts.gstatic.com.
    // frame-ancestors 'none' clickjack-proofs the app (the badge route below re-opens framing).
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' https://*.supabase.co https://*.supabase.in",
    ].join("; ");
    return [
      {
        // every route EXCEPT the embeddable badge (negative lookahead)
        source: "/((?!badge/).*)",
        headers: [...base, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: csp }],
      },
      {
        // The public trust badge + standalone HTML report exports are embedded on
        // third-party sites, so badge routes stay cacheable, CORS-open, and frameable.
        source: "/badge/:path*",
        headers: [
          ...base,
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=600" },
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
    ];
  },
};

export default nextConfig;
