/**
 * sitemap.xml (App Router metadata route): the site's pages plus every public 2.0 report, latest per target, from
 * schema v2 (`fetchV2Slugs`, which leaves out our own test fixtures). 1.0-only targets are not listed: their old
 * links redirect to a fresh 2.0 scan. Revalidated hourly; degrades to the static pages if the read fails.
 */
import type { MetadataRoute } from "next";
import type { ReportSlug } from "@/lib/report-fetch";
import { v2DbOrNull } from "@/lib/server/report-source";
import { fetchV2Slugs } from "@/lib/server/report-v2";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

/** Refresh the sitemap hourly (newly-published reports appear without a rebuild). */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/app`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
  const db = v2DbOrNull();
  const slugs = db ? await fetchV2Slugs(db).catch(() => [] as ReportSlug[]) : [];
  const reportRoutes: MetadataRoute.Sitemap = slugs.map(({ owner, repo, lastmod }) => ({
    url: `${SITE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    lastModified: lastmod ? new Date(lastmod) : undefined,
    changeFrequency: "weekly",
    priority: 0.7,
  }));
  return [...staticRoutes, ...reportRoutes];
}
