"use client";

/**
 * Dashboard — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~881–919: the default in-app panel is the scan paste screen (a tighter
 * scan bar than the home hero), the suggestion chips, the per-scan-ad note, and
 * the scan history list. The floating sidebar (rendered by AppRoot) provides
 * navigation; this panel sits inside the `.cr-root` left padding.
 */

import { onActivate, useApp } from "../state";
import styles from "../spa.module.css";
import { Chevron } from "../components/glyphs";
import { OwnerAvatar } from "../components/github";

/** Gradient for the history-row avatar fallback (matches the profile avatar hue). */
const HISTORY_AVATAR_GRADIENT =
  "linear-gradient(135deg, oklch(0.58 0.16 25), oklch(0.52 0.15 320))";

export function DashboardScreen() {
  const app = useApp();
  const { state } = app;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 32px 80px", animation: "riseIn .3s var(--ease) both" }}>
      <h1 className="serif" style={{ fontSize: 40, margin: "0 0 8px", color: "var(--t1)", lineHeight: 1, letterSpacing: "-0.01em" }}>
        Scan a repository
      </h1>
      <p style={{ fontSize: 15, color: "var(--t3)", margin: "0 0 30px" }}>
        Paste any public GitHub link. Cached repos return instantly.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          background: "var(--paper)",
          border: `1px solid ${app.inputBorder}`,
          borderRadius: 16,
          padding: "8px 8px 8px 17px",
          transition: "border-color .2s var(--ease)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="var(--t4)" style={{ flexShrink: 0 }} aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        <input
          value={state.input}
          onChange={app.onInput}
          onKeyDown={app.onInputKey}
          onFocus={app.onFocus}
          onBlur={app.onBlur}
          aria-label="Repository URL"
          placeholder="github.com/owner/repo"
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--t1)", fontSize: 15, padding: "10px 0", minWidth: 0 }}
        />
        <button
          onClick={app.doScan}
          className={styles.inkBtnPress}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            background: "var(--ink)",
            color: "var(--ink-fg)",
            border: "none",
            fontSize: 14,
            fontWeight: 600,
            padding: "12px 19px",
            borderRadius: 12,
            cursor: "pointer",
            boxShadow: "inset 0 1px 0 var(--inkhi)",
            transition: "transform .14s var(--ease)",
          }}
        >
          Scan
        </button>
      </div>
      <div style={{ display: "flex", gap: 9, marginTop: 14, flexWrap: "wrap" }}>
        {app.suggestions.map((s) => (
          <button
            key={s.id}
            onClick={s.onPick}
            className={styles.chip}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              background: "var(--s1)",
              border: "1px solid var(--line)",
              color: "var(--t3)",
              fontSize: 12,
              padding: "7px 12px",
              borderRadius: 100,
              cursor: "pointer",
              transition: "border-color .16s var(--ease), color .16s, transform .14s",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color }} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 13, fontSize: 12, color: "var(--t5)" }}>Scan as much as you like — every scan grows the public database of vetted repos.</div>

      <div style={{ marginTop: 52 }}>
        <div style={{ fontSize: 11.5, color: "var(--t4)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 16 }}>
          Scan history
        </div>
        <div style={{ border: "1px solid var(--line)", borderRadius: 18, overflow: "hidden", background: "var(--s1)" }}>
          {app.history.map((h) => (
            <div
              key={h.id}
              {...onActivate(h.onOpen)}
              className={styles.dashRow}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "16px 20px",
                borderBottom: "1px solid var(--line)",
                cursor: "pointer",
                transition: "background .15s var(--ease)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 46,
                  height: 34,
                  borderRadius: 9,
                  border: `1px solid ${h._color}`,
                  flexShrink: 0,
                }}
              >
                <span className="serif tnum" style={{ fontSize: 18, color: h._color, lineHeight: 1 }}>
                  {h.score}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                  <OwnerAvatar
                    owner={h.owner}
                    initial={(h.owner || "?").slice(0, 1).toUpperCase()}
                    size={18}
                    fontSize={9}
                    gradient={HISTORY_AVATAR_GRADIENT}
                  />
                  <span style={{ fontSize: 14, color: "var(--t1)", fontWeight: 450, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.owner}/{h.name}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--t4)" }}>{h.verdict}</div>
              </div>
              <span style={{ flexShrink: 0, color: "var(--t5)" }}>
                <Chevron size={15} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
