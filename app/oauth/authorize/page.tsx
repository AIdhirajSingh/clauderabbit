"use client";

/**
 * /oauth/authorize — the authorization endpoint (RFC 6749 §3.1) for the
 * remote MCP server's OAuth flow (see app/mcp/route.ts,
 * app/.well-known/oauth-authorization-server/route.ts). Runs the SAME
 * Google/email sign-in as the rest of the app (bouncing through the
 * existing `/auth/callback?next=...`), then mints a short-lived
 * authorization code via `create_oauth_code` and redirects back to the
 * MCP client's redirect_uri with it — the client then redeems the code at
 * the `oauth-token` edge function (PKCE-verified) for a real bearer token.
 *
 * Security: redirect_uri is validated against what THIS client_id actually
 * registered (create_oauth_code's own check, server-side) before any code
 * is ever issued or any redirect happens — this page never redirects
 * anywhere it wasn't told to by a real, prior Dynamic Client Registration.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { RabbitMark } from "@/components/spa/components/glyphs";
import { LoginForm } from "@/components/spa/components/LoginForm";

type Stage = "checking" | "needs-login" | "authorizing" | "error";

interface AuthParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
}

function parseParams(search: string): AuthParams | null {
  const p = new URLSearchParams(search);
  if (p.get("response_type") !== "code") return null;
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const codeChallenge = p.get("code_challenge");
  const method = p.get("code_challenge_method");
  if (!clientId || !redirectUri || !codeChallenge || method !== "S256") return null;
  return { clientId, redirectUri, codeChallenge, state: p.get("state"), resource: p.get("resource") };
}

export default function OAuthAuthorizePage() {
  const [stage, setStage] = useState<Stage>("checking");
  const [error, setError] = useState("");
  /** Informational note on the login form (e.g. "GitHub isn't available yet") — distinct from `error`, which is a real failure. */
  const [loginNote, setLoginNote] = useState("");
  const [email, setEmail] = useState("");
  const paramsRef = useRef<AuthParams | null>(null);

  useEffect(() => {
    const parsed = parseParams(window.location.search);
    paramsRef.current = parsed;
    const supabase = createClient();

    void (async () => {
      if (!parsed) {
        setStage("error");
        setError("This sign-in link is malformed or missing required parameters.");
        return;
      }
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        await authorize(parsed);
      } else {
        setStage("needs-login");
      }
    })();

    async function authorize(p: AuthParams) {
      setStage("authorizing");
      const { data, error: rpcError } = await supabase.rpc("create_oauth_code", {
        p_client_id: p.clientId,
        p_redirect_uri: p.redirectUri,
        p_code_challenge: p.codeChallenge,
        p_resource: p.resource,
      });
      if (rpcError || !data?.[0]?.code) {
        setStage("error");
        setError("Could not complete sign-in for this app. Close this tab and try again.");
        return;
      }
      const redirect = new URL(p.redirectUri);
      redirect.searchParams.set("code", data[0].code);
      if (p.state) redirect.searchParams.set("state", p.state);
      window.location.href = redirect.toString();
    }
  }, []);

  function redirectTo(): string {
    return `${window.location.origin}/auth/callback?next=${encodeURIComponent(
      `/oauth/authorize${window.location.search}`,
    )}`;
  }

  function withGitHub() {
    setLoginNote("GitHub sign-in isn't available yet — use Google or email below.");
  }

  async function withGoogle() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } });
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
      setLoginNote("Check your email for the sign-in link.");
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <nav style={{ display: "flex", alignItems: "center", padding: "18px 24px", borderBottom: "1px solid var(--line)" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <RabbitMark size={26} />
          <span className="serif" style={{ fontSize: 19, color: "var(--t1)", letterSpacing: "-0.01em" }}>
            ClaudeRabbit
          </span>
        </Link>
      </nav>

      {stage === "needs-login" ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <LoginForm
            onGithub={withGitHub}
            onGoogle={() => void withGoogle()}
            email={email}
            onEmailChange={setEmail}
            onEmailSubmit={() => void withEmail()}
            note={error || loginNote || undefined}
            noteColor={error ? "var(--red)" : "var(--t4)"}
          />
        </div>
      ) : (
      <div
        style={{
          maxWidth: 420,
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

        {stage === "checking" && <p style={{ fontSize: 15, color: "var(--t3)" }}>Checking your session…</p>}
        {stage === "authorizing" && <p style={{ fontSize: 15, color: "var(--t3)" }}>Connecting…</p>}
        {stage === "error" && (
          <>
            <h1 className="serif" style={{ fontSize: 28, color: "var(--t1)", margin: 0 }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: 15, color: "var(--t3)", lineHeight: 1.6 }}>{error}</p>
          </>
        )}
      </div>
      )}
    </main>
  );
}
