/**
 * Public, server-rendered safety report — the SEO surface (PRD Task #13).
 *
 * `/[owner]/[repo]` renders the most recent report for that repo straight from
 * the live `reports` table via the anon Supabase server client (RLS exposes
 * report reads publicly). It reuses the SAME presentational `ReportBody` the SPA
 * uses, so the layout conforms to design.md and stays identical across surfaces.
 *
 * Caching: `revalidate = 600` makes the page statically cacheable for 10 minutes
 * (design.md: shared chrome is cached, per-repo content is produced fresh) —
 * Next's static + ISR gives exactly that without bespoke caching.
 *
 * Rails (CLAUDE.md): the verdict is run through `enforceVerdict` so a bare
 * "Safe" can never render; reputation and code/behavior panels stay separate
 * (that separation is structural in `ReportBody`).
 */

import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { buildReportView, logColor } from "@/lib/report-view";
import { fetchLatestReport } from "@/lib/report-fetch";
import { ReportBody } from "@/components/spa/components/ReportBody";
import { RabbitMark } from "@/components/spa/components/glyphs";
import type { Report } from "@/lib/types";

/** Report pages are cacheable; revalidate the static render every 10 minutes. */
export const revalidate = 600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

interface RouteParams {
  params: Promise<{ owner: string; repo: string }>;
}

/**
 * Latest report for (owner, repo), wrapped in React's `cache` so
 * `generateMetadata` and the page component share a single DB round-trip per
 * request. `cache` wraps a (owner, repo)-only function with the client created
 * INSIDE it; the fetch + reshape is the shared `fetchLatestReport`, byte-identical
 * to the SPA's path (no SSR-vs-client drift). Returns null on miss/error.
 */
const getLatestReport = cache(async function getLatestReport(
  owner: string,
  repo: string,
): Promise<Report | null> {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return null;
  }
  return fetchLatestReport(supabase, owner, repo);
});

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { owner, repo } = await params;
  const slug = `${owner}/${repo}`;
  const report = await getLatestReport(owner, repo);

  const title = `${slug} — Claude Rabbit safety report`;
  const description = report?.summary
    ? `${report.verdict} · ${report.score}/100. ${report.summary}`.slice(0, 300)
    : `Safety report for ${slug}. Claude Rabbit reads the code and runs unknown repos in an isolated sandbox to return an honest 0–100 safety score.`;
  const url = `${SITE_URL}/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "Claude Rabbit",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function ReportPage({ params }: RouteParams) {
  const { owner, repo } = await params;
  const report = await getLatestReport(owner, repo);

  if (!report) {
    return <NotScanned owner={owner} repo={repo} />;
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
      <ServerNav />
      <ReportBody
        r={view}
        clean={clean}
        logsCta={<ServerLogs report={report} />}
        footer={
          <div style={{ textAlign: "center", marginTop: 32, fontSize: 12, color: "var(--t6)" }}>
            Auto-published at {SITE_URL.replace(/^https?:\/\//, "")}/{view.owner}/{view.name} · re-checked when the repo changes
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
          Claude Rabbit
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
        color: "var(--t5)",
      }}
    >
      Claude Rabbit — everyone reads the code. We run it.
    </footer>
  );
}

/**
 * Clean "not yet scanned" state — never a dead end. Links home with the repo
 * prefilled (`?repo=owner/repo`) so the scan box can pick it up.
 */
function NotScanned({ owner, repo }: { owner: string; repo: string }) {
  const slug = `${owner}/${repo}`;
  const scanHref = `/?repo=${encodeURIComponent(slug)}`;
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
          {slug}
        </h1>
        <p style={{ fontSize: 16, color: "var(--t3)", lineHeight: 1.6, margin: "0 0 30px", textWrap: "pretty" }}>
          This repository has not been scanned yet. Run a free safety scan to
          generate its public report — Claude Rabbit reads the code and, when
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
          Scan {slug}
        </Link>
      </div>
      <ServerFooter />
    </main>
  );
}
