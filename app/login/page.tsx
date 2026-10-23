import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/v4/BrandMark";
import { Header } from "@/components/v4/Header";
import { GoogleButton } from "@/components/v4/login/GoogleButton";

/**
 * `/login` — sign in or sign up (Claude Design export project/term/Login.dc.html). Google only.
 * Signing in is optional: it only saves scan history, so "Not now" goes straight to /app.
 */

export const metadata: Metadata = {
  title: "Sign in to ClaudeRabbit",
  robots: { index: false, follow: true },
  alternates: { canonical: "/login" },
};

export default function LoginPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#000", display: "flex", flexDirection: "column" }}>
      <Header />
      <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 20px" }}>
        <div style={{ width: "100%", maxWidth: "380px", textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BrandMark size={48} glyph={32} radius={13} idPrefix="lg" />
          </div>
          <h1 style={{ margin: "24px 0 0", fontSize: "28px", fontWeight: 500, letterSpacing: "-0.03em" }}>Sign in or sign up</h1>
          <p className="dim" style={{ margin: "8px 0 0", fontSize: "15px" }}>Scanning works without an account.</p>
          <GoogleButton />
          <Link href="/app" className="btn btn-g btn-sm" style={{ marginTop: "8px", color: "#A1A1A1" }}>Not now</Link>
        </div>
      </main>
    </div>
  );
}
