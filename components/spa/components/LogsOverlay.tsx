"use client";

/**
 * Full-screen logs overlay — faithful port of
 * `design-source/Claude Rabbit.dc.html` lines ~727–766: a centered reading
 * column with an eyebrow, the serif summary, and per-chapter band-dotted blocks
 * of `›`-prefixed log lines. "Back to report" and the X both close it.
 */

import { useApp } from "../state";
import styles from "../spa.module.css";
import { BackChevron } from "./glyphs";

export function LogsOverlay() {
  const app = useApp();
  const r = app.activeRepo;
  if (!app.state.showLogs || !r) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        animation: "drawerIn .4s var(--drawer) both",
      }}
    >
      <div
        style={{
          position: "sticky",
          top: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 24px",
          borderBottom: "1px solid var(--line)",
          backdropFilter: "blur(18px)",
          background: "var(--glass)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={app.closeLogs}
          className={styles.logsBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--s1)",
            border: "1px solid var(--line2)",
            color: "var(--t2)",
            fontSize: 13,
            padding: "9px 14px",
            borderRadius: 11,
            cursor: "pointer",
            transition: "border-color .16s var(--ease), background .16s, transform .14s",
          }}
        >
          <BackChevron size={14} />
          Back to report
        </button>
        <div style={{ fontSize: 14, color: "var(--t3)", fontWeight: 450 }}>
          {r.owner}/{r.name}
        </div>
        <button
          onClick={app.closeLogs}
          className={styles.logsClose}
          aria-label="Close logs"
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--s1)",
            border: "1px solid var(--line2)",
            borderRadius: 11,
            color: "var(--t3)",
            cursor: "pointer",
            transition: "all .16s var(--ease)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 80px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
            <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
              Logs summary
            </span>
          </div>
          <p
            className="serif"
            style={{ fontSize: 25, color: "var(--t1)", lineHeight: 1.35, margin: "0 0 48px", textWrap: "pretty", letterSpacing: "-0.005em" }}
          >
            {r.summary}
          </p>

          {r.logs.map((l, i) => (
            <div key={i} style={{ marginBottom: 30 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 14 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: l._color, boxShadow: `0 0 8px ${l._color}` }} />
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
                {l.lines.map((ln, li) => (
                  <div
                    key={li}
                    className="tnum"
                    style={{ display: "flex", alignItems: "flex-start", gap: 11, fontSize: 14, color: "var(--t2)", lineHeight: 1.55 }}
                  >
                    <span style={{ color: l._color, flexShrink: 0 }}>›</span>
                    <span>{ln}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
