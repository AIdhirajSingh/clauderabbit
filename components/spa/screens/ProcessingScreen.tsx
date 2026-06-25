"use client";

/**
 * Processing screen — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~455–536: the failed-with-retry card, and the active chapter timeline
 * (per-chapter dot / connector line / spinner loader / check, with the phase
 * label and the staggered log lines).
 */

import { useApp } from "../state";
import styles from "../spa.module.css";
import { Loader } from "../components/Loader";

export function ProcessingScreen() {
  const app = useApp();
  const { state } = app;
  const failed = state.failed;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "72px 24px",
        animation: "screenIn .5s var(--ease) both",
      }}
    >
      <div style={{ width: "100%", maxWidth: 680 }}>
        {failed && (
          <div
            style={{
              border: "1px solid oklch(0.645 0.205 23 / 0.4)",
              borderRadius: 22,
              padding: 40,
              background: "oklch(0.645 0.205 23 / 0.05)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: "50%",
                border: "1px solid oklch(0.645 0.205 23 / 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 20px",
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 8v5M12 16.5v.5" stroke="var(--red)" strokeWidth="2" strokeLinecap="round" />
                <circle cx="12" cy="12" r="9" stroke="var(--red)" strokeWidth="1.5" />
              </svg>
            </div>
            <h2 className="serif" style={{ fontSize: 27, margin: "0 0 10px", color: "var(--t1)" }}>
              The scan couldn&apos;t complete
            </h2>
            <p style={{ fontSize: 14.5, color: "var(--t3)", margin: "0 0 6px" }}>
              The sandbox run timed out while building this repository.
            </p>
            <p style={{ fontSize: 13, color: "var(--t5)", margin: "0 0 26px" }}>
              Nothing was lost. Your attempt is saved and ready to retry.
            </p>
            <button
              onClick={app.retryScan}
              className={styles.inkBtnPress}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 9,
                background: "var(--ink)",
                color: "var(--ink-fg)",
                border: "none",
                fontSize: 14,
                fontWeight: 600,
                padding: "12px 24px",
                borderRadius: 13,
                cursor: "pointer",
                boxShadow: "inset 0 1px 0 var(--inkhi)",
                transition: "transform .14s var(--ease)",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 4v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Retry scan
            </button>
          </div>
        )}

        {!failed && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 44 }}>
              <Loader size={7} gap={5} radius={2} />
              <div>
                <div style={{ fontSize: 18, color: "var(--t1)", marginBottom: 4, fontWeight: 500, letterSpacing: "-0.01em" }}>
                  {app.procName}
                </div>
                <div style={{ fontSize: 13, color: "var(--t4)" }}>{app.procPhase} · live</div>
              </div>
            </div>

            <div style={{ position: "relative" }}>
              {app.procChapters.map((c) => (
                <div key={c.ch} style={{ display: "flex", gap: 20, paddingBottom: 2 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                    <div style={{ position: "relative", width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {c._showLoader && (
                        <>
                          <span style={{ position: "absolute", inset: -4, borderRadius: "50%", border: `1.5px solid ${c._lineColor}`, opacity: 0.25 }} />
                          <span
                            style={{
                              position: "absolute",
                              inset: -4,
                              borderRadius: "50%",
                              border: "1.5px solid transparent",
                              borderTopColor: c._lineColor,
                              animation: "spinSlow .9s linear infinite",
                            }}
                          />
                        </>
                      )}
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: "50%",
                          background: c._dotBg,
                          border: `1.5px solid ${c._dotBorder}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {c._showCheck && (
                          <svg width="8" height="8" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M2.5 6.2l2.2 2.3 4.8-5" stroke="var(--bg)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                    </div>
                    <div style={{ width: 1.5, flex: 1, minHeight: 16, background: c._lineThrough }} />
                  </div>
                  <div style={{ flex: 1, paddingBottom: 24, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: c._titleColor, letterSpacing: "-0.01em", paddingTop: 2 }}>
                      {c.ch}
                    </div>
                    {c._showLines && (
                      <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 6 }}>
                        {c.lines.map((ln, li) => (
                          <div
                            key={li}
                            className="tnum"
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 10,
                              fontSize: 13,
                              color: "var(--t3)",
                              lineHeight: 1.5,
                              animation: "logIn .4s var(--ease) both",
                            }}
                          >
                            <span style={{ color: c._lineColor, flexShrink: 0 }}>›</span>
                            <span>{ln}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "center", marginTop: 10 }}>
              <button
                onClick={app.failProcessing}
                className={styles.simFailBtn}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--t6)",
                  fontSize: 11.5,
                  cursor: "pointer",
                  transition: "color .16s var(--ease)",
                }}
              >
                Simulate failure (demo)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
