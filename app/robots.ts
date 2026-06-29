/**
 * robots.txt (App Router metadata route). Crawlers are welcome on the public
 * surface — the homepage and every `/owner/repo` report (the SEO asset) — but the
 * scan/orchestration APIs and the auth callback are operational endpoints with no
 * indexable content, so they're disallowed. Points crawlers at the sitemap.
 */
import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
