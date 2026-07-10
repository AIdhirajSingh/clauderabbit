/**
 * Public, server-rendered safety report for an npm package — the SEO surface for
 * the npm ecosystem, mirroring `app/[owner]/[repo]/page.tsx`.
 *
 * npm reports persist with `owner_login = "npm"` and `repo_name = <package>`
 * (including a scoped `@scope/name`). An UNSCOPED package (`/npm/left-pad`, two
 * segments) already resolves through the generic `[owner]/[repo]` route, but a
 * SCOPED package (`/npm/@scope/name`, three path segments) does not match that
 * two-segment route. This dedicated catch-all makes BOTH forms resolve here and
 * makes `/npm/*` unambiguous: the static `npm` segment takes routing precedence
 * over the dynamic `[owner]` segment, so every `/npm/...` request renders through
 * this file with the same presentational `ReportBody` the SPA and the GitHub
 * report page use.
 *
 * Caching, rails, and rendering are identical to the GitHub report page:
 * `revalidate = 600` (static + ISR), the verdict is run through `enforceVerdict`
 * inside `buildReportView` so a bare "Safe" can never render, and reputation vs.
 * code/behavior panels stay structurally separate inside `ReportBody`.
 */

import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { buildReportView, logColor } from "@/lib/report-view";
import { fetchLatestReport } from "@/lib/report-fetch";
import { safeJsonLd } from "@/lib/json-ld";
import { ReportBody } from "@/components/spa/components/ReportBody";
import { RabbitMark } from "@/components/spa/components/glyphs";
import type { Report } from "@/lib/types";

/** Report pages are cacheable; revalidate the static render every 10 minutes. */
export const revalidate = 600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

/** npm reports persist under this synthetic owner. */
const NPM_OWNER = "npm";

interface RouteParams {
  params: Promise<{ pkg: string[] }>;
}

/**
 * Join the catch-all segments back into the package name:
 *   ["left-pad"]        -> "left-pad"
 *   ["@babel","core"]  -> "@babel/core"
 * A scoped package arrives as two segments because its "/" is a path separator.
 */
function packageName(segments: string[] | undefined): string {
  return (segments ?? []).join("/");
}

/**
 * Latest report for the npm package, wrapped in React's `cache` so
 * `generateMetadata` and the page component share a single DB round-trip per
 * request. The fetch + reshape is the SAME `fetchLatestReport` the GitHub route
 * uses (no SSR-vs-client drift) — only the owner is pinned to "npm". Returns null
 * on miss/error.
 */
const getLatestReport = cache(async function getLatestReport(
  pkg: string,
): Promise<Report | null> {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return null;
  }
  return fetchLatestReport(supabase, NPM_OWNER, pkg);
});

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { pkg } = await params;
  const name = packageName(pkg);
  const report = await getLatestReport(name);
  // Derive the view so the meta uses the SAME reconciled summary + enforced
  // verdict the page renders — search results stay honest and match the page.
  const view = report ? buildReportView(report) : null;

  const title = `${name} (npm) — ClaudeRabbit safety report`;
  const description = view
    ? `${view.verdict} · ${view.score}/100. ${view.summary}`.slice(0, 300)
    : `Safety report for the npm package ${name}. ClaudeRabbit reads the code and runs unknown packages in an isolated sandbox to return an honest 0–100 safety score.`;
  const url = `${SITE_URL}/npm/${name}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "ClaudeRabbit",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

/**
 * schema.org structured data for the report — a `Review` of the npm package. The
 * `itemReviewed` references the npm registry page (NOT a github.com repo): the
 * published package artifact is what was scanned, so pointing at a fabricated
 * GitHub URL would be an untrue claim. The rating is the SAME enforced score the
 * page shows, so the structured data can never advertise a verdict the on-page
 * report doesn't.
 */
function ReportJsonLd({ view }: { view: ReturnType<typeof buildReportView> }) {
  const pkg = view.name;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Review",
    name: `${pkg} (npm) — ClaudeRabbit safety report`,
    reviewBody: view.summary,
    itemReviewed: {
      "@type": "SoftwareSourceCode",
      name: pkg,
      url: `https://www.npmjs.com/package/${pkg}`,
    },
    reviewRating: {
      "@type": "Rating",
      ratingValue: view.score,
      bestRating: 100,
      worstRating: 0,
      alternateName: view.verdict,
    },
    author: { "@type": "Organization", name: "ClaudeRabbit", url: SITE_URL },
  };
  // `view.summary` (→ `ld.reviewBody`) is LLM-generated and can echo
  // attacker-influenced text (package name/README, or a sandbox-captured
  // hostname). `JSON.stringify` does NOT escape `<`/`>`, so a summary containing
  // `</script>…` would break out of this inline script and execute — stored XSS
  // on a public, SEO-indexed page. `safeJsonLd` escapes those bytes so the
  // breakout can't survive HTML tokenization, while the JSON-LD stays valid for
  // Google's parser (it decodes `<` back to `<`).
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }}
    />
  );
}

