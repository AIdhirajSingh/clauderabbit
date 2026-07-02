import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Hide the on-screen dev indicator/watermark (a clean preview surface; it never
  // shipped to production anyway, but the local preview is the demo surface).
  devIndicators: false,
  // Pin the workspace root to THIS project so Turbopack doesn't infer it from a
  // parent lockfile (the git-worktree layout has a lockfile above us). Absolute
  // path per the Next 16 turbopack.root contract.
  turbopack: {
    root: __dirname,
  },
  // The /api/deep route shells out to `sandbox/orchestrate.sh` and reads
  // `sandbox/results/*` from the REAL filesystem at runtime (process.cwd()), so
  // Next's file tracer can't statically resolve those paths and conservatively
  // bundles the whole project into that function. The route is a localhost
  // sandbox-controller capability and is inert on any deploy (gated off), so it
  // never needs those files bundled — exclude the heavy/irrelevant trees to keep
  // the serverless function small and under platform size limits.
  outputFileTracingExcludes: {
    "/api/deep": [
      "node_modules/**",
      "sandbox/**",
      ".next/**",
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
