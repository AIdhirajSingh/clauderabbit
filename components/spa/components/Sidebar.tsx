"use client";

/**
 * The permanent floating sidebar shown on every in-app screen when logged in.
 * Faithful port of `design-source/Claude Rabbit.dc.html` lines ~126–216:
 * the expanded 264px panel and the collapsed 72px icon rail. Width animates via
 * the `.cr-sidebar[data-collapsed]` rules in globals.css; the click-empty-area
 * collapse/expand behavior comes from `onSidebarClick`.
 */

import { useState } from "react";
import { onActivate, useApp } from "../state";
import styles from "../spa.module.css";
import { RabbitMark, ThemeIcon } from "./glyphs";

const AVATAR_GRADIENT = "linear-gradient(135deg, oklch(0.62 0.16 25), oklch(0.55 0.15 320))";
const AVATAR_SHADOW = "0 2px 8px oklch(0.55 0.15 320 / 0.4)";

/**
 * The signed-in user's avatar: their real Google/GitHub photo when present,
 * falling back to the gradient initial. The photo is a raw <img> (external OAuth
 * avatar CDNs — googleusercontent, avatars.githubusercontent — are permitted by the
 * CSP `img-src https:`; a remotePatterns allowlist for arbitrary avatar hosts would
 * be brittle). `referrerPolicy="no-referrer"` avoids leaking the app origin to the
 * CDN, and a load error falls back to the initial so a dead URL never shows a broken
 * image icon.
 */
export function Avatar({
  image,
  initial,
  size,
  fontSize,
}: {
  image: string;
  initial: string;
  size: number;
  fontSize: number;
}) {
  const [broken, setBroken] = useState(false);
  const showImg = !!image && !broken;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: showImg ? "var(--s3)" : AVATAR_GRADIENT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize,
        fontWeight: 600,
        color: "#fff",
        flexShrink: 0,
        boxShadow: AVATAR_SHADOW,
        overflow: "hidden",
      }}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element -- external OAuth avatar CDN; next/image remotePatterns for arbitrary avatar hosts is brittle
        <img
          src={image}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          style={{ width: size, height: size, objectFit: "cover", display: "block" }}
        />
      ) : (
        initial
      )}
    </div>
  );
}

