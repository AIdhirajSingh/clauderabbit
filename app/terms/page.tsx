/**
 * Terms of Service — a real, reachable page (required before Google OAuth
 * brand verification). Plain-language, scoped to what the product actually
 * does and does not promise, including the "no bare Safe" rail as a legal
 * disclaimer and the future-advertising clause CLAUDE.md requires.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { RabbitMark } from "@/components/spa/components/glyphs";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";
const REPO_URL = "https://github.com/AIdhirajSingh/clauderabbit";

export const metadata: Metadata = {
  title: "Terms of Service — ClaudeRabbit",
  description: "The terms that govern using ClaudeRabbit's free repo-scanning service.",
  alternates: { canonical: `${siteUrl}/terms` },
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

export default function TermsOfService() {
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
            ClaudeRabbit
          </span>
        </Link>
      </nav>

      <article style={{ maxWidth: 680, margin: "0 auto", padding: "64px 24px 96px" }}>
        <h1 className="serif" style={{ fontSize: 44, color: "var(--t1)", margin: "0 0 8px", letterSpacing: "-0.015em" }}>
          Terms of Service
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--t4)", margin: "0 0 32px" }}>Last updated July 4, 2026</p>

        <P>
          By using ClaudeRabbit — the website, the CLI, or the MCP server — you agree to these terms. If you
          don&apos;t agree, don&apos;t use the service.
        </P>

        <H2>What the service is</H2>
        <P>
          ClaudeRabbit scans a public GitHub repository, npm package, or dependency you give it: it reads the
          code, checks reputation signals, and — for a share of scans — runs the code in an isolated, disposable
          sandbox to observe its real behavior. It returns a 0–100 safety score and a plain-language report,
          published permanently at a public <code>/owner/repo</code> URL.
        </P>

        <H2>Results are informational, not a guarantee</H2>
        <P>
          A ClaudeRabbit score is a best-effort signal, not a certification of safety. We never state a bare
          &quot;Safe&quot; verdict, and every report tells you plainly what was and was not verified. You are
          responsible for your own decisions about what code to run, install, or trust — ClaudeRabbit is one
          input to that decision, not a substitute for it.
        </P>

        <H2>Acceptable use</H2>
        <P>You agree not to:</P>
        <ul style={{ fontSize: 15, color: "var(--t2)", lineHeight: 1.7, margin: "0 0 14px", paddingLeft: 20 }}>
          <li>Attempt to attack, break out of, or abuse the scanning sandbox or our infrastructure.</li>
          <li>Use the service to flood, spam, or deny service to ClaudeRabbit or the repos it scans.</li>
          <li>Submit content for the purpose of harassment, or to publish a report about a repo you don&apos;t
            have the right to have scanned under applicable law.</li>
          <li>Circumvent rate limits or abuse mechanisms meant to keep the service free for everyone.</li>
        </ul>
        <P>We may suspend access for use that violates these terms.</P>

        <H2>Public, permanent reports</H2>
        <P>
          Scan reports are about public GitHub repositories and are, by design, public and permanent once
          generated — that is the product&apos;s core function (a growing, shareable database of vetted repos).
          Don&apos;t submit a repo for scanning if you don&apos;t want a public report about it to exist.
        </P>

        <H2>Accounts</H2>
        <P>
          Signing in is optional and only saves your scan history — it is never required to scan a repo or view a
          report. You&apos;re responsible for keeping your account credentials secure.
        </P>

        <H2>Advertising</H2>
        <P>
          ClaudeRabbit is currently ad-free. We may show advertising on the site in the future to help keep the
          service free and self-sustaining; if we do, these terms will be updated first and any ads will be
          clearly labeled as such.
        </P>

        <H2>Open source</H2>
        <P>
          ClaudeRabbit&apos;s source is available at{" "}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--t1)" }}>
            our GitHub repository
          </a>
          , under the license published there. These terms govern your use of the hosted service at this site,
          separately from any license terms attached to the source code itself.
        </P>

        <H2>Disclaimer of warranties</H2>
        <P>
          The service is provided &quot;as is&quot; and &quot;as available,&quot; without warranties of any kind,
          express or implied, including merchantability, fitness for a particular purpose, and non-infringement.
          We do not warrant that scans are error-free, that the sandbox will detect every malicious behavior, or
          that the service will be uninterrupted.
        </P>

        <H2>Limitation of liability</H2>
        <P>
          To the fullest extent permitted by law, ClaudeRabbit and its maintainers are not liable for any
          indirect, incidental, or consequential damages arising from your use of the service, including damages
          from running code based on a ClaudeRabbit score or report.
        </P>

        <H2>Changes</H2>
        <P>
          We may update these terms as the product evolves. We&apos;ll update the date at the top of this page
          when we do; continued use after a change means you accept the updated terms.
        </P>

        <H2>Contact</H2>
        <P>
          Questions about these terms? Open an issue on{" "}
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--t1)" }}>
            GitHub
          </a>
          .
        </P>
      </article>
    </main>
  );
}
