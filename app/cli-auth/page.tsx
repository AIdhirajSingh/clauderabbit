"use client";

/**
 * /cli-auth[?port=<local-port>] — completes login for the CLI and MCP server.
 *
 * Both run as local processes with no browser session, so they can't reuse
 * the web app's cookie-based Supabase session directly. This page is the
 * bridge: it runs the SAME Google/email sign-in as the main app (bouncing
 * through the existing `/auth/callback?next=...` route, which already
 * validates `next` stays same-origin), then — once a real session exists —
 * mints a one-time-use CLI bearer token via the `issue_cli_token` RPC.
 *
 * Two modes, both real:
 *   - `?port=<n>` — the interactive `clauderabbit login` flow. The CLI is
 *     already listening on that local port, so we redirect the browser
 *     straight there with the token; the CLI's own server receives and
 *     saves it, and this tab can close itself with zero manual steps.
 *   - no `port` — the manual/MCP path. The MCP server can't run a listener
 *     mid-tool-call, so its response is just this page's plain URL. Here we
 *     show the issued token on-screen once, with the exact command to paste
 *     it into (`clauderabbit login --token <token>`).
 *
 * Security: `port`, when present, is validated as a bare 1-65535 integer and
 * used ONLY to build a hardcoded `http://127.0.0.1:<port>/callback` target —
 * never a client-supplied URL. Accepting an arbitrary redirect target here
 * would hand any page that can open this URL a way to steal a freshly issued
 * login token via an attacker-controlled redirect.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { RabbitMark } from "@/components/spa/components/glyphs";

type Stage = "checking" | "needs-login" | "email-sent" | "issuing" | "connected" | "token-ready" | "error";

function parsePort(raw: string | null): number | null {
  if (!raw || !/^\d{1,5}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 && n <= 65535 ? n : null;
}

export default function CliAuthPage() {
  const [stage, setStage] = useState<Stage>("checking");
  const [error, setError] = useState<string>("");
  const portRef = useRef<number | null>(null);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = parsePort(params.get("port"));
    portRef.current = p;

    const supabase = createClient();
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        void issueToken(p);
      } else {
        setStage("needs-login");
      }
    });

    async function issueToken(localPort: number | null) {
      setStage("issuing");
      const { data, error: rpcError } = await supabase.rpc("issue_cli_token");
      if (rpcError || typeof data !== "string") {
        setStage("error");
        setError("Could not issue a login token. Close this tab and try again.");
        return;
      }
      if (localPort) {
        setStage("connected");
        window.location.href = `http://127.0.0.1:${localPort}/callback?token=${encodeURIComponent(data)}`;
      } else {
        setToken(data);
        setStage("token-ready");
      }
    }
  }, []);

  function redirectTo(): string {
    const next = portRef.current ? `/cli-auth?port=${portRef.current}` : "/cli-auth";
    return `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  }

  async function withGoogle() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectTo() },
    });
  }

  async function withEmail() {
    const addr = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return;
    const supabase = createClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: addr,
      options: { emailRedirectTo: redirectTo() },
    });
    if (otpError) {
      setError("Could not send the sign-in link. Try again.");
    } else {
      setStage("email-sent");
    }
  }

  const loginCommand = `clauderabbit login --token ${token}`;

  function copyCommand() {
    void navigator.clipboard.writeText(loginCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          padding: "18px 24px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <RabbitMark size={26} />
          <span className="serif" style={{ fontSize: 19, color: "var(--t1)", letterSpacing: "-0.01em" }}>
            ClaudeRabbit
          </span>
        </Link>
      </nav>

      <div
        style={{
          maxWidth: 460,
          margin: "0 auto",
          padding: "96px 24px",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
        }}
      >
        <RabbitMark size={40} />

        {stage === "checking" && (
          <p style={{ fontSize: 15, color: "var(--t3)" }}>Checking your session…</p>
        )}

        {stage === "email-sent" && (
          <>
            <h1 className="serif" style={{ fontSize: 28, color: "var(--t1)", margin: 0 }}>
              Check your email
            </h1>
            <p style={{ fontSize: 15, color: "var(--t3)", lineHeight: 1.6 }}>
              We sent a sign-in link to {email}. Open it on this device to finish connecting.
            </p>
          </>
        )}

        {stage === "issuing" && <p style={{ fontSize: 15, color: "var(--t3)" }}>Connecting…</p>}

        {stage === "connected" && (
          <>
            <h1 className="serif" style={{ fontSize: 28, color: "var(--t1)", margin: 0 }}>
              Connected
            </h1>
            <p style={{ fontSize: 15, color: "var(--t3)", lineHeight: 1.6 }}>
              Return to your terminal — you can close this tab.
            </p>
          </>
        )}

        {stage === "token-ready" && (
          <>
            <h1 className="serif" style={{ fontSize: 28, color: "var(--t1)", margin: "0 0 4px" }}>
              You&apos;re signed in
            </h1>
            <p style={{ fontSize: 15, color: "var(--t3)", lineHeight: 1.6, margin: "0 0 8px" }}>
              Run this in your terminal to connect the CLI and MCP server:
            </p>
            <div
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid var(--line2)",
                background: "var(--paper)",
                fontFamily: "monospace",
                fontSize: 12.5,
                color: "var(--t1)",
                overflowX: "auto",
              }}
            >
              <span style={{ whiteSpace: "nowrap" }}>{loginCommand}</span>
            </div>
            <button
              onClick={copyCommand}
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                border: "none",
                background: "var(--ink)",
                color: "var(--ink-fg)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {copied ? "Copied" : "Copy command"}
            </button>
            <p style={{ fontSize: 12.5, color: "var(--t4)", lineHeight: 1.6 }}>
              This token is shown once. If you lose it, come back to this page to issue a new one.
            </p>
          </>
        )}

        {stage === "error" && (
          <>
            <h1 className="serif" style={{ fontSize: 28, color: "var(--t1)", margin: 0 }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: 15, color: "var(--t3)", lineHeight: 1.6 }}>{error}</p>
          </>
        )}

        {stage === "needs-login" && (
          <>
            <h1 className="serif" style={{ fontSize: 28, color: "var(--t1)", margin: "0 0 4px" }}>
              Connect the CLI
            </h1>
            <p style={{ fontSize: 15, color: "var(--t3)", lineHeight: 1.6, margin: "0 0 8px" }}>
              Sign in to link this terminal to your ClaudeRabbit account.
            </p>
            <button
              onClick={() => void withGoogle()}
              style={{
                width: "100%",
                padding: "12px 20px",
                borderRadius: 12,
                border: "1px solid var(--line2)",
                background: "var(--paper)",
                color: "var(--t1)",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Continue with Google
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", margin: "4px 0" }}>
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
              <span style={{ fontSize: 12, color: "var(--t4)" }}>or</span>
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid var(--line2)",
                background: "var(--paper)",
                color: "var(--t1)",
                fontSize: 14,
              }}
            />
            <button
              onClick={() => void withEmail()}
              style={{
                width: "100%",
                padding: "12px 20px",
                borderRadius: 12,
                border: "none",
                background: "var(--ink)",
                color: "var(--ink-fg)",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Continue with email
            </button>
            {error && <p style={{ fontSize: 13, color: "var(--red)" }}>{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}