export default async function NpmReportPage({ params }: RouteParams) {
  const { pkg } = await params;
  const name = packageName(pkg);
  const report = await getLatestReport(name);

  if (!report) {
    return <NotScanned pkg={name} />;
  }

  const view = buildReportView(report);
  const clean = !view._hasRisky;

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--t2)",
        position: "relative",
        overflowX: "hidden",
      }}
    >
      <ReportJsonLd view={view} />
      <ServerNav />
      <ReportBody
        r={view}
        clean={clean}
        logsCta={<ServerLogs report={report} />}
        footer={
          <div style={{ textAlign: "center", marginTop: 32, fontSize: 12, color: "var(--t4)" }}>
            Auto-published at {SITE_URL.replace(/^https?:\/\//, "")}/npm/{view.name} · re-checked when the package changes
          </div>
        }
      />
      <ServerFooter />
    </main>
  );
}

/** Lean server nav: wordmark home link (the SPA chrome is client-only). */
function ServerNav() {
  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "18px 24px",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <Link
        href="/"
        style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}
      >
        <RabbitMark size={26} />
        <span className="serif" style={{ fontSize: 19, color: "var(--t1)", letterSpacing: "-0.01em" }}>
          ClaudeRabbit
        </span>
      </Link>
      <Link
        href="/"
        style={{
          fontSize: 13,
          color: "var(--t2)",
          textDecoration: "none",
          border: "1px solid var(--line2)",
          padding: "8px 15px",
          borderRadius: 11,
          background: "var(--s1)",
        }}
      >
        Scan a repo
      </Link>
    </nav>
  );
}

/** Inline end-to-end logs section (the SPA's logs overlay, rendered statically). */
function ServerLogs({ report }: { report: Report }) {
  if (report.logs.length === 0) return null;
  return (
    <section
      style={{
        border: "1px solid var(--line)",
        borderRadius: 20,
        padding: "26px",
        background: "var(--s1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 20 }}>
        <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
          End-to-end logs
        </span>
      </div>
      {report.logs.map((l, i) => {
        const color = logColor(l.kind);
        return (
          <div key={`${l.ch}-${i}`} style={{ marginBottom: i === report.logs.length - 1 ? 0 : 26 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 12 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}` }} />
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--t1)", letterSpacing: "-0.01em" }}>{l.ch}</span>
            </div>
            <div
              style={{
                borderLeft: "1px solid var(--line2)",
                paddingLeft: 22,
                marginLeft: 4,
                display: "flex",
                flexDirection: "column",
                gap: 9,
              }}
            >
              {l.lines.map((ln) => (
                <div
                  key={ln}
                  className="tnum"
                  style={{ display: "flex", alignItems: "flex-start", gap: 11, fontSize: 14, color: "var(--t2)", lineHeight: 1.55 }}
                >
                  <span style={{ color, flexShrink: 0 }}>›</span>
                  <span>{ln}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Lean server footer line. */
function ServerFooter() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--line)",
        padding: "26px 24px",
        textAlign: "center",
        fontSize: 12.5,
        color: "var(--t4)",
      }}
    >
      ClaudeRabbit — a free, open-source security product, protecting the open-source community from malware.
    </footer>
  );
}

/**
 * Clean "not yet scanned" state — never a dead end. Links home with the npm
 * package prefilled (`?repo=npm:<pkg>`, the explicit npm-target form) so the scan
 * box lands ready to scan it.
 */
function NotScanned({ pkg }: { pkg: string }) {
  const scanHref = `/?repo=${encodeURIComponent(`npm:${pkg}`)}`;
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--t2)",
        position: "relative",
      }}
    >
      <ServerNav />
      <div
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "120px 24px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            border: "1px solid var(--line2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 24px",
            background: "var(--s1)",
          }}
        >
          <RabbitMark size={28} />
        </div>
        <h1 className="serif" style={{ fontSize: 32, color: "var(--t1)", margin: "0 0 14px", letterSpacing: "-0.01em" }}>
          {pkg}
        </h1>
        <p style={{ fontSize: 16, color: "var(--t3)", lineHeight: 1.6, margin: "0 0 30px", textWrap: "pretty" }}>
          This npm package has not been scanned yet. Run a free safety scan to
          generate its public report — ClaudeRabbit reads the code and, when
          warranted, runs it in an isolated sandbox.
        </p>
        <Link
          href={scanHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
            background: "var(--ink)",
            color: "var(--ink-fg)",
            border: "none",
            fontSize: 14,
            fontWeight: 600,
            padding: "13px 26px",
            borderRadius: 13,
            textDecoration: "none",
            boxShadow: "inset 0 1px 0 var(--inkhi)",
          }}
        >
          Scan {pkg}
        </Link>
      </div>
      <ServerFooter />
    </main>
  );
}
