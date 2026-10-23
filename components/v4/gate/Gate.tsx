import type { CSSProperties } from "react";
import Link from "next/link";
import { Footer } from "../Footer";
import type { ShownReport } from "./data";
import { GateHeader } from "./GateHeader";
import { HeroScan } from "./HeroScan";
import { Surfaces } from "./Surfaces";

/**
 * The ClaudeRabbit website at `/` (Claude Design export project/term/Gate.dc.html), copy word for word.
 * Every score on it is a real stored report passed in by app/page.tsx; a missing report hides its number.
 */
export function Gate({ fixture, scoreCard, web, cli }: { fixture: ShownReport | null; scoreCard: ShownReport | null; web: ShownReport | null; cli: ShownReport | null }) {
  return (
    <div style={{ minHeight: "100vh", background: "#000" }}>
      <GateHeader />
      <main>
<section id="top" style={{ position: "relative", overflow: "hidden" }}>
<div className="wrap" style={{ paddingTop: "clamp(72px,10vw,128px)", paddingBottom: "clamp(80px,10vw,140px)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "64px" }}>
<div style={{ flex: "999 1 460px", minWidth: "0" }}>
<a href="https://github.com/AIdhirajSingh/clauderabbit" className="chip" style={{ height: "30px", padding: "0 12px", borderRadius: "999px", color: "#A1A1A1" }}>It is live, free and open source. <span aria-hidden="true">›</span></a>
<h1 className="h1 gw" style={{ marginTop: "28px" }}>ClaudeRabbit</h1>
<p className="lede" style={{ marginTop: "24px", maxWidth: "520px" }}>ClaudeRabbit is a security audit tool that scans open-source repositories and packages to protect the developer and builder community from malware.</p>
<div style={{ marginTop: "36px", display: "flex", flexWrap: "wrap", gap: "12px" }}><Link href="/app" className="btn btn-s">Start scanning</Link><a href="https://github.com/AIdhirajSingh/clauderabbit" className="btn btn-g"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 00-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.6.4-1.1.7-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 011-2.7 3.6 3.6 0 01.1-2.7s.8-.3 2.8 1a9.6 9.6 0 015 0c1.9-1.3 2.8-1 2.8-1 .4 1 .4 2 .1 2.7a3.9 3.9 0 011 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0012 2z"/></svg> View on GitHub</a></div>
</div>
<div style={{ position: "relative", flex: "1 1 420px", minWidth: "0", maxWidth: "520px" }}><HeroScan fixture={fixture} /></div>
</div>
</section>
<section className="sec"><div className="wrap">
<div style={{ textAlign: "center" }}><div className="i3 i3-globe" style={{ "--h": "62,149,255" } as CSSProperties} aria-hidden="true"><div className="i3-floor" /><div className="i3-tile"><div className="i3-plate"><svg className="i3-g" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="url(#i1)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgb(62,149,255)" }}><defs><linearGradient id="i1" gradientUnits="userSpaceOnUse" x1="8" y1="2" x2="14" y2="22"><stop offset="0" stopColor="#FFFFFF"/><stop offset=".5" stopColor="#C4C4C4"/><stop offset="1" stopColor="rgb(62,149,255)"/></linearGradient></defs><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><ellipse className="a-mer" cx="12" cy="12" rx="3.6" ry="8.5"/><path d="M5.2 7.5h13.6M5.2 16.5h13.6" opacity=".5"/></svg></div><div className="i3-gloss" /><div className="i3-sweep" /><div className="i3-rim" /></div></div><h2 className="h2" style={{ margin: "36px auto 0", maxWidth: "940px" }}><span className="gw">GitHub holds 395 million public repositories,</span> <span className="ga ga-blue">and GitHub is only one platform.</span></h2></div>
<div style={{ margin: "32px auto 0", maxWidth: "680px", display: "flex", flexDirection: "column", gap: "16px", textAlign: "center" }}><p className="lede">There is also npm, on every developer&apos;s laptop, because every piece of software is built from packages. Open source moves overnight.</p><p className="lede">A repository can get 100 thousand stars in a day, which means 100 thousand people ran it.</p></div>
<div style={{ marginTop: "64px", display: "flex", flexWrap: "wrap", gap: "32px" }}><div style={{ flex: "1 1 220px", minWidth: "0", padding: "28px 0 0", borderTop: "1px solid rgba(255,255,255,0.1)" }}><div style={{ fontSize: "clamp(40px,4.4vw,56px)", fontWeight: 500, letterSpacing: "-0.045em", lineHeight: 1 }}>395M</div><div style={{ marginTop: "10px", fontSize: "15px" }} className="dim">public repositories</div></div><div style={{ flex: "1 1 220px", minWidth: "0", padding: "28px 0 0", borderTop: "1px solid rgba(255,255,255,0.1)" }}><div style={{ fontSize: "clamp(40px,4.4vw,56px)", fontWeight: 500, letterSpacing: "-0.045em", lineHeight: 1 }}>100K</div><div style={{ marginTop: "10px", fontSize: "15px" }} className="dim">stars in a day</div></div><div style={{ flex: "1 1 220px", minWidth: "0", padding: "28px 0 0", borderTop: "1px solid rgba(255,255,255,0.1)" }}><div style={{ fontSize: "clamp(40px,4.4vw,56px)", fontWeight: 500, letterSpacing: "-0.045em", lineHeight: 1 }}>450,000</div><div style={{ marginTop: "10px", fontSize: "15px" }} className="dim">new malicious open-source packages</div></div></div>
<p className="h2 ga ga-red" style={{ marginTop: "80px", textAlign: "center" }}>Who did its security audit?</p>
</div></section>
<section className="sec"><div className="wrap" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "56px" }}>
<div style={{ flex: "999 1 480px", minWidth: "0" }}>
<div style={{ width: "112px", margin: "0 0 32px" }}><div className="i3 i3-alert" style={{ "--h": "255,92,92" } as CSSProperties} aria-hidden="true"><div className="i3-floor" /><div className="i3-tile"><div className="i3-plate"><svg className="i3-g" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="url(#i2)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgb(255,92,92)" }}><defs><linearGradient id="i2" gradientUnits="userSpaceOnUse" x1="8" y1="2" x2="14" y2="22"><stop offset="0" stopColor="#FFFFFF"/><stop offset=".5" stopColor="#C4C4C4"/><stop offset="1" stopColor="rgb(255,92,92)"/></linearGradient></defs><path d="M10.3 4.2a2 2 0 013.4 0l7.6 13.2a2 2 0 01-1.7 3H4.4a2 2 0 01-1.7-3z"/><g className="a-bang"><path d="M12 9.2v4.4"/><path d="M12 16.6h.01" strokeWidth="2.2"/></g></svg></div><div className="i3-gloss" /><div className="i3-sweep" /><div className="i3-rim" /></div></div></div><h2 className="h2" ><span className="gw">Take OpenClaw,</span> <span className="ga ga-red">one of the most viral projects on GitHub.</span></h2>
<p className="lede" style={{ marginTop: "28px", maxWidth: "560px" }}>It takes your computer&apos;s permissions and your AI API keys. It was technically invasive, with a real chance of harm, and people still ran it, trusting open source.</p>
</div>
<div className="card" style={{ flex: "1 1 340px", minWidth: "0", padding: "32px" }}>
<span className="node" style={{ borderColor: "rgba(255,149,146,0.4)" }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FF9592" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l10 18H2zM12 10v5M12 18h.01"/></svg></span>
<p style={{ margin: "24px 0 0", fontSize: "24px", lineHeight: 1.35, fontWeight: 500, letterSpacing: "-0.02em" }}>In 2025 alone, over 450,000 new malicious open-source packages appeared.</p>
</div>
</div></section>
<section id="how" className="sec"><div className="wrap">
<div style={{ textAlign: "center" }}><div className="i3 i3-box" style={{ "--h": "31,196,111" } as CSSProperties} aria-hidden="true"><div className="i3-floor" /><div className="i3-tile"><div className="i3-plate"><svg className="i3-g" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="url(#i3)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgb(31,196,111)" }}><defs><linearGradient id="i3" gradientUnits="userSpaceOnUse" x1="8" y1="2" x2="14" y2="22"><stop offset="0" stopColor="#FFFFFF"/><stop offset=".5" stopColor="#C4C4C4"/><stop offset="1" stopColor="rgb(31,196,111)"/></linearGradient></defs><path d="M12 12.6l8-4.4v8.6L12 21.2 4 16.8V8.2z"/><path d="M12 12.6v8.6"/><g className="a-lid"><path d="M4 8.2L12 3.8l8 4.4-8 4.4z"/></g></svg></div><div className="i3-gloss" /><div className="i3-sweep" /><div className="i3-rim" /></div></div><h2 className="h2" style={{ margin: "36px auto 0", maxWidth: "900px" }}><span className="gw">Paste a GitHub link</span> <span className="ga ga-green">or an npm package.</span></h2></div>
<p className="lede" style={{ margin: "28px auto 0", maxWidth: "780px", textAlign: "center" }}>ClaudeRabbit boots a fresh, disposable virtual machine, downloads the code, installs it and runs it, the same way you would. Every outbound call it makes is answered by our forge with a fake reply and recorded, so nothing real leaves the machine. Static scanners read the code in parallel. Jev, a fast decision model, answers the security questions. A deterministic formula in code turns that evidence into the score. Luna writes the report in plain English. The machine is destroyed after every scan.</p>
<div style={{ marginTop: "64px", display: "flex", flexWrap: "wrap", gap: "32px 0" }}><div style={{ flex: "1 1 150px", minWidth: "0", position: "relative" }}>
<div style={{ display: "flex", alignItems: "center", gap: "10px" }}><span className="node"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F0F0F0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/></svg></span><span aria-hidden="true" style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.12)" }} /></div>
<p style={{ margin: "16px 16px 0 0", fontSize: "15px", lineHeight: 1.45, color: "#F0F0F0" }}>Fresh, disposable virtual machine</p>
</div><div style={{ flex: "1 1 150px", minWidth: "0", position: "relative" }}>
<div style={{ display: "flex", alignItems: "center", gap: "10px" }}><span className="node"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F0F0F0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></span><span aria-hidden="true" style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.12)" }} /></div>
<p style={{ margin: "16px 16px 0 0", fontSize: "15px", lineHeight: 1.45, color: "#F0F0F0" }}>Downloads, installs and runs</p>
</div><div style={{ flex: "1 1 150px", minWidth: "0", position: "relative" }}>
<div style={{ display: "flex", alignItems: "center", gap: "10px" }}><span className="node"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F0F0F0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/></svg></span><span aria-hidden="true" style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.12)" }} /></div>
<p style={{ margin: "16px 16px 0 0", fontSize: "15px", lineHeight: 1.45, color: "#F0F0F0" }}>Our forge answers with a fake reply</p>
</div><div style={{ flex: "1 1 150px", minWidth: "0", position: "relative" }}>
<div style={{ display: "flex", alignItems: "center", gap: "10px" }}><span className="node"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F0F0F0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4"/></svg></span><span aria-hidden="true" style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.12)" }} /></div>
<p style={{ margin: "16px 16px 0 0", fontSize: "15px", lineHeight: 1.45, color: "#F0F0F0" }}>Static scanners read the code</p>
</div><div style={{ flex: "1 1 150px", minWidth: "0", position: "relative" }}>
<div style={{ display: "flex", alignItems: "center", gap: "10px" }}><span className="node"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F0F0F0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg></span><span aria-hidden="true" style={{ flex: 1, height: "1px", background: "rgba(255,255,255,0.12)" }} /></div>
<p style={{ margin: "16px 16px 0 0", fontSize: "15px", lineHeight: 1.45, color: "#F0F0F0" }}>The score, then the report</p>
</div><div style={{ flex: "1 1 150px", minWidth: "0", position: "relative" }}>
<div style={{ display: "flex", alignItems: "center", gap: "10px" }}><span className="node"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F0F0F0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></span><span aria-hidden="true" style={{ flex: 1, height: "1px", background: "transparent" }} /></div>
<p style={{ margin: "16px 16px 0 0", fontSize: "15px", lineHeight: 1.45, color: "#F0F0F0" }}>The machine is destroyed</p>
</div></div>
</div></section>
<section className="sec"><div className="wrap" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "56px" }}>
<div style={{ flex: "999 1 440px", minWidth: "0" }}>
<div style={{ width: "112px", margin: "0 0 32px" }}><div className="i3 i3-shield" style={{ "--h": "255,179,0" } as CSSProperties} aria-hidden="true"><div className="i3-floor" /><div className="i3-tile"><div className="i3-plate"><svg className="i3-g" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="url(#i4)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgb(255,179,0)" }}><defs><linearGradient id="i4" gradientUnits="userSpaceOnUse" x1="8" y1="2" x2="14" y2="22"><stop offset="0" stopColor="#FFFFFF"/><stop offset=".5" stopColor="#C4C4C4"/><stop offset="1" stopColor="rgb(255,179,0)"/></linearGradient><clipPath id="i4c"><path d="M12 2.8l7.6 2.9v5.9c0 4.6-3.2 8.3-7.6 9.6-4.4-1.3-7.6-5-7.6-9.6V5.7z"/></clipPath></defs><path d="M12 2.8l7.6 2.9v5.9c0 4.6-3.2 8.3-7.6 9.6-4.4-1.3-7.6-5-7.6-9.6V5.7z"/><path d="M8.6 12.1l2.4 2.4 4.6-4.8"/><g clipPath="url(#i4c)"><rect className="a-scan" x="3" y="0" width="18" height="1.6" rx=".8" fill="currentColor" stroke="none"/></g></svg></div><div className="i3-gloss" /><div className="i3-sweep" /><div className="i3-rim" /></div></div></div><h2 className="h2" ><span className="gw">The score is</span> <span className="ga ga-amber">well calculated.</span></h2>
<p className="lede" style={{ marginTop: "28px", maxWidth: "560px" }}>It shows the evidence behind every point it takes off, and the owner&apos;s reputation is shown separately. ClaudeRabbit never just says &quot;safe&quot;. It tells you what it ran and what it found with a proper safety score.</p>
</div>
{scoreCard && (
<div className="card" style={{ flex: "1 1 380px", minWidth: "0" }}>
<div className="card-h"><span className="mono dim" style={{ fontSize: "13px" }}>{scoreCard.slug}</span><span className={`pill ${scoreCard.pill}`}>{scoreCard.verdict}</span></div>
<div style={{ padding: "24px" }}>
<div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}><span style={{ fontSize: "64px", fontWeight: 500, letterSpacing: "-0.05em", lineHeight: 1 }}>{scoreCard.score}</span><span className="dim" style={{ fontSize: "15px" }}>/ 100</span></div>
{scoreCard.findings.length > 0 && <div className="hair" style={{ margin: "24px 0 8px" }} />}
{scoreCard.findings.map((f, i) => (
<div key={f.title} style={{ display: "flex", justifyContent: "space-between", gap: "12px", padding: "10px 0", borderBottom: i < scoreCard.findings.length - 1 ? "1px solid rgba(255,255,255,0.06)" : undefined }}><span className="mono" style={{ fontSize: "13px" }}>{f.title}</span><span className="mono" style={{ fontSize: "13px", color: f.severity === "low" ? "#FFCA16" : "#FF9592" }}>{f.severity}</span></div>
))}
</div>
</div>
)}
</div></section>
<section id="mcp" className="sec"><div className="wrap">
<div style={{ textAlign: "center" }}><div className="i3 i3-term" style={{ "--h": "156,123,255" } as CSSProperties} aria-hidden="true"><div className="i3-floor" /><div className="i3-tile"><div className="i3-plate"><svg className="i3-g" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="url(#i5)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgb(156,123,255)" }}><defs><linearGradient id="i5" gradientUnits="userSpaceOnUse" x1="8" y1="2" x2="14" y2="22"><stop offset="0" stopColor="#FFFFFF"/><stop offset=".5" stopColor="#C4C4C4"/><stop offset="1" stopColor="rgb(156,123,255)"/></linearGradient></defs><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M7.5 10l3 2.5-3 2.5"/><path className="a-cur" d="M12.5 15.5h4"/></svg></div><div className="i3-gloss" /><div className="i3-sweep" /><div className="i3-rim" /></div></div><h2 className="h2" style={{ margin: "36px auto 0", maxWidth: "940px" }}><span className="gw">It works on the web, in your terminal through the CLI,</span> <span className="ga ga-violet">and inside AI agents through MCP.</span></h2></div>
<Surfaces web={web} cli={cli} />
</div></section>
<section className="sec"><div className="wrap">
<h2 className="h2" style={{ maxWidth: "980px" }}><span className="gw">If every repository got this audit the moment it launched,</span> <span className="ga ga-cyan">developers could stop worrying about security and focus on what the product does.</span></h2>
<p className="lede" style={{ marginTop: "28px" }}>It helps the people who run code and the people who publish it.</p>
</div></section>
<section id="cost" className="sec"><div className="wrap" style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "40px 64px" }}>
<div className="ga ga-orange" style={{ flex: "1 1 320px", fontSize: "clamp(88px,13vw,168px)", fontWeight: 400, letterSpacing: "-0.06em", lineHeight: ".95" }}>$0.001</div>
<div style={{ flex: "999 1 420px", minWidth: "0", display: "flex", flexDirection: "column", gap: "16px" }}><p className="lede" style={{ color: "#F0F0F0" }}>A deep scan, with the server, the AI, the web, the sandbox and the network included, costs us about $0.001.</p><p className="lede">That is what makes it free for everyone, everywhere. ClaudeRabbit runs on programmatic advertising. All it needs is your support and awareness.</p></div>
</div></section>
<section className="sec" style={{ textAlign: "center" }}><div className="wrap">
<div style={{ marginBottom: "36px" }}><div className="i3 i3-shield" style={{ "--h": "62,149,255" } as CSSProperties} aria-hidden="true"><div className="i3-floor" /><div className="i3-tile"><div className="i3-plate"><svg className="i3-g" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="url(#i6)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgb(62,149,255)" }}><defs><linearGradient id="i6" gradientUnits="userSpaceOnUse" x1="8" y1="2" x2="14" y2="22"><stop offset="0" stopColor="#FFFFFF"/><stop offset=".5" stopColor="#C4C4C4"/><stop offset="1" stopColor="rgb(62,149,255)"/></linearGradient><clipPath id="i6c"><path d="M12 2.8l7.6 2.9v5.9c0 4.6-3.2 8.3-7.6 9.6-4.4-1.3-7.6-5-7.6-9.6V5.7z"/></clipPath></defs><path d="M12 2.8l7.6 2.9v5.9c0 4.6-3.2 8.3-7.6 9.6-4.4-1.3-7.6-5-7.6-9.6V5.7z"/><path d="M8.6 12.1l2.4 2.4 4.6-4.8"/><g clipPath="url(#i6c)"><rect className="a-scan" x="3" y="0" width="18" height="1.6" rx=".8" fill="currentColor" stroke="none"/></g></svg></div><div className="i3-gloss" /><div className="i3-sweep" /><div className="i3-rim" /></div></div></div><h2 className="h1" style={{ marginTop: "20px" }}><span className="gw">Cybersecurity</span> <span className="ga ga-blue">for builders.</span></h2>
<div style={{ marginTop: "40px", display: "flex", justifyContent: "center" }}><Link href="/app" className="btn btn-p">Start scanning</Link></div>
</div></section>
      </main>
      <Footer />
    </div>
  );
}
