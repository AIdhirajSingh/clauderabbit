/**
 * Public, server-rendered safety report for an npm package: the v4 report screen driven by the latest 2.0 report
 * (stored with owner "npm" and the package name, scoped or not). The static `npm` segment wins over `[owner]`, so
 * both `/npm/left-pad` and `/npm/@scope/name` render here.
 *
 * Only a 2.0 report renders. A package with no 2.0 report redirects to `/app?scan=npm:<pkg>`, which starts the scan.
 * Rails are the same as the GitHub report page: engine verdict words only, never a bare "Safe"; reputation apart.
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
const NPM_OWNER = "npm";

interface RouteParams {
  params: Promise<{ pkg: string[] }>;
}

/** ["@babel", "core"] -> "@babel/core". */
function packageName(segments: string[] | undefined): string {
  return (segments ?? []).join("/");
}

const getReport = cache((pkg: string): Promise<V2Report | null> => latestV2Report(NPM_OWNER, pkg));

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const name = packageName((await params).pkg);
  const report = await getReport(name);
  const title = `${name} · ClaudeRabbit security report`;
  const description = report
    ? reportDescription(`${name} (npm)`, report.payload)
    : `Security report for the npm package ${name}. ClaudeRabbit reads the code and runs it in a throwaway sandbox to return an honest 0–100 score.`;
  const url = `${SITE_URL}/npm/${name}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    robots: report ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title, description, url, siteName: "ClaudeRabbit", type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** schema.org Review of the npm package (the registry page, not a GitHub repo, is what was scanned). */
function ReportJsonLd({ pkg, report }: { pkg: string; report: V2Report }) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Review",
    name: `${pkg} · ClaudeRabbit security report`,
    reviewBody: report.payload.summary,
    itemReviewed: { "@type": "SoftwareSourceCode", name: pkg, url: `https://www.npmjs.com/package/${pkg}` },
    reviewRating: { "@type": "Rating", ratingValue: report.payload.score, bestRating: 100, worstRating: 0, alternateName: report.payload.verdict },
    author: { "@type": "Organization", name: "ClaudeRabbit", url: SITE_URL },
  };
  // The summary is model-written and can echo attacker text; safeJsonLd escapes `<` so it cannot close the script.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }} />;
}

export default async function NpmReportPage({ params }: RouteParams) {
  const name = packageName((await params).pkg);
  const report = await getReport(name);
  if (!report) redirect(`/app?scan=${encodeURIComponent(`npm:${name}`)}`);

  return (
    <div style={{ minHeight: "100vh", background: "#000" }}>
      <ReportJsonLd pkg={name} report={report} />
      <Header />
      <ReportV4
        report={report}
        sourceLabel={`npmjs.com/package/${name}`}
        ad={ADS_ENABLED ? webAdFor({ kind: "npm", name }) : null}
        newScanHref="/app"
      />
    </div>
  );
}
