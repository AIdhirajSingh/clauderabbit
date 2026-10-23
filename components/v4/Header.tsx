import Link from "next/link";
import { BrandMark } from "./BrandMark";

/**
 * The v4 top bar (project/term/*.dc.html <header>): brand, the centre nav, New scan and the account button.
 * New scan links to `newScanHref` (default /app).
 */
export function Header({ newScanHref = "/app" }: { newScanHref?: string }) {
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(0,0,0,0.6)", backdropFilter: "saturate(180%) blur(20px)", WebkitBackdropFilter: "saturate(180%) blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ maxWidth: 1440, margin: "0 auto", height: 64, padding: "0 clamp(20px,3vw,40px)", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 16 }}>
        <Link href="/" aria-label="ClaudeRabbit home" style={{ justifySelf: "start", display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark size={26} glyph={17} radius={7} idPrefix="lm" />
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.03em" }}>ClaudeRabbit</span>
        </Link>
        <nav aria-label="App" className="navc">
          <Link href="/app" className="navlink">Scan</Link>
          <Link href="/app#board" className="navlink">Danger board</Link>
          <Link href="/#mcp" className="navlink">CLI and MCP</Link>
          <a href="https://github.com/AIdhirajSingh/clauderabbit" className="navlink">GitHub</a>
        </nav>
        <div style={{ justifySelf: "end", display: "flex", alignItems: "center", gap: 10 }}>
          <Link href={newScanHref} className="btn btn-p btn-sm">New scan</Link>
          <Link href="/login" aria-label="Account" style={{ width: 36, height: 36, borderRadius: "50%", background: "linear-gradient(135deg,#2A2A2A,#111)", border: "1px solid rgba(255,255,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "#A1A1A1" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0" /></svg>
          </Link>
        </div>
      </div>
    </header>
  );
}
