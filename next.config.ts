import type { NextConfig } from "next";
import { API_CONTENT_SECURITY_POLICY } from "./lib/csp";

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
    // Pages get their per-request nonce CSP from proxy.ts (lib/csp.ts). The routes the
    // proxy does not match are JSON / protocol endpoints: they get a CSP that loads nothing.
    // These sources mirror the proxy matcher's exclusions, so no response carries two policies.
    const apiSources = ["/api/:path*", "/mcp", "/mcp/:path*", "/oauth/token", "/oauth/register", "/.well-known/:path*"];
    return [
      {
        // every route EXCEPT the embeddable badge (negative lookahead)
        source: "/((?!badge/).*)",
        headers: [...base, { key: "X-Frame-Options", value: "DENY" }],
      },
      ...apiSources.map((source) => ({ source, headers: [{ key: "Content-Security-Policy", value: API_CONTENT_SECURITY_POLICY }] })),
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
