"use client";

/**
 * Home screen — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~218–409: floating nav, asymmetric hero (text + scan bar + suggestion
 * chips on the left, the Orbit card cluster on the right), the live activity
 * strip, the danger-board preview, the use-cases grid, and the big footer with
 * the star CTA, the Orbit conveyor, the huge wordmark, and link columns.
 */

import Link from "next/link";
import { onActivate, useApp } from "../state";
import { FOOTER_COLS } from "../state";
import styles from "../spa.module.css";
import { Orbit } from "../components/Orbit";
import { Chevron, GithubIcon, RabbitMark, StarIcon, ThemeIcon } from "../components/glyphs";

export function HomeScreen() {
  const app = useApp();
  const { state } = app;

  return (
    <div style={{ position: "relative", animation: "fadeIn .6s ease both" }}>
      {/* ambient glow placeholder (kept for structural parity) */}
      <div style={{ position: "absolute", inset: 0, height: 0, zIndex: 0, pointerEvents: "none" }} />

      {/* floating nav */}
      <div
        style={{
          position: "sticky",
          top: 22,
          zIndex: 41,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 26px",
          pointerEvents: "none",
        }}
      >
        <div
          {...onActivate(app.goHome)}
          className={styles.navWordmark}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            cursor: "pointer",
            padding: "9px 17px 9px 12px",
            border: "1px solid var(--line2)",
            borderRadius: 100,
            background: "var(--glass)",
            backdropFilter: "blur(20px) saturate(1.5)",
            boxShadow: "var(--shadow)",
            pointerEvents: "auto",
            transition: "transform .16s var(--ease), box-shadow .2s var(--ease)",
          }}
        >
          <RabbitMark size={24} stroke="1.7" />
          <span style={{ fontSize: 15.5, fontWeight: 600, letterSpacing: "-0.015em", color: "var(--t1)" }}>
            ClaudeRabbit
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 7px 7px 6px",
            border: "1px solid var(--line2)",
            borderRadius: 100,
            background: "var(--glass)",
            backdropFilter: "blur(20px) saturate(1.5)",
            boxShadow: "var(--shadow)",
            pointerEvents: "auto",
          }}
        >
          <button
            onClick={app.openLeaderboard}
            className={styles.navLinkBtn}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--t3)",
              fontSize: 13,
              fontWeight: 500,
              padding: "8px 13px",
              borderRadius: 100,
              cursor: "pointer",
              transition: "background .18s var(--ease), color .18s var(--ease)",
            }}
          >
            Danger board
          </button>
          <a
            href="https://github.com/AIdhirajSingh/clauderabbit"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.navRepoLink}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              textDecoration: "none",
              padding: "8px 13px",
              borderRadius: 100,
              transition: "background .18s var(--ease)",
            }}
          >
            <GithubIcon size={14} fill="var(--t2)" />
            <span style={{ color: "var(--t2)", fontWeight: 500, fontSize: 13 }}>AIdhirajSingh/clauderabbit</span>
          </a>
          <button
            onClick={app.toggleTheme}
            className={styles.navThemeBtn}
            aria-label="Toggle theme"
            style={{
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "none",
              borderRadius: 100,
              color: "var(--t3)",
              cursor: "pointer",
              transition: "background .18s var(--ease), color .18s",
              flexShrink: 0,
            }}
          >
            <ThemeIcon isDark={app.isDark} size={15} />
          </button>
          <button
            onClick={app.goLogin}
            className={styles.navLoginBtn}
            style={{
              background: "var(--ink)",
              color: "var(--ink-fg)",
              border: "none",
              fontSize: 13.5,
              fontWeight: 600,
              padding: "9px 18px",
              borderRadius: 100,
              cursor: "pointer",
              boxShadow: "inset 0 1px 0 var(--inkhi)",
              transition: "transform .14s var(--ease)",
              flexShrink: 0,
            }}
          >
            Log in
          </button>
        </div>
      </div>

      {/* hero */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: 1280,
          margin: "0 auto",
          minHeight: "100vh",
          padding: "0 32px",
          display: "grid",
          gridTemplateColumns: "1.02fr 0.98fr",
          gap: 48,
          alignItems: "center",
        }}
      >
        <div style={{ padding: "40px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 26 }}>
            <span style={{ height: 1, width: 40, background: "linear-gradient(90deg, transparent, var(--line3))" }} />
            <span
              style={{
                fontSize: 11,
                color: "var(--t3)",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              A security product for open source
            </span>
          </div>
          <h1
            className="serif"
            style={{
              fontSize: "clamp(44px,5.6vw,82px)",
              lineHeight: 0.96,
              margin: "0 0 24px",
              color: "var(--t1)",
              letterSpacing: "-0.018em",
              textWrap: "balance",
            }}
          >
            Open source ships malware,{" "}
            <span style={{ fontStyle: "italic", color: "var(--t2)" }}>too.</span>
          </h1>
          <p
            style={{
              fontSize: "clamp(16px,1.4vw,18px)",
              color: "var(--t3)",
              lineHeight: 1.62,
              margin: "0 0 36px",
              maxWidth: 480,
            }}
          >
            ClaudeRabbit is a free, open-source security product for the developer community. Paste any public GitHub repo
            and we clone it into an isolated sandbox, run it for real, and hand back one honest safety score: what the project
            is, what it did when we ran it, and what we could not verify.
          </p>

          <div style={{ animation: "fadeIn .6s var(--ease) both" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "var(--paper)",
                backdropFilter: "blur(20px)",
                border: `1px solid ${app.inputBorder}`,
                borderRadius: 18,
                padding: "9px 9px 9px 20px",
                maxWidth: 560,
                transition: "border-color .25s var(--ease), box-shadow .25s var(--ease)",
                boxShadow: `var(--shadow), 0 0 0 ${app.inputGlow}`,
              }}
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="var(--t4)" style={{ flexShrink: 0 }} aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <input
                value={state.input}
                onChange={app.onInput}
                onKeyDown={app.onInputKey}
                onFocus={app.onFocus}
                onBlur={app.onBlur}
                aria-label="Repository URL"
                placeholder="Paste a GitHub repo, e.g. github.com/owner/repo"
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--t1)",
                  fontSize: 15.5,
                  padding: "10px 0",
                  minWidth: 0,
                }}
              />
              <button
                onClick={app.doScan}
                className={styles.inkBtn}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  background: "var(--ink)",
                  color: "var(--ink-fg)",
                  border: "none",
                  fontSize: 14.5,
                  fontWeight: 600,
                  padding: "12px 20px",
                  borderRadius: 13,
                  cursor: "pointer",
                  boxShadow: "inset 0 1px 0 var(--inkhi)",
                  transition: "transform .14s var(--ease)",
                  flexShrink: 0,
                }}
              >
                Scan
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 8h9.5M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div style={{ display: "flex", gap: 9, marginTop: 18, flexWrap: "wrap", maxWidth: 560 }}>
              {app.suggestions.map((s) => (
                <button
                  key={s.id}
                  onClick={s.onPick}
                  className={styles.chip}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: "var(--s1)",
                    border: "1px solid var(--line)",
                    color: "var(--t3)",
                    fontSize: 12.5,
                    padding: "7px 13px",
                    borderRadius: 100,
                    cursor: "pointer",
                    transition: "border-color .18s var(--ease), color .18s var(--ease), transform .14s var(--ease)",
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color, boxShadow: `0 0 7px ${s.color}` }} />
                  <span style={{ fontWeight: 450 }}>{s.label}</span>
                </button>
              ))}
            </div>
            <div style={{ marginTop: 20, fontSize: 12.5, color: "var(--t4)" }}>Free and open source. No account needed — sign in only to save your history.</div>
          </div>
        </div>

        {/* orbital card cluster */}
        <div style={{ position: "relative", height: 600 }}>
          <Orbit dur="30s" scale={0.9} />
        </div>
      </div>

      {/* danger board preview */}
      <div className="reveal" style={{ position: "relative", zIndex: 1, maxWidth: 1040, margin: "130px auto 0", padding: "0 24px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 26, gap: 20, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--red)", boxShadow: "0 0 10px var(--red)" }} />
              <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
                Lowest scores on record
              </span>
            </div>
            <h2 className="serif" style={{ fontSize: "clamp(32px,4.4vw,46px)", margin: 0, color: "var(--t1)", lineHeight: 1, letterSpacing: "-0.01em" }}>
              The danger board
            </h2>
            <p style={{ fontSize: 14.5, color: "var(--t4)", margin: "12px 0 0", maxWidth: 440, lineHeight: 1.55 }}>
              The lowest-scoring repositories we&rsquo;ve flagged, named and ranked as they change.
            </p>
          </div>
          <button
            onClick={app.openLeaderboard}
            className={styles.boardCta}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--s2)",
              border: "1px solid var(--line2)",
              color: "var(--t2)",
              fontSize: 13,
              fontWeight: 500,
              padding: "11px 17px",
              borderRadius: 12,
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "border-color .18s var(--ease), background .18s var(--ease), transform .14s var(--ease)",
            }}
          >
            See full board
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3h7v7M13 3L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div style={{ border: "1px solid var(--line)", borderRadius: 20, overflow: "hidden", background: "var(--s1)", boxShadow: "var(--shadow-lg)" }}>
          {app.leaderTop.length === 0 && (
            <div style={{ padding: "44px 26px", textAlign: "center" }}>
              <div style={{ fontSize: 15, color: "var(--t2)", marginBottom: 8, fontWeight: 450 }}>
                Nothing caught yet.
              </div>
              <div style={{ fontSize: 13, color: "var(--t4)", lineHeight: 1.55, maxWidth: 420, margin: "0 auto" }}>
                The board lists only repos we&rsquo;ve flagged scoring low. Real catches appear here as they land.
              </div>
            </div>
          )}
          {app.leaderTop.map((r) => (
            <div
              key={r.rank}
              {...onActivate(r.onOpen)}
              className={styles.boardRow}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 20,
                padding: "17px 22px",
                borderBottom: "1px solid var(--line)",
                cursor: "pointer",
                transition: "background .16s var(--ease)",
              }}
            >
              <span className="serif tnum" style={{ fontSize: 24, color: "var(--t5)", width: 30, textAlign: "center" }}>
                {r.rank}
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 54,
                  height: 40,
                  borderRadius: 11,
                  background: r._tint,
                  border: `1px solid ${r._color}`,
                }}
              >
                <span className="serif tnum" style={{ fontSize: 23, color: r._color, lineHeight: 1 }}>
                  {r.score}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, color: "var(--t1)", marginBottom: 3, fontWeight: 450 }}>
                  {r.owner}/{r.name}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--t4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.reason}
                </div>
              </div>
              <span style={{ flexShrink: 0, color: "var(--t4)" }}>
                <Chevron size={15} />
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* what is claude rabbit */}
      <div className="reveal" style={{ position: "relative", zIndex: 1, maxWidth: 1040, margin: "140px auto 0", padding: "0 24px" }}>
        <div style={{ maxWidth: 620, marginBottom: 48 }}>
          <h2 className="serif" style={{ fontSize: "clamp(32px,4.4vw,46px)", margin: "0 0 18px", color: "var(--t1)", lineHeight: 1.02, letterSpacing: "-0.01em" }}>
            We protect the world from open-source malware.
          </h2>
          <p style={{ fontSize: 16, color: "var(--t3)", lineHeight: 1.65, margin: 0 }}>
            ClaudeRabbit is a real security product &mdash; free and open-source &mdash; with one mission: protect the world
            from open-source malware, and grow from there toward cybersecurity more broadly. We start where the threat is most
            personal: the developers who clone and run unknown code every day. A repo or package can run hostile code the
            moment you install it, draining GitHub tokens, cloud keys, and crypto wallets before a build even finishes. More
            than 454,600 new malicious open-source packages appeared in 2025 &mdash; up 75% in a year &mdash; and the attacks
            that matter carry no CVE at all; they only exist at runtime. So we run the code: every scan clones the repo into
            a disposable, isolated sandbox, executes it, and watches what it actually does.
          </p>
          <p style={{ fontSize: 16, color: "var(--t3)", lineHeight: 1.65, margin: "18px 0 0" }}>
            It is a public good. Every scan we finish becomes a permanent public report, growing a shared, vetted-repo
            database that belongs to the whole community &mdash; never locked behind a paywall. Signing in only saves your
            history and adds to that shared record; it never buys you more.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 18 }}>
          {app.useCases.map((u) => (
            <div
              key={u.no}
              className={styles.useCard}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 18,
                padding: "28px 26px",
                background: "var(--s1)",
                transition: "border-color .22s var(--ease), transform .22s var(--ease), background .22s",
              }}
            >
              <div className="serif tnum" style={{ fontSize: 30, color: "var(--t4)", marginBottom: 16, lineHeight: 1 }}>
                {u.no}
              </div>
              <div style={{ fontSize: 17, fontWeight: 600, color: "var(--t1)", marginBottom: 9, letterSpacing: "-0.01em" }}>
                {u.title}
              </div>
              <div style={{ fontSize: 14, color: "var(--t4)", lineHeight: 1.6 }}>{u.body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* use it everywhere: MCP server + CLI */}
      <div className="reveal" style={{ position: "relative", zIndex: 1, maxWidth: 1040, margin: "140px auto 0", padding: "0 24px" }}>
        <div style={{ maxWidth: 620, marginBottom: 48 }}>
          <h2 className="serif" style={{ fontSize: "clamp(32px,4.4vw,46px)", margin: "0 0 18px", color: "var(--t1)", lineHeight: 1.02, letterSpacing: "-0.01em" }}>
            Use it everywhere you already work.
          </h2>
          <p style={{ fontSize: 16, color: "var(--t3)", lineHeight: 1.65, margin: 0 }}>
            The web report is one surface. ClaudeRabbit also ships as an MCP server and a CLI, so the same honest,
            evidence-backed verdict is one call away &mdash; from an AI coding tool or a terminal &mdash;
            without ever leaving where you already are.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 18 }}>
          {(
            [
              {
                title: "MCP server",
                body: "Give any MCP-compatible AI coding tool — Claude Code, Claude Desktop, and others — a safety check before it installs or runs anything. One cache-aware scan tool: already-scanned repos return instantly, new ones get a real scan. No API key, but a free ClaudeRabbit account is required.",
                cmds: [
                  { label: "Claude Code / Claude Desktop — local, stdio", value: "clauderabbit mcp install" },
                  {
                    label: "claude.ai — remote, via Settings → Connectors → Add custom connector",
                    value: "https://clauderabbit.in/mcp",
                  },
                ],
              },
              {
                title: "CLI",
                body: "Run the same cache-aware scan from a terminal before you install a dependency or clone a repo. Never a bare “Safe” — always the score, the verdict, and what was and wasn’t verified.",
                cmds: [{ value: "npx clauderabbit scan owner/repo" }],
              },
            ] as { title: string; body: string; cmds: { label?: string; value: string }[] }[]
          ).map((t) => (
            <div
              key={t.title}
              className={styles.useCard}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 18,
                padding: "28px 26px",
                background: "var(--s1)",
                transition: "border-color .22s var(--ease), transform .22s var(--ease), background .22s",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ fontSize: 17, fontWeight: 600, color: "var(--t1)", marginBottom: 9, letterSpacing: "-0.01em" }}>
                {t.title}
              </div>
              <div style={{ fontSize: 14, color: "var(--t4)", lineHeight: 1.6, marginBottom: 18 }}>{t.body}</div>
              <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
                {t.cmds.map((c, i) => (
                  <div key={i}>
                    {c.label && (
                      <div style={{ fontSize: 11, color: "var(--t4)", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        {c.label}
                      </div>
                    )}
                    <div
                      className="tnum"
                      style={{
                        fontSize: 13,
                        color: "var(--t2)",
                        background: "var(--s2)",
                        border: "1px solid var(--line)",
                        borderRadius: 9,
                        padding: "10px 14px",
                        overflowX: "auto",
                        whiteSpace: "pre",
                      }}
                    >
                      {c.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* footer */}
      <footer style={{ position: "relative", zIndex: 1, marginTop: 150, borderTop: "1px solid var(--line)" }}>
        <div
          className="reveal"
          style={{
            maxWidth: 1240,
            margin: "0 auto",
            padding: "88px 24px 96px",
            display: "grid",
            gridTemplateColumns: "1.05fr 0.95fr",
            gap: 56,
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 13px",
                border: "1px solid var(--line2)",
                borderRadius: 100,
                marginBottom: 24,
                background: "var(--s1)",
              }}
            >
              <StarIcon size={13} />
              <span style={{ fontSize: 12, color: "var(--t3)" }}>Free · unlimited · open source</span>
            </div>
            <h2 className="serif" style={{ fontSize: "clamp(34px,4.6vw,52px)", margin: "0 0 16px", color: "var(--t1)", lineHeight: 1.02, letterSpacing: "-0.015em" }}>
              Star it. Know before you run.
            </h2>
            <p style={{ fontSize: 16, color: "var(--t3)", margin: "0 0 30px", maxWidth: 440, lineHeight: 1.62 }}>
              We are a free, open-source security product on a mission to protect the open-source community from malware.
              Every scan grows a public database of vetted repositories &mdash; a community asset that belongs to everyone.
              If ClaudeRabbit ever stops you running the wrong thing, a star is the only thanks we ask.
            </p>
            <a
              href="https://github.com/AIdhirajSingh/clauderabbit"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.starCta}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 11,
                textDecoration: "none",
                background: "var(--ink)",
                color: "var(--ink-fg)",
                fontSize: 15,
                fontWeight: 600,
                padding: "14px 26px",
                borderRadius: 14,
                boxShadow: "inset 0 1px 0 var(--inkhi), var(--shadow)",
                transition: "transform .14s var(--ease)",
              }}
            >
              <StarIcon size={17} />
              Star on GitHub
            </a>
          </div>
          <div style={{ position: "relative", height: 520 }}>
            <Orbit dur="22s" durB="28s" scale={1} />
          </div>
        </div>

        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 24px" }}>
          <div
            className="serif"
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
              fontSize: "clamp(72px,17vw,260px)",
              lineHeight: 0.82,
              color: "var(--t1)",
              letterSpacing: "-0.03em",
              whiteSpace: "nowrap",
            }}
          >
            <span>ClaudeRabbit</span>
          </div>
        </div>

        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "56px 24px 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 32, maxWidth: 760 }}>
            {FOOTER_COLS.map((col, ci) => (
              <div key={ci} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {col.links.map((lnk) => (
                  <a
                    key={lnk.label}
                    href={lnk.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.footerLink}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      textDecoration: "none",
                      color: "var(--t3)",
                      fontSize: 14,
                      transition: "color .16s var(--ease), gap .16s var(--ease)",
                    }}
                  >
                    <span style={{ flexShrink: 0, color: "var(--t4)" }}>
                      <Chevron size={12} stroke="1.6" />
                    </span>
                    {lnk.label}
                  </a>
                ))}
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
              marginTop: 64,
              padding: "26px 0 40px",
              borderTop: "1px solid var(--line)",
              color: "var(--t5)",
              fontSize: 12.5,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              © 2026 ClaudeRabbit · A free, open-source security product, protecting the open-source community from malware.
              <Link href="/privacy" style={{ color: "var(--t5)", textDecoration: "underline" }}>
                Privacy
              </Link>
              <Link href="/terms" style={{ color: "var(--t5)", textDecoration: "underline" }}>
                Terms
              </Link>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", boxShadow: "0 0 7px var(--green)" }} />
              All systems operational
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