export function Sidebar() {
  const app = useApp();
  const { state } = app;
  const collapsed = state.sidebarCollapsed;
  const profileInitial = (state.profileName || "?").slice(0, 1).toUpperCase();
  const navScanBg = state.screen === "dashboard" ? "var(--s3)" : "transparent";
  const navScanColor = state.screen === "dashboard" ? "var(--t1)" : "var(--t3)";
  const navProfileBg = state.screen === "profile" ? "var(--s3)" : "transparent";

  return (
    <div
      onClick={app.onSidebarClick}
      className="cr-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      title="Click empty area to collapse or expand"
      style={{
        position: "fixed",
        left: 14,
        top: 14,
        zIndex: 45,
        height: "calc(100vh - 28px)",
        borderRadius: 24,
        background: "var(--glass)",
        backdropFilter: "blur(22px) saturate(1.5)",
        border: "1px solid var(--line)",
        boxShadow: "var(--shadow)",
        display: "flex",
        flexDirection: "column",
        padding: "14px 12px",
        overflow: "hidden",
        cursor: "pointer",
      }}
    >
      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, cursor: "default" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 6px 18px" }}>
            <div
              {...onActivate(app.goDashboard)}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", minWidth: 0 }}
            >
              <RabbitMark size={23} stroke="1.8" />
              <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--t1)", whiteSpace: "nowrap" }}>
                Claude Rabbit
              </span>
            </div>
            <button
              onClick={app.toggleSidebar}
              title="Collapse sidebar"
              className={styles.sbIconBtn}
              style={{
                width: 30,
                height: 30,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                borderRadius: 9,
                color: "var(--t4)",
                cursor: "pointer",
                transition: "background .14s var(--ease), color .14s",
              }}
            >
              <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <rect x="2.4" y="3.2" width="13.2" height="11.6" rx="2.6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M7.1 3.6v10.8" stroke="currentColor" strokeWidth="1.5" />
                <path d="M12.4 6.7 10.2 9l2.2 2.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <button
              onClick={app.goDashboard}
              className={styles.sbNavBtn}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: navScanBg,
                border: "none",
                color: navScanColor,
                fontSize: 13.5,
                fontWeight: 500,
                padding: "10px 12px",
                borderRadius: 11,
                cursor: "pointer",
                textAlign: "left",
                transition: "background .14s var(--ease), color .14s",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
                <path d="M9 3.4v11.2M3.4 9h11.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              New scan
            </button>
            <button
              onClick={app.openLeaderboard}
              className={styles.sbNavBtnMuted}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "transparent",
                border: "none",
                color: "var(--t3)",
                fontSize: 13.5,
                fontWeight: 500,
                padding: "10px 12px",
                borderRadius: 11,
                cursor: "pointer",
                textAlign: "left",
                transition: "background .14s var(--ease), color .14s",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
                <path d="M4 15V8.5M9 15V3M14 15v-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              Danger board
            </button>
          </div>

          <div
            style={{
              margin: "16px 6px 6px",
              paddingTop: 15,
              borderTop: "1px solid var(--line)",
              fontSize: 11.5,
              color: "var(--t4)",
              lineHeight: 1.6,
            }}
          >
            <span className="tnum" style={{ color: "var(--t2)", fontWeight: 600 }}>
              {app.scannedCount}
            </span>{" "}
            scanned&nbsp; ·&nbsp;{" "}
            <span className="tnum" style={{ color: "var(--green)", fontWeight: 600 }}>
              {app.protectedCount}
            </span>{" "}
            dangers avoided
          </div>

          <div style={{ flex: 1, overflowY: "auto", marginTop: 6, minHeight: 0 }}>
            {app.historyGroups.map((g) => (
              <div key={g.label} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--t5)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    padding: "7px 10px 5px",
                  }}
                >
                  {g.label}
                </div>
                {g.items.map((h) => (
                  <button
                    key={h.id}
                    onClick={h.onOpen}
                    className={styles.sbHistoryBtn}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      padding: "8px 10px",
                      borderRadius: 10,
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background .14s var(--ease)",
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: h._color,
                        flexShrink: 0,
                        boxShadow: `0 0 6px ${h._color}`,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 13,
                        color: "var(--t2)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {h.owner}/{h.name}
                    </span>
                    <span className="tnum" style={{ fontSize: 11.5, color: h._color, flexShrink: 0, fontWeight: 500 }}>
                      {h.score}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 8, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
            <button
              onClick={app.goProfile}
              className={styles.sbProfileBtn}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                flex: 1,
                minWidth: 0,
                background: navProfileBg,
                border: "none",
                padding: "9px 10px",
                borderRadius: 13,
                cursor: "pointer",
                textAlign: "left",
                transition: "background .14s var(--ease)",
              }}
            >
              <Avatar image={state.profileImage} initial={profileInitial} size={34} fontSize={14} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--t1)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: 500,
                  }}
                >
                  {state.profileName}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--t4)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {state.profileEmail}
                </div>
              </div>
            </button>
            <button
              onClick={app.toggleTheme}
              title="Toggle theme"
              className={styles.sbThemeBtn}
              style={{
                width: 42,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "1px solid var(--line)",
                borderRadius: 13,
                color: "var(--t3)",
                cursor: "pointer",
                transition: "background .14s var(--ease), color .14s, border-color .14s",
              }}
            >
              <ThemeIcon isDark={app.isDark} size={16} />
            </button>
          </div>
        </div>
      )}

      {collapsed && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", height: "100%", minHeight: 0, gap: 6 }}>
          <button
            onClick={app.goDashboard}
            title="Claude Rabbit"
            className={styles.sbRailBtn}
            style={{
              width: 48,
              height: 48,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              borderRadius: 13,
              cursor: "pointer",
              transition: "background .14s var(--ease)",
            }}
          >
            <RabbitMark size={22} stroke="1.8" />
          </button>
          <button
            onClick={app.toggleSidebar}
            title="Expand sidebar"
            className={styles.sbRailBtnMuted}
            style={{
              width: 44,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              borderRadius: 11,
              color: "var(--t4)",
              cursor: "pointer",
              transition: "background .14s var(--ease), color .14s",
            }}
          >
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <rect x="2.4" y="3.2" width="13.2" height="11.6" rx="2.6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M7.1 3.6v10.8" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9.8 6.7 12 9l-2.2 2.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div style={{ width: 24, height: 1, background: "var(--line)", margin: "2px 0" }} />
          <button
            onClick={app.goDashboard}
            title="New scan"
            className={styles.sbRailBtnMuted}
            style={{
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: navScanBg,
              border: "none",
              borderRadius: 12,
              color: navScanColor,
              cursor: "pointer",
              transition: "background .14s var(--ease), color .14s, transform .14s",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M9 3.4v11.2M3.4 9h11.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={app.openLeaderboard}
            title="Danger board"
            className={styles.sbRailBtnMuted}
            style={{
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              borderRadius: 12,
              color: "var(--t3)",
              cursor: "pointer",
              transition: "background .14s var(--ease), color .14s, transform .14s",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4 15V8.5M9 15V3M14 15v-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={app.toggleTheme}
            title="Toggle theme"
            className={styles.sbRailBtnMuted}
            style={{
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              borderRadius: 12,
              color: "var(--t3)",
              cursor: "pointer",
              transition: "background .14s var(--ease), color .14s, transform .14s",
            }}
          >
            <ThemeIcon isDark={app.isDark} size={17} />
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={app.goProfile}
            title={state.profileName}
            className={styles.sbRailBtnPlain}
            style={{
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              borderRadius: "50%",
              cursor: "pointer",
              transition: "transform .14s var(--ease)",
            }}
          >
            <Avatar image={state.profileImage} initial={profileInitial} size={34} fontSize={14} />
          </button>
        </div>
      )}
    </div>
  );
}
