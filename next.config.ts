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
  // The public trust badge and standalone HTML report exports are embedded on
  // third-party sites, so badge routes must be cacheable and CORS-open.
  async headers() {
    return [
      {
        source: "/badge/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=600" },
        ],
      },
    ];
  },
};

export default nextConfig;
