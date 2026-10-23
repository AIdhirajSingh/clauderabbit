/**
 * Public, server-rendered safety report for a GitHub repo, the SEO surface: the v4 report screen
 * (project/term/Report.dc.html) driven by the latest 2.0 report and its run's observed events.
 *
 * Only a 2.0 (schema v2) report renders here. A repo with no 2.0 report (an old 1.0 link, or never scanned)
 * redirects to `/app?scan=https://github.com/<owner>/<repo>`, which starts the scan on the App screen.
 *
 * Rails (CLAUDE.md): the verdict word is the engine's own five-word set, never a bare "Safe"; reputation sits in
 * its own card, apart from the code and behaviour cards.
 */

import { cache } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeJsonLd } from "@/lib/json-ld";
import { webAdFor } from "@/lib/ads-web";
import { ADS_ENABLED } from "@/lib/ads-enabled";
import { Header } from "@/components/v4/Header";
import { ReportV4 } from "@/components/v4/report/ReportV4";
import { latestV2Report, type V2Report } from "@/components/v4/report/data";
import { reportDescription } from "@/components/v4/report/meta";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

interface RouteParams {
  params: Promise<{ owner: string; repo: string }>;
}

/** One read per request, shared by generateMetadata and the page. */
const getReport = cache((owner: string, repo: string): Promise<V2Report | null> => latestV2Report(owner, repo));

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { owner, repo } = await params;
  const report = await getReport(owner, repo);
  const title = `${repo} · ClaudeRabbit security report`;
  const description = report
    ? reportDescription(`${owner}/${repo}`, report.payload)
    : `Security report for ${owner}/${repo}. ClaudeRabbit reads the code and runs it in a throwaway sandbox to return a 0–100 score with the evidence.`;
  const url = `${SITE_URL}/${owner}/${repo}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    robots: report ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title, description, url, siteName: "ClaudeRabbit", type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** schema.org Review of the repository; the rating is the same engine score the page shows. */
function ReportJsonLd({ owner, repo, report }: { owner: string; repo: string; report: V2Report }) {
  const slug = `${owner}/${repo}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Review",
    name: `${repo} · ClaudeRabbit security report`,
    reviewBody: report.payload.summary,
    itemReviewed: { "@type": "SoftwareSourceCode", name: slug, codeRepository: `https://github.com/${slug}`, url: `${SITE_URL}/${slug}` },
    reviewRating: { "@type": "Rating", ratingValue: report.payload.score, bestRating: 100, worstRating: 0, alternateName: report.payload.verdict },
    author: { "@type": "Organization", name: "ClaudeRabbit", url: SITE_URL },
  };
  // The summary is model-written and can echo attacker text; safeJsonLd escapes `<` so it cannot close the script.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }} />;
}

export default async function ReportPage({ params }: RouteParams) {
  const { owner, repo } = await params;
  const report = await getReport(owner, repo);
  if (!report) redirect(`/app?scan=${encodeURIComponent(`https://github.com/${owner}/${repo}`)}`);

  return (
    <div style={{ minHeight: "100vh", background: "#000" }}>
      <ReportJsonLd owner={owner} repo={repo} report={report} />
      <Header />
      <ReportV4
        report={report}
        sourceLabel={`github.com/${owner}/${repo}`}
        ad={ADS_ENABLED ? webAdFor({ kind: "github", name: `${owner}/${repo}` }) : null}
        newScanHref="/app"
      />
    </div>
  );
}
