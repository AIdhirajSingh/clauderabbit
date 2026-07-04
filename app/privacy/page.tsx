/**
 * Privacy Policy — a real, reachable page (required before Google OAuth brand
 * verification). Scoped to what Claude Rabbit actually collects: the product
 * is free and no-login-required, so most visitors hand over nothing at all.
 * Facts here are sourced from the real schema (supabase/migrations) and the
 * real auth flow (app/auth/callback), not invented boilerplate.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { RabbitMark } from "@/components/spa/components/glyphs";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";
const REPO_ISSUES_URL = "https://github.com/AIdhirajSingh/clauderabbit/issues";

export const metadata: Metadata = {
  title: "Privacy Policy — Claude Rabbit",
  description: "What Claude Rabbit collects, why, and what it never does with your data.",
  alternates: { canonical: `${siteUrl}/privacy` },
};

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 19, fontWeight: 600, color: "var(--t1)", margin: "40px 0 12px", letterSpacing: "-0.01em" }}>
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 15, color: "var(--t2)", lineHeight: 1.7, margin: "0 0 14px" }}>{children}</p>;
}

export default function PrivacyPolicy() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 24px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <RabbitMark size={26} />
          <span className="serif" style={{ fontSize: 19, color: "var(--t1)", letterSpacing: "-0.01em" }}>
            Claude Rabbit
          </span>
        </Link>
      </nav>

      <article style={{ maxWidth: 680, margin: "0 auto", padding: "64px 24px 96px" }}>
        <h1 className="serif" style={{ fontSize: 44, color: "var(--t1)", margin: "0 0 8px", letterSpacing: "-0.015em" }}>
          Privacy Policy
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--t4)", margin: "0 0 32px" }}>Last updated July 4, 2026</p>

        <P>
          Claude Rabbit is a free, no-login-required tool: paste a public GitHub repo and get back a safety score.
          You can use the entire product — scanning, reports, the CLI, the MCP server — without ever creating an
          account. This page covers what we collect on the rare path where you do sign in, and what little else we
          collect for everyone.
        </P>

        <H2>If you don&apos;t sign in</H2>
        <P>
          We don&apos;t collect anything that identifies you. To stop abuse (e.g. someone hammering the scan
          endpoint), we generate a short-lived, hashed device identifier tied to your browser session purely to
          count requests against a burst rate limit. It isn&apos;t linked to a name, an email, or any profile, and
          it isn&apos;t used to track you across sessions or sites.
        </P>

        <H2>If you sign in with Google or email</H2>
        <P>Signing in is optional and only exists to save your scan history across visits. If you do, we store:</P>
        <ul style={{ fontSize: 15, color: "var(--t2)", lineHeight: 1.7, margin: "0 0 14px", paddingLeft: 20 }}>
          <li>Your name and email address, from your Google profile or the email you sign in with.</li>
          <li>A generated placeholder avatar seed — not a photo, and we don&apos;t request or store one.</li>
          <li>
            Your scan history: which repos you scanned, when, and the resulting score, so your dashboard can show
            it back to you.
          </li>
        </ul>
        <P>
          That&apos;s the complete list. We don&apos;t collect payment details (the product is free), device
          fingerprints beyond the anonymous rate-limit ID above, or any analytics profile tied to your identity.
        </P>

        <H2>What we never do</H2>
        <P>
          We never sell your data, and we never share it with third parties for their own marketing or advertising
          purposes. Full stop.
        </P>

        <H2>Who processes it on our behalf</H2>
        <P>
          Running Claude Rabbit requires a small number of infrastructure providers acting strictly on our
          instructions, never on their own:
        </P>
        <ul style={{ fontSize: 15, color: "var(--t2)", lineHeight: 1.7, margin: "0 0 14px", paddingLeft: 20 }}>
          <li><strong>Supabase</strong> — hosts our database, authentication, and edge functions.</li>
          <li><strong>Google</strong> — provides Google Sign-In if you choose that login method.</li>
          <li>
            <strong>Google Cloud (Vertex AI)</strong> — powers the model that reads and scores the public repo
            code you ask us to scan. It does not process your account profile.
          </li>
        </ul>

        <H2>Public scan reports</H2>
        <P>
          A scan report itself (the repo&apos;s score, findings, and evidence) is about public GitHub code and is
          published permanently at <code>/owner/repo</code> by design — that&apos;s the product. Your account
          identity is never attached to a public report; your own scan history is visible only to you, behind
          login.
        </P>

        <H2>Retention and deletion</H2>
        <P>
          Your account data lives until you ask us to remove it. Open an issue on{" "}
          <a href={REPO_ISSUES_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--t1)" }}>
            our GitHub repo
          </a>{" "}
          from the email on file and we&apos;ll delete your profile and scan history. You can sign out at any time
          from the account menu.
        </P>

        <H2>Cookies</H2>
        <P>
          We use one functional cookie set by Supabase Auth to keep you signed in. We don&apos;t use advertising or
          third-party tracking cookies today. If that changes, we&apos;ll update this policy first — see our{" "}
          <Link href="/terms" style={{ color: "var(--t1)" }}>
            Terms of Service
          </Link>{" "}
          for the advertising clause.
        </P>

        <H2>Children&apos;s privacy</H2>
        <P>Claude Rabbit is not directed at children under 13, and we don&apos;t knowingly collect their data.</P>

        <H2>Changes to this policy</H2>
        <P>
          If this policy changes, we&apos;ll update the date at the top of this page. Material changes will be
          reflected here before they take effect.
        </P>

        <H2>Contact</H2>
        <P>
          Questions about this policy? Open an issue on{" "}
          <a href={REPO_ISSUES_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--t1)" }}>
            GitHub
          </a>
          .
        </P>
      </article>
    </main>
  );
}
