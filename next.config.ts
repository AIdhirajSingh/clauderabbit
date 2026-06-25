import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
