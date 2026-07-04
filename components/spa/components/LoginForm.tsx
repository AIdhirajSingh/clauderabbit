"use client";

/**
 * The real ClaudeRabbit sign-in form — the exact markup/copy/styling from
 * `screens/LoginScreen.tsx` (itself a faithful port of the shipped design),
 * extracted so every place that needs a login screen (the main app, the
 * standalone `/cli-auth` and `/oauth/authorize` routes for the CLI/MCP login
 * flows) renders the SAME real, branded screen rather than each hand-rolling
 * its own simplified approximation. Only the click handlers vary by caller
 * (different `redirectTo` targets); the visible form is identical.
 *
 * Google is the only OAuth option — GitHub sign-in was explicitly skipped
 * for launch (never a configured Supabase provider) and was removed
 * entirely rather than left as a disabled/graceful-failure button.
 *
 * Deliberately just the centered card — not the surrounding full-page
 * wrapper/top nav, since each caller already has its own (the main app's
 * animated full-page shell with an SPA-internal logo click; the standalone
 * `/cli-auth` and `/oauth/authorize` routes' own simpler `<nav><Link>` bar).
 */

import styles from "../spa.module.css";

export interface LoginFormProps {
  onGoogle: () => void;
  email: string;
  onEmailChange: (email: string) => void;
  onEmailSubmit: () => void;
  /** Inline note shown below the form (e.g. an error, or "check your email"). */
  note?: string;
  noteColor?: string;
}

export function LoginForm({ onGoogle, email, onEmailChange, onEmailSubmit, note, noteColor = "var(--red)" }: LoginFormProps) {
  return (
    <div style={{ width: "100%", maxWidth: 400, animation: "riseIn .6s var(--ease) both" }}>
      <h1 className="serif" style={{ fontSize: 42, margin: "0 0 12px", color: "var(--t1)", textAlign: "center", lineHeight: 1.02, letterSpacing: "-0.01em" }}>
        Save your scans.
      </h1>
      <p style={{ fontSize: 15, color: "var(--t3)", margin: "0 0 36px", textAlign: "center", lineHeight: 1.55 }}>
        Scanning is free and unlimited — no account required. Sign in only to keep your scan history and help grow the public database of vetted repositories.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        <button
          onClick={onGoogle}
          className={styles.loginPrimary}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 11,
            background: "var(--ink)",
            color: "var(--ink-fg)",
            border: "none",
            fontSize: 14.5,
            fontWeight: 600,
            padding: 14,
            borderRadius: 13,
            cursor: "pointer",
            boxShadow: "inset 0 1px 0 var(--inkhi)",
            transition: "transform .14s var(--ease)",
          }}
        >
          <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z" />
            <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z" />
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
          </svg>
          Continue with Google
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "26px 0" }}>
        <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
        <span style={{ fontSize: 12, color: "var(--t5)" }}>or</span>
        <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ fontSize: 12.5, color: "var(--t3)" }}>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEmailSubmit();
          }}
          placeholder="you@example.com"
          className={styles.loginEmail}
          style={{
            background: "var(--paper)",
            border: "1px solid var(--line2)",
            borderRadius: 13,
            padding: "14px 15px",
            color: "var(--t1)",
            fontSize: 14.5,
            outline: "none",
            transition: "border-color .18s var(--ease)",
          }}
        />
        <button
          onClick={onEmailSubmit}
          className={styles.loginEmailBtn}
          style={{
            marginTop: 5,
            background: "var(--s1)",
            color: "var(--t2)",
            border: "1px solid var(--line2)",
            fontSize: 14,
            fontWeight: 500,
            padding: 14,
            borderRadius: 13,
            cursor: "pointer",
            transition: "border-color .16s var(--ease), color .16s, transform .14s",
          }}
        >
          Continue with email
        </button>
      </div>

      {note && (
        <p style={{ fontSize: 12.5, color: noteColor, textAlign: "center", margin: "16px 0 0", lineHeight: 1.55 }}>{note}</p>
      )}

      <p style={{ fontSize: 11.5, color: "var(--t5)", textAlign: "center", margin: "26px 0 0", lineHeight: 1.55 }}>
        Free and open source. Every scan you run grows a public, permanent database of vetted repositories.
      </p>
    </div>
  );
}
