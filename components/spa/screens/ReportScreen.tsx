"use client";

/**
 * Report screen — the SPA wrapper around the shared, presentational
 * `ReportBody` (`components/spa/components/ReportBody.tsx`). The body markup is
 * the faithful port of `design-source/Claude Rabbit.dc.html` lines ~537–725;
 * this file supplies the interactive chrome the SPA needs (the back control when
 * logged out, the PDF + copy-link actions, and the View-full-logs button that
 * opens the logs overlay) and renders the SAME body the public server page does.
 *
 * The two signal panels are kept visually and structurally distinct per the
 * design rule that reputation and code/behavior signals never blur together —
 * that separation lives in `ReportBody`.
 */

import { useEffect, type ReactNode } from "react";
import { isValidSlug } from "@/lib/report-fetch";
import { useApp } from "../state";
import styles from "../spa.module.css";
import { BackChevron, RabbitMark } from "../components/glyphs";
import { ReportBody } from "../components/ReportBody";

export function ReportScreen() {
  const app = useApp();
  const r = app.activeRepo;
  const { ensureActiveReport } = app;
  const activeId = app.state.activeRepoId;

  // The guard that makes this screen NEVER blank: when there is no report to
  // show (a danger-board click, a deep-link, or a rehydrated session for a repo
  // not yet in the store), load it on demand. The fresh `activeId` is passed
  // explicitly — `ensureActiveReport` must not read it from the (effect-synced,
  // possibly-stale-on-mount) state ref. Skips once a report is present.
  useEffect(() => {
    if (!r) void ensureActiveReport(activeId);
  }, [ensureActiveReport, activeId, r]);

  // No report resolved yet: render a real loading or graceful error state —
  // never `return null` (which would blank the whole app, BUG-16).
  if (!r) {
    if (app.activeReportError) {
      return <ReportUnavailable slug={activeId} onBack={app.backFromReport} />;
    }
    return <ReportLoading slug={activeId} />;
  }

  const controls = (
    <div
      data-print="hide"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "18px 24px",
        pointerEvents: "none",
      }}
    >
      <div style={{ pointerEvents: "auto" }}>
        {!app.state.loggedIn && (
          <button
            onClick={app.backFromReport}
            className={styles.reportBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--glass)",
              backdropFilter: "blur(16px)",
              border: "1px solid var(--line2)",
              color: "var(--t2)",
              fontSize: 13,
              padding: "9px 15px",
              borderRadius: 11,
              cursor: "pointer",
              boxShadow: "var(--shadow-sm)",
              transition: "transform .14s var(--ease), border-color .16s var(--ease), color .16s",
            }}
          >
            <BackChevron size={14} />
            Back
          </button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, pointerEvents: "auto" }}>
        {/* Open on GitHub — a real link-out to the scanned repo's public page, new
            tab, opener-isolated (same rel as RepoLink) so the opened page can't
            reach back via window.opener. owner/name are the CANONICAL values on the
            report row, so a redirected/renamed repo (facebook/react → react/react)
            links to the page we actually scanned, not the typed-in alias. */}
        <a
          href={`https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.exportBtn}
          aria-label={`Open ${r.owner}/${r.name} on GitHub in a new tab`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: "var(--glass)",
            backdropFilter: "blur(16px)",
            border: "1px solid var(--line2)",
            color: "var(--t3)",
            fontSize: 12.5,
            padding: "9px 14px",
            borderRadius: 11,
            cursor: "pointer",
            textDecoration: "none",
            boxShadow: "var(--shadow-sm)",
            transition: "all .16s var(--ease)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Open on GitHub
        </a>
        <button
          onClick={app.exportPDF}
          className={styles.exportBtn}
          style={{
            background: "var(--glass)",
            backdropFilter: "blur(16px)",
            border: "1px solid var(--line2)",
            color: "var(--t3)",
            fontSize: 12.5,
            padding: "9px 14px",
            borderRadius: 11,
            cursor: "pointer",
            boxShadow: "var(--shadow-sm)",
            transition: "all .16s var(--ease)",
          }}
        >
          PDF
        </button>
        <button
          onClick={app.copyLink}
          className={styles.copyBtn}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: "var(--ink)",
            color: "var(--ink-fg)",
            border: "none",
            fontSize: 12.5,
            fontWeight: 600,
            padding: "9px 15px",
            borderRadius: 11,
            cursor: "pointer",
            boxShadow: "inset 0 1px 0 var(--inkhi), var(--shadow-sm)",
            transition: "transform .14s var(--ease)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6.5 9.5l3-3M7 4l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 12l-1 1a2.8 2.8 0 0 1-4-4l1-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Copy link
        </button>
      </div>
    </div>
  );

  const logsCta = (
    <div
      data-print="hide"
      style={{
        border: "1px solid var(--line)",
        borderRadius: 20,
        padding: "24px 26px",
        background: "var(--s1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div style={{ fontSize: 15, color: "var(--t1)", marginBottom: 5, fontWeight: 500 }}>End-to-end logs</div>
        <div style={{ fontSize: 13, color: "var(--t4)" }}>Every step of this scan, from clone to verdict.</div>
      </div>
      <button
        onClick={app.openLogs}
        className={styles.viewLogsBtn}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: "var(--s2)",
          border: "1px solid var(--line2)",
          color: "var(--t1)",
          fontSize: 13.5,
          fontWeight: 500,
          padding: "11px 18px",
          borderRadius: 12,
          cursor: "pointer",
          transition: "border-color .16s var(--ease), background .16s, transform .14s",
        }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        View full logs
      </button>
    </div>
  );

  const footer = (
    <div style={{ textAlign: "center", marginTop: 32, fontSize: 12, color: "var(--t6)" }}>
      Auto-published at claude-rabbit.dev/{r.owner}/{r.name} · re-checked when the repo changes
    </div>
  );

  return (
    <ReportBody
      r={r}
      clean={app.activeRepoClean}
      controls={controls}
      logsCta={logsCta}
      footer={footer}
    />
  );
}

/** Shared centered shell for the on-demand loading / error states. */
function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        position: "relative",
        animation: "screenIn .5s var(--ease) both",
      }}
    >
      <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", maxWidth: 480 }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Loading state shown while a report opened by id (danger-board click, deep-link,
 * rehydrated session) is fetched on demand. Replaces the old `return null`, so
 * the report screen is never blank.
 */
function ReportLoading({ slug }: { slug: string | null }) {
  return (
    <CenteredState>
      <div style={{ animation: "spinSlow 1.4s linear infinite", lineHeight: 0 }}>
        <RabbitMark size={34} stroke="1.6" />
      </div>
      <h1 className="serif" style={{ fontSize: 26, color: "var(--t1)", margin: "20px 0 8px", letterSpacing: "-0.01em" }}>
        Loading this report…
      </h1>
      {slug && (
        <p className="tnum" style={{ fontSize: 14, color: "var(--t4)", margin: 0 }}>
          {slug}
        </p>
      )}
    </CenteredState>
  );
}

/**
 * Graceful "couldn't load" state — a temporary connection issue, never a
 * verdict. Offers a way back and a link to the public report page. Never blank.
 */
function ReportUnavailable({ slug, onBack }: { slug: string | null; onBack: () => void }) {
  return (
    <CenteredState>
      <RabbitMark size={32} stroke="1.6" />
      <h1 className="serif" style={{ fontSize: 28, color: "var(--t1)", margin: "20px 0 10px", letterSpacing: "-0.01em" }}>
        We couldn&rsquo;t load this report
      </h1>
      {slug && (
        <p className="tnum" style={{ fontSize: 14, color: "var(--t3)", margin: "0 0 12px" }}>
          {slug}
        </p>
      )}
      <p style={{ fontSize: 15, color: "var(--t4)", lineHeight: 1.6, margin: "0 0 26px", maxWidth: 420 }}>
        This is usually a temporary connection problem, not a verdict on the
        repository. Go back and try again.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "var(--ink)",
            color: "var(--ink-fg)",
            border: "none",
            fontSize: 14,
            fontWeight: 600,
            padding: "12px 22px",
            borderRadius: 12,
            cursor: "pointer",
            boxShadow: "inset 0 1px 0 var(--inkhi)",
          }}
        >
          Go back
        </button>
        {isValidSlug(slug) && (
          <a
            href={`/${slug}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "var(--s2)",
              color: "var(--t1)",
              border: "1px solid var(--line2)",
              fontSize: 14,
              fontWeight: 500,
              padding: "12px 22px",
              borderRadius: 12,
              textDecoration: "none",
            }}
          >
            Open report page →
          </a>
        )}
      </div>
    </CenteredState>
  );
}
