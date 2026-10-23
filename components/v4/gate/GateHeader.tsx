import Link from "next/link";
import { BrandMark } from "../BrandMark";

/** The website's top bar (Gate.dc.html <header>): brand, Platform / MCP / GitHub / MindNdata, Sign in and Start scanning. */
export function GateHeader() {
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(0,0,0,0.6)", backdropFilter: "saturate(180%) blur(20px)", WebkitBackdropFilter: "saturate(180%) blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ maxWidth: 1152, margin: "0 auto", height: 64, padding: "0 clamp(20px,3vw,40px)", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 16 }}>
        <Link href="/" aria-label="ClaudeRabbit home" style={{ justifySelf: "start", display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark size={26} glyph={17} radius={7} idPrefix="lm" />
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.03em" }}>ClaudeRabbit</span>
        </Link>
        <nav aria-label="Main" className="navc">
          <Link href="/app" className="navlink">Platform</Link>
          <a href="#mcp" className="navlink">MCP</a>
          <a href="https://github.com/AIdhirajSingh/clauderabbit" className="navlink">GitHub</a>
          <a href="https://mindndata.com" className="navlink">MindNdata</a>
        </nav>
        <div style={{ justifySelf: "end", display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/login" className="navlink" style={{ color: "#F0F0F0" }}>Sign in</Link>
          <Link href="/app" className="btn btn-s btn-sm">Start scanning</Link>
        </div>
      </div>
    </header>
  );
}
