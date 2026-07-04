/**
 * sitemap.xml (App Router metadata route). Lists the homepage plus every public
 * `/owner/repo` report — the accumulating vetted-repo database is the SEO asset,
 * so each report is a routable, indexable URL. Report slugs come from the public
 * `reports` table via the anon REST read (the proven public-data path), deduped to
 * the latest report per repo. Revalidated hourly so freshly-scanned repos surface
 * without rebuilding. Degrades to just the static routes if the DB read fails.
 */
import type { MetadataRoute } from "next";
import { fetchRecentReportSlugs } from "@/lib/report-fetch";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

/** Refresh the sitemap hourly (newly-published reports appear without a rebuild). */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !anonKey) return staticRoutes;

  const slugs = await fetchRecentReportSlugs(supabaseUrl, anonKey);
  const reportRoutes: MetadataRoute.Sitemap = slugs.map(({ owner, repo, lastmod }) => ({
    url: `${SITE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    lastModified: lastmod ? new Date(lastmod) : undefined,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  return [...staticRoutes, ...reportRoutes];
}
