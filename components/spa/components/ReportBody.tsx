/**
 * Presentational report body — the shared, data-only rendering of a safety
 * report, extracted from `ReportScreen` so the SAME layout renders in the SPA
 * (client, from app state) and on the public server-rendered page
 * (`app/[owner]/[repo]/page.tsx`).
 *
 * Faithful port of `design-source/Claude Rabbit.dc.html` lines ~537–725: the
 * score ring + verdict hero, the four-stat row, the TWO structurally separate
 * signal panels (Reputation vs Code & behavior — kept distinct per CLAUDE.md),
 * per-package scoring, the final verdict + "what we could not verify" list, and
 * the logs CTA.
 *
 * This component is pure: it takes a derived `RepoView` and a few presentation
 * flags/handlers. It holds no app state and works in a Server Component (the
 * top action controls are passed in via `controls`/`logsCta` so the server page
 * can swap in links where the SPA uses buttons).
 */

import type { ReactNode } from "react";
import type { RepoView } from "@/lib/report-view";
import { RING_CIRC } from "@/lib/report-view";
import { StarIcon } from "./glyphs";

interface ReportBodyProps {
  r: RepoView;
  /** True when the report has no risky items (shows the clean-state block). */
  clean: boolean;
  /** Top sticky control bar (back / PDF / copy in the SPA; a lean bar server-side). */
  controls?: ReactNode;
  /** The "End-to-end logs" call-to-action card (a button in the SPA; a note server-side). */
  logsCta?: ReactNode;
  /** Footer line under the report. */
  footer?: ReactNode;
}

