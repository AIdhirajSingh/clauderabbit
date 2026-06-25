"use client";

/**
 * Danger board — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~768–835: a worst-offender hero card (giant ghost "1", 92px serif
 * score), the ranked table below, and the four-band legend. Score coloring is
 * the one shared band logic.
 */

import { onActivate, useApp } from "../state";
import styles from "../spa.module.css";
import { Chevron } from "../components/glyphs";

export function LeaderboardScreen() {
  const app = useApp();
  const hero = app.leaderHero;

  return (
    <div style={{ minHeight: "100vh", position: "relative", animation: "screenIn .5s var(--ease) both" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          height: 560,
          pointerEvents: "none",
          background: "radial-gradient(700px 360px at 50% -6%, oklch(0.645 0.205 23 / 0.1), transparent 64%)",
        }}
      />

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "15px 24px",
          backdropFilter: "blur(18px) saturate(1.4)",
          background: "var(--glass)",
          borderBottom: "1px solid var(--line)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
        }}
      >
        <button
          onClick={app.backFromLeaderboard}
          className={styles.lbBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--s1)",
            border: "1px solid var(--line2)",
            color: "var(--t2)",
            fontSize: 13,
            padding: "9px 14px",
            borderRadius: 11,
            cursor: "pointer",
            transition: "border-color .16s var(--ease), background .16s, transform .14s",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
        <span style={{ fontSize: 14, fontWeight: 500, color: "var(--t1)" }}>The danger board</span>
      </div>

      <div style={{ position: "relative", maxWidth: 920, margin: "0 auto", padding: "56px 24px 110px" }}>
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <span style={{ position: "relative", width: 8, height: 8 }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--red)" }} />
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--red)", animation: "pulseRing 2s ease-out infinite" }} />
            </span>
            <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
              Most dangerous repositories caught
            </span>
          </div>
          <h1 className="serif" style={{ fontSize: "clamp(40px,6vw,64px)", margin: "0 0 16px", color: "var(--t1)", lineHeight: 1, letterSpacing: "-0.018em" }}>
            The danger board
          </h1>
          <p style={{ fontSize: 15.5, color: "var(--t3)", lineHeight: 1.6, margin: "0 auto", maxWidth: 540 }}>
            The lowest-scoring repositories our sandbox has run and caught, re-checked as they change. Malware, named and
            ranked, so you can see exactly what we run into.
          </p>
        </div>

        {hero && (
          <div
            {...onActivate(hero.onOpen)}
            className={styles.lbHero}
            style={{
              position: "relative",
              border: `1px solid ${hero._color}`,
              borderRadius: 24,
              padding: 34,
              marginBottom: 24,
              background: hero._tint,
              overflow: "hidden",
              cursor: "pointer",
              transition: "transform .2s var(--ease), box-shadow .2s",
            }}
          >
            <div style={{ position: "absolute", top: -20, right: 6, pointerEvents: "none" }}>
              <span className="serif" style={{ fontSize: 200, color: hero._color, opacity: 0.1, lineHeight: 1 }}>
                1
              </span>
            </div>
            <div style={{ position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 11, color: hero._color, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 500 }}>
                  Worst on record
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
                <span className="serif tnum" style={{ fontSize: 92, color: hero._color, lineHeight: 0.82, textShadow: `0 0 40px ${hero._glow}` }}>
                  {hero.score}
                </span>
                <div style={{ flex: 1, minWidth: 240, paddingBottom: 8 }}>
                  <div className="serif" style={{ fontSize: 30, color: "var(--t1)", lineHeight: 1.05, marginBottom: 8 }}>
                    {hero.owner}/{hero.name}
                  </div>
                  <div style={{ fontSize: 14.5, color: "var(--t3)", lineHeight: 1.5 }}>{hero.reason}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ border: "1px solid var(--line)", borderRadius: 20, overflow: "hidden", background: "var(--s1)", boxShadow: "var(--shadow-lg)" }}>
          {app.leaderRest.map((r) => (
            <div
              key={r.rank}
              {...onActivate(r.onOpen)}
              className={styles.lbRow}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                padding: "20px 26px",
                borderBottom: "1px solid var(--line)",
                cursor: "pointer",
                transition: "background .16s var(--ease), padding-left .16s",
              }}
            >
              <span className="serif tnum" style={{ fontSize: 26, color: "var(--t5)", width: 32, textAlign: "center" }}>
                {r.rank}
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 60,
                  height: 46,
                  borderRadius: 12,
                  background: r._tint,
                  border: `1px solid ${r._color}`,
                  flexShrink: 0,
                }}
              >
                <span className="serif tnum" style={{ fontSize: 25, color: r._color, lineHeight: 1 }}>
                  {r.score}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15.5, color: "var(--t1)", marginBottom: 4, fontWeight: 450 }}>
                  {r.owner}/{r.name}
                </div>
                <div style={{ fontSize: 13, color: "var(--t4)", lineHeight: 1.45 }}>{r.reason}</div>
              </div>
              <span style={{ fontSize: 11, color: r._color, padding: "4px 10px", border: `1px solid ${r._color}`, borderRadius: 100, whiteSpace: "nowrap", flexShrink: 0 }}>
                {r._band}
              </span>
              <span style={{ flexShrink: 0, color: "var(--t5)" }}>
                <Chevron size={16} />
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 22, marginTop: 32, flexWrap: "wrap" }}>
          <LegendDot color="var(--green)" label="90+ secure" />
          <LegendDot color="var(--blue)" label="80–89 likely safe" />
          <LegendDot color="var(--amber)" label="60–79 caution" />
          <LegendDot color="var(--red)" label="under 60 dangerous" />
        </div>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
      <span style={{ fontSize: 12, color: "var(--t4)" }}>{label}</span>
    </div>
  );
}
