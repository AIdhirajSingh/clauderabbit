/**
 * sitemap.xml (App Router metadata route). Lists the homepage plus every public
 * `/owner/repo` report — the accumulating vetted-repo database is the SEO asset,
 * so each report is a routable, indexable URL. Report slugs come from the 2.0
 * reports in schema v2 (server role) and the 1.0 public `reports` table (anon
 * REST read), deduped to the latest report per repo. Revalidated hourly so freshly-scanned repos surface
 * without rebuilding. Degrades to just the static routes if the DB read fails.
 */
import type { MetadataRoute } from "next";
import { fetchRecentReportSlugs, type ReportSlug } from "@/lib/report-fetch";
import { v2DbOrNull } from "@/lib/server/report-source";
import { fetchV2Slugs } from "@/lib/server/report-v2";

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
  const db = v2DbOrNull();
  const [v2Slugs, v1Slugs] = await Promise.all([
    db ? fetchV2Slugs(db).catch(() => [] as ReportSlug[]) : Promise.resolve([] as ReportSlug[]),
    supabaseUrl && anonKey ? fetchRecentReportSlugs(supabaseUrl, anonKey) : Promise.resolve([] as ReportSlug[]),
  ]);
  const seen = new Set<string>();
  const slugs: ReportSlug[] = [];
  for (const s of [...v2Slugs, ...v1Slugs]) {
    const key = `${s.owner}/${s.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slugs.push(s);
  }
  const reportRoutes: MetadataRoute.Sitemap = slugs.map(({ owner, repo, lastmod }) => ({
    url: `${SITE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    lastModified: lastmod ? new Date(lastmod) : undefined,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  return [...staticRoutes, ...reportRoutes];
}