export function ReportBody({ r, clean, controls, logsCta, footer }: ReportBodyProps) {
  return (
    <div style={{ minHeight: "100vh", animation: "screenIn .5s var(--ease) both" }}>
      {controls}

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "52px 24px 130px" }}>
        {/* verdict hero */}
        <div style={{ display: "flex", gap: 48, alignItems: "center", flexWrap: "wrap", marginBottom: 30, animation: "riseIn .6s var(--ease) both" }}>
          <div style={{ position: "relative", width: 172, height: 172, flexShrink: 0 }}>
            <div
              style={{
                position: "absolute",
                inset: 18,
                borderRadius: "50%",
                background: `radial-gradient(circle, ${r._glow}, transparent 70%)`,
                filter: "blur(14px)",
                animation: "scoreGlow 3.5s ease-in-out infinite",
              }}
            />
            <svg width="172" height="172" viewBox="0 0 120 120" style={{ transform: "rotate(-90deg)", position: "relative" }} aria-hidden="true">
              <circle cx="60" cy="60" r="52" fill="none" stroke="var(--s3)" strokeWidth="6" />
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                stroke={r._color}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={RING_CIRC}
                strokeDashoffset={r._ring}
                style={{ animation: "ringDraw 1.1s var(--ease) both", filter: `drop-shadow(0 0 6px ${r._glow})` }}
              />
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <span className="serif tnum" style={{ fontSize: 62, color: r._color, lineHeight: 0.9, textShadow: `0 0 30px ${r._glow}` }}>
                {r.score}
              </span>
              <span style={{ fontSize: 11, color: "var(--t5)", marginTop: 4, letterSpacing: "0.08em" }}>OUT OF 100</span>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16, flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 14px",
                  borderRadius: 100,
                  border: `1px solid ${r._color}`,
                  background: r._tint,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: r._color, boxShadow: `0 0 8px ${r._color}` }} />
                <span style={{ fontSize: 13.5, fontWeight: 600, color: r._color }}>{r.verdict}</span>
              </span>
              <span style={{ fontSize: 13, color: "var(--t4)" }}>{r._band}</span>
              {r.cached && (
                <span style={{ fontSize: 11.5, color: "var(--t4)", padding: "5px 11px", border: "1px solid var(--line2)", borderRadius: 100 }}>
                  Cached · instant
                </span>
              )}
              {r.deep && (
                <span style={{ fontSize: 11.5, color: "var(--t2)", padding: "5px 11px", border: "1px solid var(--line3)", borderRadius: 100 }}>
                  Sandbox run
                </span>
              )}
            </div>
            <h1 className="serif" style={{ fontSize: 34, color: "var(--t1)", lineHeight: 1.04, margin: "0 0 14px", letterSpacing: "-0.01em" }}>
              {r.owner}/{r.name}
            </h1>
            <p style={{ fontSize: 16, color: "var(--t2)", lineHeight: 1.65, margin: 0, textWrap: "pretty" }}>{r.summary}</p>
          </div>
        </div>

        {/* stats row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, margin: "36px 0" }}>
          <StatCard label="Lines of code">
            <span className="serif tnum" style={{ fontSize: 26, color: "var(--t1)", lineHeight: 1 }}>
              {r.stats.loc}
            </span>
          </StatCard>
          <StatCard label="Packages">
            <span className="serif tnum" style={{ fontSize: 26, color: "var(--t1)", lineHeight: 1 }}>
              {r.stats.packages}
            </span>
          </StatCard>
          <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: 20, background: "var(--s1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <StarIcon size={11} />
              <span style={{ fontSize: 11.5, color: "var(--t4)" }}>Stars</span>
            </div>
            <div className="serif tnum" style={{ fontSize: 26, color: "var(--t1)", lineHeight: 1 }}>
              {r.stats.stars}
            </div>
          </div>
          <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: 20, background: "var(--s1)" }}>
            <div style={{ fontSize: 11.5, color: "var(--t4)", marginBottom: 8 }}>Created</div>
            <div className="tnum" style={{ fontSize: 17, color: "var(--t1)", fontWeight: 500, lineHeight: 1.2, paddingTop: 4 }}>
              {r.stats.created}
            </div>
          </div>
        </div>

        {/* two signal columns */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }}>
          {/* Reputation signals */}
          <div style={{ border: "1px solid var(--line)", borderRadius: 20, padding: 26, background: "var(--s1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 1l2 4.5L15 6l-3.5 3.2L12.5 14 8 11.5 3.5 14l1-4.8L1 6l5-.5z" stroke="var(--t4)" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <span style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Reputation signals
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 20 }}>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, oklch(0.62 0.16 25), oklch(0.55 0.15 320))",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 17,
                  fontWeight: 600,
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                {r._ownerInitial}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14.5, color: "var(--t1)", marginBottom: 2, fontWeight: 450 }}>{r.ownerHistory.name}</div>
                <div style={{ fontSize: 12, color: "var(--t4)" }}>@{r.ownerHistory.handle}</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Row label="Account age">
                <span className="tnum" style={{ fontSize: 13, color: r._ageColor, fontWeight: 500 }}>
                  {r.ownerHistory.age}
                </span>
              </Row>
              <Row label="Public repos">
                <span className="tnum" style={{ fontSize: 13, color: "var(--t1)", fontWeight: 500 }}>
                  {r.ownerHistory.repos}
                </span>
              </Row>
              <Row label="Forks">
                <span className="tnum" style={{ fontSize: 13, color: "var(--t1)", fontWeight: 500 }}>
                  {r.reputation.forks}
                </span>
              </Row>
            </div>
            <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
                <span style={{ fontSize: 12, color: "var(--t4)" }}>Community sentiment</span>
                <span className="serif tnum" style={{ fontSize: 18, color: r._color }}>
                  {r._repBar}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 4, background: "var(--s3)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    borderRadius: 4,
                    background: `linear-gradient(90deg, ${r._glow}, ${r._color})`,
                    width: `${r._repBar}%`,
                    transformOrigin: "left",
                    animation: "barGrow .8s var(--ease) both",
                  }}
                />
              </div>
              <p style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55, margin: "13px 0 0" }}>{r.reputation.sentiment}</p>
              <p style={{ fontSize: 12.5, color: "var(--t4)", lineHeight: 1.55, margin: "8px 0 0" }}>{r.ownerHistory.note}</p>
            </div>
          </div>

          {/* Code & behavior signals */}
          <div style={{ border: "1px solid var(--line)", borderRadius: 20, padding: 26, background: "var(--s1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3" stroke="var(--t4)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Code &amp; behavior signals
              </span>
            </div>
            {r._hasRisky && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {r.risky.map((x) => (
                  <div key={x.title} style={{ border: "1px solid var(--line)", borderRadius: 13, padding: 15, background: "var(--s2)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: x._sevColor, boxShadow: `0 0 7px ${x._sevColor}`, flexShrink: 0 }} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--t1)" }}>{x.title}</span>
                    </div>
                    <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
                      <span style={{ fontSize: 10.5, color: x._sevColor, padding: "3px 8px", border: `1px solid ${x._sevColor}`, borderRadius: 6, fontWeight: 500 }}>
                        {x._sevLabel}
                      </span>
                      <span style={{ fontSize: 10.5, color: "var(--t4)", padding: "3px 8px", border: "1px solid var(--line2)", borderRadius: 6 }}>
                        {x._kindLabel}
                      </span>
                    </div>
                    <p style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55, margin: 0 }}>{x.detail}</p>
                  </div>
                ))}
              </div>
            )}
            {clean && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      border: "1px solid oklch(0.80 0.14 158 / 0.5)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.2l2.2 2.3 4.8-5" stroke="var(--green)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span style={{ fontSize: 15, color: "var(--t1)", fontWeight: 500 }}>No risky items found</span>
                </div>
                <p style={{ fontSize: 13, color: "var(--t3)", lineHeight: 1.65, margin: 0 }}>
                  Static scanners returned no signatures, no install hooks, no obfuscation, and no embedded secrets. The
                  read model was confident enough that a sandbox run was not warranted.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* per-package */}
        <div style={{ border: "1px solid var(--line)", borderRadius: 20, overflow: "hidden", marginBottom: 18, background: "var(--s1)" }}>
          <div style={{ padding: "18px 26px", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Per-package scoring
            </span>
          </div>
          {r.packages.map((p) => (
            <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 18, padding: "16px 26px", borderBottom: "1px solid var(--line)" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 48,
                  height: 34,
                  borderRadius: 9,
                  border: `1px solid ${p._color}`,
                  background: p._tint,
                  flexShrink: 0,
                }}
              >
                <span className="serif tnum" style={{ fontSize: 18, color: p._color, lineHeight: 1 }}>
                  {p.score}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: "var(--t1)", marginBottom: 3, fontWeight: 450 }}>{p.name}</div>
                <div style={{ fontSize: 12.5, color: "var(--t4)", lineHeight: 1.45 }}>{p.note}</div>
              </div>
            </div>
          ))}
        </div>

        {/* final verdict */}
        <div
          style={{
            position: "relative",
            border: `1px solid ${r._color}`,
            borderRadius: 20,
            padding: 30,
            background: r._tint,
            marginBottom: 18,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: r._color, boxShadow: `0 0 8px ${r._color}` }} />
            <span style={{ fontSize: 11.5, color: "var(--t2)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Final verdict</span>
          </div>
          <p style={{ fontSize: 16.5, color: "var(--t1)", lineHeight: 1.62, margin: "0 0 20px", textWrap: "pretty" }}>{r._finalNote}</p>
          <div style={{ paddingTop: 18, borderTop: "1px solid var(--line2)" }}>
            <div style={{ fontSize: 12, color: "var(--t4)", marginBottom: 11 }}>What we could not verify</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {r._notVerified.map((nv) => (
                <div key={nv} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13.5, color: "var(--t3)", lineHeight: 1.5 }}>
                  <span style={{ color: "var(--t5)", flexShrink: 0 }}>—</span>
                  <span>{nv}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* logs cta */}
        {logsCta}

        {footer}
      </div>
    </div>
  );
}

/** A simple stat card with a muted label and a serif figure (children). */
function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: 20, background: "var(--s1)" }}>
      <div style={{ fontSize: 11.5, color: "var(--t4)", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

/** A label-left / value-right row used in the reputation panel. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 13, color: "var(--t3)" }}>{label}</span>
      {children}
    </div>
  );
}
