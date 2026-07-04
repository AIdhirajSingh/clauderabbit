/**
 * Custom 404 — replaces Next's unstyled default error page (bare "404: This
 * page could not be found." with the framework's own generic h1) with the
 * real design system, matching the nav/branding pattern already used on the
 * public report page (app/[owner]/[repo]/page.tsx).
 */
import Link from "next/link";
import { RabbitMark } from "@/components/spa/components/glyphs";

export default function NotFound() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--t2)" }}>
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
      <div
        style={{
          minHeight: "calc(100vh - 65px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
          gap: 16,
        }}
      >
        <RabbitMark size={48} />
        <h1 className="serif" style={{ fontSize: 40, color: "var(--t1)", margin: 0 }}>
          Page not found
        </h1>
        <p style={{ fontSize: 15, color: "var(--t3)", maxWidth: 420, lineHeight: 1.55, margin: 0 }}>
          Nothing lives at this address. If you were looking for a repo&apos;s safety report, paste the
          GitHub link on the homepage instead.
        </p>
        <Link
          href="/"
          style={{
            marginTop: 8,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--ink-fg)",
            background: "var(--ink)",
            textDecoration: "none",
            padding: "12px 22px",
            borderRadius: 13,
          }}
        >
          Back to ClaudeRabbit
        </Link>
      </div>
    </main>
  );
}
