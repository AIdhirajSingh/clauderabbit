"use client";

/**
 * Profile — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~921–969: the gradient avatar + view/edit name, the two impact stats,
 * today's limits, and the destructive sign-out. Editing the name is wired to
 * the brain's editDraft/saveName/cancelName.
 */

import { useApp } from "../state";
import styles from "../spa.module.css";

export function ProfileScreen() {
  const app = useApp();
  const { state } = app;
  const profileInitial = (state.profileName || "?").slice(0, 1).toUpperCase();

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "60px 32px 80px", animation: "riseIn .5s var(--ease) both" }}>
      <h1 className="serif" style={{ fontSize: 40, margin: "0 0 30px", color: "var(--t1)", lineHeight: 1, letterSpacing: "-0.01em" }}>
        Profile
      </h1>

      <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 34 }}>
        <div
          style={{
            width: 68,
            height: 68,
            borderRadius: "50%",
            background: "linear-gradient(135deg, oklch(0.58 0.16 25), oklch(0.52 0.15 320))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 28,
            fontWeight: 600,
            color: "#fff",
            flexShrink: 0,
          }}
        >
          {profileInitial}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {state.editName ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                value={state.editDraft}
                onChange={app.onEditName}
                style={{
                  flex: 1,
                  background: "var(--paper)",
                  border: "1px solid var(--line3)",
                  borderRadius: 10,
                  padding: "10px 13px",
                  color: "var(--t1)",
                  fontSize: 15,
                  outline: "none",
                  minWidth: 0,
                }}
              />
              <button
                onClick={app.saveName}
                className={styles.profileSaveBtn}
                style={{
                  background: "var(--ink)",
                  color: "var(--ink-fg)",
                  border: "none",
                  fontSize: 13,
                  fontWeight: 600,
                  padding: "10px 15px",
                  borderRadius: 10,
                  cursor: "pointer",
                  transition: "transform .14s var(--ease)",
                }}
              >
                Save
              </button>
              <button
                onClick={app.cancelName}
                style={{
                  background: "transparent",
                  color: "var(--t3)",
                  border: "1px solid var(--line2)",
                  fontSize: 13,
                  padding: "10px 13px",
                  borderRadius: 10,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ minWidth: 0 }}>
                <div className="serif" style={{ fontSize: 24, color: "var(--t1)", lineHeight: 1.1 }}>
                  {state.profileName}
                </div>
                <div style={{ fontSize: 13, color: "var(--t4)", marginTop: 3 }}>{state.profileEmail}</div>
              </div>
              <button
                onClick={app.startEditName}
                className={styles.profileEditBtn}
                style={{
                  background: "var(--s1)",
                  border: "1px solid var(--line2)",
                  color: "var(--t3)",
                  fontSize: 12.5,
                  padding: "8px 14px",
                  borderRadius: 10,
                  cursor: "pointer",
                  transition: "all .16s var(--ease)",
                }}
              >
                Edit
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
        <div style={{ border: "1px solid var(--line)", borderRadius: 18, padding: 24, background: "var(--s1)" }}>
          <div className="serif tnum" style={{ fontSize: 34, color: "var(--t1)", lineHeight: 1 }}>
            {app.scannedCount}
          </div>
          <div style={{ fontSize: 13, color: "var(--t4)", marginTop: 7 }}>repos scanned</div>
        </div>
        <div style={{ border: "1px solid var(--line)", borderRadius: 18, padding: 24, background: "var(--s1)" }}>
          <div className="serif tnum" style={{ fontSize: 34, color: "var(--green)", lineHeight: 1 }}>
            {app.protectedCount}
          </div>
          <div style={{ fontSize: 13, color: "var(--t4)", marginTop: 7 }}>dangerous repos avoided</div>
        </div>
      </div>

      <div style={{ border: "1px solid var(--line)", borderRadius: 18, padding: "20px 22px", marginBottom: 30, background: "var(--s1)" }}>
        <div style={{ fontSize: 11.5, color: "var(--t4)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 16 }}>
          Today&apos;s limits
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 13.5, color: "var(--t2)" }}>Standard scans</span>
          <span className="tnum" style={{ fontSize: 13.5, color: "var(--t1)", fontWeight: 500 }}>
            {state.stage1Used} / 3
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13.5, color: "var(--t2)" }}>Sandbox runs</span>
          <span className="tnum" style={{ fontSize: 13.5, color: "var(--t1)", fontWeight: 500 }}>
            {state.dynamicUsed} / 1
          </span>
        </div>
      </div>

      <button
        onClick={app.logout}
        className={styles.logoutBtn}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: "transparent",
          border: "1px solid oklch(0.645 0.205 23 / 0.4)",
          color: "oklch(0.72 0.18 25)",
          fontSize: 13.5,
          fontWeight: 500,
          padding: "12px 20px",
          borderRadius: 13,
          cursor: "pointer",
          transition: "background .16s var(--ease), border-color .16s, transform .14s",
        }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 14H3V2h3M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Sign out
      </button>
    </div>
  );
}
