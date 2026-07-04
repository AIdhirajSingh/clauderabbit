"use client";

/**
 * Login — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~838–877: a clean, theme-aware sign-in with GitHub / Google / email
 * options. Wired to real Supabase auth: Google → OAuth, email → magic-link/OTP.
 * GitHub is not a configured provider in V1, so its button surfaces a clear
 * note rather than a fake session (CLAUDE.md: no fake data in the real flow).
 * The markup/styling is unchanged from the shipped design — only the handlers
 * and a controlled email input are added.
 *
 * The actual card markup lives in `../components/LoginForm.tsx`, shared with
 * the standalone `/cli-auth` and `/oauth/authorize` routes so the CLI/MCP
 * login flows show this exact same branded screen.
 */

import { useState } from "react";
import { onActivate, useApp } from "../state";
import { RabbitMark } from "../components/glyphs";
import { LoginForm } from "../components/LoginForm";

export function LoginScreen() {
  const app = useApp();
  const [email, setEmail] = useState("");

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", position: "relative", animation: "screenIn .5s var(--ease) both" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          height: "100%",
          pointerEvents: "none",
          opacity: 1,
          background: "radial-gradient(700px 460px at 50% -4%, rgba(255,255,255,0.045), transparent 62%)",
        }}
      />
      <div style={{ position: "relative", padding: "20px 28px" }}>
        <div {...onActivate(app.goHome)} style={{ display: "inline-flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
          <RabbitMark size={26} stroke="1.7" />
          <span style={{ fontSize: 15.5, fontWeight: 600, color: "var(--t1)" }}>ClaudeRabbit</span>
        </div>
      </div>
      <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <LoginForm
          onGithub={app.signInWithGitHub}
          onGoogle={app.signInWithGoogle}
          email={email}
          onEmailChange={setEmail}
          onEmailSubmit={() => app.signInWithEmail(email)}
        />
      </div>
    </div>
  );
}
