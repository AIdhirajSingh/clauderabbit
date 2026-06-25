"use client";

import { useState } from "react";

type Theme = "light" | "dark";

/**
 * Reads the theme the no-flash script in layout.tsx already resolved onto
 * <html> before paint. Falls back to "light" during SSR (no document) and on
 * any unexpected value, keeping the toggle in sync with the rendered page.
 */
function readInitialTheme(): Theme {
  if (typeof document === "undefined") {
    return "light";
  }
  const current = document.documentElement.getAttribute("data-theme");
  return current === "dark" ? "dark" : "light";
}

/**
 * Minimal placeholder home page. This is intentionally small: it proves the
 * design system (globals.css), the Google Fonts (Geist + Instrument Serif),
 * and theme switching all work end to end. The full Home port — the 3D card
 * background, the scan box, the leaderboard, the marquees — is a later unit.
 *
 * Markup and copy here are faithful to the design's home hero
 * (`design-source/Claude Rabbit.dc.html`): the rabbit wordmark, the
 * "Everyone reads the code · we run it" eyebrow, and the
 * "Open source ships malware, too." headline.
 */
export default function HomePage() {
  // Lazy initializer reads the data-theme the no-flash script already set, so
  // the toggle starts in sync with the page without a setState-in-effect.
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("cr-theme", next);
    } catch {
      // localStorage may be unavailable (private mode / disabled); the in-memory
      // toggle still works for the session.
    }
  }

  const isDark = theme === "dark";

  return (
    <div
      className="cr-root"
      data-app="out"
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--t2)",
        position: "relative",
        overflowX: "hidden",
      }}
    >
      {/* floating nav: wordmark pill (left) + theme toggle (right) */}
      <div
        style={{
          position: "sticky",
          top: 22,
          zIndex: 41,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 26px",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 17px 9px 12px",
            border: "1px solid var(--line2)",
            borderRadius: 100,
            background: "var(--glass)",
            backdropFilter: "blur(20px) saturate(1.5)",
            boxShadow: "var(--shadow)",
            pointerEvents: "auto",
          }}
        >
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path
              d="M10.2 14.5 C8.3 9.8 8.6 4.4 10.2 4 C11.8 3.6 13.1 8 13.3 12.3"
              stroke="var(--t1)"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
            <path
              d="M21.8 14.5 C23.7 9.8 23.4 4.4 21.8 4 C20.2 3.6 18.9 8 18.7 12.3"
              stroke="var(--t1)"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
            <circle cx="16" cy="19.6" r="7" stroke="var(--t1)" strokeWidth="1.7" />
            <circle cx="16" cy="19.8" r="1.6" fill="var(--t1)" />
          </svg>
          <span
            style={{
              fontSize: 15.5,
              fontWeight: 600,
              letterSpacing: "-0.015em",
              color: "var(--t1)",
            }}
          >
            Claude Rabbit
          </span>
        </div>

        <button
          onClick={toggleTheme}
          aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
          // The icon depends on the theme the no-flash script resolved on the
          // client, which can differ from the server's default "light" render.
          // Suppress the expected one-element hydration diff for the icon.
          suppressHydrationWarning
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--glass)",
            border: "1px solid var(--line2)",
            borderRadius: 100,
            color: "var(--t3)",
            cursor: "pointer",
            boxShadow: "var(--shadow)",
            pointerEvents: "auto",
            flexShrink: 0,
          }}
        >
          {isDark ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="4.6" fill="currentColor" />
              <path
                d="M12 2.2v2.6M12 19.2v2.6M4.3 12H1.7M22.3 12h-2.6M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M21.2 13.4A7.8 7.8 0 1 1 10.5 2.8 6.2 6.2 0 0 0 21.2 13.4z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>

      {/* hero */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 1280,
          margin: "0 auto",
          minHeight: "calc(100vh - 80px)",
          padding: "0 32px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <div style={{ maxWidth: 720, padding: "40px 0" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              marginBottom: 26,
            }}
          >
            <span
              style={{
                height: 1,
                width: 40,
                background: "linear-gradient(90deg, transparent, var(--line3))",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: "var(--t3)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              Everyone reads the code · we run it
            </span>
          </div>
          <h1
            className="serif"
            style={{
              fontSize: "clamp(44px,5.6vw,82px)",
              lineHeight: 0.96,
              margin: "0 0 24px",
              color: "var(--t1)",
              letterSpacing: "-0.018em",
              textWrap: "balance",
            }}
          >
            Open source ships malware,{" "}
            <span style={{ fontStyle: "italic", color: "var(--t2)" }}>too.</span>
          </h1>
          <p
            style={{
              fontSize: "clamp(16px,1.4vw,18px)",
              color: "var(--t3)",
              lineHeight: 1.62,
              margin: "0 0 36px",
              maxWidth: 480,
            }}
          >
            Paste any GitHub repo. We clone it into an isolated sandbox, actually
            run it, and hand back one honest safety score, before it ever touches
            your machine.
          </p>
        </div>
      </div>
    </div>
  );
}
