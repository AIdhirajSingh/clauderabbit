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
import type {
  ForensicsAttemptView,
  ForensicsPayloadView,
  ForensicsView,
  RepoView,
} from "@/lib/report-view";
import { RING_CIRC } from "@/lib/report-view";
import { formatCount } from "@/lib/format";
import { StarIcon } from "./glyphs";
import { OwnerAvatar, RepoLink } from "./github";

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
    // `data-print="report"` marks the print target: the print stylesheet in
    // globals.css hides everything else and lays this out cleanly for Save-as-PDF.
    <div data-print="report" style={{ minHeight: "100vh", animation: "screenIn .5s var(--ease) both" }}>
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
              {/* The scan-path badge is keyed on whether the sandbox ACTUALLY ran
                  (a forensic record exists), never the bare `deep` flag — so a
                  queued-but-not-executed escalation never wears a "Sandbox run"
                  badge it didn't earn (BUG-2, the canary). */}
              {r._ranSandbox ? (
                <span style={{ fontSize: 11.5, color: "var(--t2)", padding: "5px 11px", border: "1px solid var(--line3)", borderRadius: 100 }}>
                  Sandbox run
                </span>
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--t4)", padding: "5px 11px", border: "1px solid var(--line2)", borderRadius: 100 }}>
                  Static read
                </span>
              )}
            </div>
            <h1 className="serif" style={{ fontSize: 34, color: "var(--t1)", lineHeight: 1.04, margin: "0 0 14px", letterSpacing: "-0.01em" }}>
              <RepoLink owner={r.owner} name={r.name}>
                {r.owner}/{r.name}
              </RepoLink>
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
              {formatCount(r.stats.packages)}
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
              <OwnerAvatar
                owner={r.owner}
                initial={r._ownerInitial}
                size={42}
                fontSize={17}
                gradient="linear-gradient(135deg, oklch(0.62 0.16 25), oklch(0.55 0.15 320))"
              />
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
                  {formatCount(r.ownerHistory.repos)}
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
                  <span style={{ fontSize: 15, color: "var(--t1)", fontWeight: 500 }}>
                    No risky items found
                  </span>
                </div>
                {/* Describe only what was found (or not) in the code itself — never
                    how the scan was performed. The Static-read/Sandbox-run badge
                    above already carries that signal (CLAUDE.md: a report must
                    never narrate or imply its own scanning methodology in prose). */}
                <p style={{ fontSize: 13, color: "var(--t3)", lineHeight: 1.65, margin: 0 }}>
                  No signatures, install hooks, obfuscation, or embedded secrets were found in the code.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* What running it revealed — the runtime evidence, woven in first-class
            right after the summary signals (U2). Only for repos the sandbox ran. */}
        {r._forensics && <ForensicSection f={r._forensics} />}

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
          {/* "What we could not verify" is for STATIC reads only. An escalated repo
              (the sandbox RAN it) has no hedge list — the list is empty and the whole
              block is hidden so no dangling heading sits over nothing (U1). */}
          {r._notVerified.length > 0 && (
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
          )}
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

// ───────────────────────── forensic section ─────────────────────────
// The evidence-backed record of what running the repo in the sandbox revealed.
// Faithful to design.md: eyebrow labels, hairline cards on faint fills, the one
// score-color logic (green/blue/amber/red), serif hero numbers, no monospace,
// and — per CLAUDE.md — strictly code/behavior + network intent (no reputation
// in here, that stays in its own panel above). Never a bare "Safe": when the
// run was dormant/unverified it says so.

/** A small uppercase eyebrow label used to title each forensic block. */
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
      {children}
    </span>
  );
}

/** A bordered forensic block (hairline card on a faint fill). */
function Block({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: 22, background: "var(--s1)", ...style }}>
      {children}
    </div>
  );
}

function ForensicSection({ f }: { f: ForensicsView }) {
  const run = f.raw.what_it_ran;
  const beh = f.raw.in_vm_behavior;
  const cont = f.raw.containment;

  return (
    // U2: the runtime evidence is woven in as a FIRST-CLASS report section — a
    // deeper member of the same family as a stage-1 report, NOT a tinted panel
    // glued on. No verdict-color tint wrapper (the verdict + summary already live
    // in the hero: one report, one verdict). The section title uses the same eyebrow
    // treatment as "Reputation signals" / "Per-package scoring"; the caught-attack
    // pulse rides the section dot. Each block below is a first-class hairline --s1
    // card in the one shared design language.
    <section aria-label="What running it revealed" style={{ marginBottom: 18, animation: "riseIn .6s var(--ease) both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ position: "relative", width: 8, height: 8 }} aria-hidden="true">
          <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: f._verdictColor, boxShadow: `0 0 8px ${f._verdictColor}` }} />
          {f._caughtAttack && (
            <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: f._verdictColor, animation: "pulseRing 2s ease-out infinite" }} />
          )}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--t3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          What running it revealed
        </span>
      </div>

      {/* what it ran — the runtime story */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ marginBottom: 12 }}>
          <Eyebrow>What it ran</Eyebrow>
        </div>
        <Block>
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {run.project_type && (
              <Row label="Project type">
                <span style={{ fontSize: 13, color: "var(--t1)", fontWeight: 500 }}>{run.project_type}</span>
              </Row>
            )}
            {run.install_command && (
              <Row label="Install">
                <span className="tnum" style={{ fontSize: 12.5, color: "var(--t2)", textAlign: "right", maxWidth: "60%", wordBreak: "break-word" }}>
                  {run.install_command}
                </span>
              </Row>
            )}
            {run.run_command && (
              <Row label="Run">
                <span className="tnum" style={{ fontSize: 12.5, color: "var(--t2)", textAlign: "right", maxWidth: "60%", wordBreak: "break-word" }}>
                  {run.run_command}
                </span>
              </Row>
            )}
            <Row label="Auto-build">
              <span style={{ fontSize: 13, color: run.auto_build_succeeded ? "var(--t1)" : "var(--amber)", fontWeight: 500 }}>
                {run.auto_build_succeeded ? "Built unattended" : "Did not build"}
              </span>
            </Row>
            <Row label="Ran to completion">
              <span style={{ fontSize: 13, color: run.ran_without_crash ? "var(--t1)" : "var(--amber)", fontWeight: 500 }}>
                {run.ran_without_crash ? "Yes" : "No / crashed"}
              </span>
            </Row>
          </div>
        </Block>
      </div>

      {/* three agents read the code — their cross-verified inferences from READING the
          source, kept distinct from the runtime FACTS below (what actually happened). */}
      {f.raw.verdict.code_behavior_findings.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ marginBottom: 12 }}>
            <Eyebrow>Three agents read the code</Eyebrow>
          </div>
          <Block>
            <p style={{ fontSize: 12.5, color: "var(--t4)", lineHeight: 1.6, margin: "0 0 14px" }}>
              Three agents — install-time, runtime, and payload — read the source in parallel and
              cross-verified. These are their inferences from reading the code; the runtime facts below
              are what actually happened when we ran it.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {f.raw.verdict.code_behavior_findings.map((cf, i) => {
                const sev =
                  cf.severity === "high" ? "var(--red)" : cf.severity === "med" ? "var(--amber)" : "var(--t4)";
                return (
                  <div
                    key={`${cf.signal}-${i}`}
                    style={{ border: "1px solid var(--line)", borderRadius: 13, padding: 15, background: "var(--s2)" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8, flexWrap: "wrap" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: sev, boxShadow: `0 0 7px ${sev}`, flexShrink: 0 }} />
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--t1)" }}>{cf.signal}</span>
                      <span style={{ fontSize: 10, color: "var(--t4)", padding: "2px 8px", border: "1px solid var(--line2)", borderRadius: 6, letterSpacing: "0.02em" }}>
                        Code read · not confirmed at runtime
                      </span>
                    </div>
                    {cf.detail && (
                      <p style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.55, margin: 0 }}>{cf.detail}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Block>
        </div>
      )}

      {/* network intent — what it tried to reach */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ marginBottom: 12 }}>
          <Eyebrow>Network intent — what it tried to reach</Eyebrow>
        </div>
        {f._namedAttempts.length > 0 ? (
          <NetworkIntentTable attempts={f._namedAttempts} blockedNoHostCount={f._blockedNoHostCount} />
        ) : (
          <Block>
            <p style={{ fontSize: 13.5, color: "var(--t3)", lineHeight: 1.6, margin: 0 }}>
              {f._blockedNoHostCount > 0
                ? `${f._blockedNoHostCount} outbound connection attempt(s) were intercepted by the sandbox sinkhole, but none resolved a named destination. No exfiltration target was captured during this run.`
                : "No outbound connection attempts were observed during this run."}
            </p>
          </Block>
        )}
      </div>

      {/* captured exfil payload — inert, never delivered */}
      {f._payloads.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <Eyebrow>Attempted exfil payload</Eyebrow>
            <span style={{ fontSize: 10.5, color: f._verdictColor, padding: "3px 9px", border: `1px solid ${f._verdictColor}`, borderRadius: 6, fontWeight: 500 }}>
              Captured, never delivered
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {f._payloads.map((p, i) => (
              <PayloadBlock key={`${p.host ?? "payload"}-${i}`} payload={p} />
            ))}
          </div>
        </div>
      )}

      {/* in-VM behavior — kept distinct from network intent */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ marginBottom: 12 }}>
          <Eyebrow>In-VM behavior</Eyebrow>
        </div>
        <Block>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14, marginBottom: beh.credential_reads_detail.some((c) => c.high_value) ? 18 : 0 }}>
            <BehaviorStat
              value={beh.high_value_credential_reads}
              label="High-value credential reads"
              danger={beh.high_value_credential_reads > 0}
              hint="from planted decoys"
            />
            <BehaviorStat value={beh.process_exec_count} label="Processes spawned" />
            <BehaviorStat value={beh.files_dropped_count} label="Files dropped" />
            <BehaviorStat
              value={beh.high_cpu ? "High" : `${beh.run_cpu_cores_busy.toFixed(2)}`}
              label={beh.high_cpu ? "CPU (mining-class)" : "CPU cores busy"}
              danger={beh.high_cpu}
            />
          </div>
          {beh.credential_reads_detail.some((c) => c.high_value) && (
            <div style={{ paddingTop: 16, borderTop: "1px solid var(--line)" }}>
              <div style={{ fontSize: 12, color: "var(--t4)", marginBottom: 11 }}>
                Credential paths it read (decoys planted by the sandbox)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {beh.credential_reads_detail
                  .filter((c) => c.high_value)
                  .map((c, i) => (
                    // Index key: attacker-controlled `c.path` could repeat and
                    // break duplicate-key reconciliation. This is a static list.
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: f._verdictColor, flexShrink: 0 }} />
                      <span className="tnum" style={{ fontSize: 12.5, color: "var(--t2)", wordBreak: "break-all" }}>
                        {c.path}
                      </span>
                      {c.succeeded && (
                        <span style={{ fontSize: 10.5, color: "var(--t4)", flexShrink: 0 }}>read</span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </Block>
      </div>

      {/* containment proof — the dual-source invariant */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ marginBottom: 12 }}>
          <Eyebrow>Containment proof</Eyebrow>
        </div>
        {/*
          The heading text AND glyph are gated on the actual containment fact —
          never assert "no packet reached its destination" unless the record
          confirms it. When NOT confirmed, show a distinct amber state that says
          containment was not verified for this run (never imply safety). This is
          the never-bare-Safe rail applied to the containment claim.
        */}
        <Block
          style={{
            // Full `border` shorthand (not just borderColor) so it cleanly overrides
            // Block's own `border` shorthand — mixing the two warns + can drop the color.
            border: `1px solid ${
              cont.no_real_packet_reached_destination ? "oklch(0.80 0.14 158 / 0.45)" : "var(--amber)"
            }`,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                border: cont.no_real_packet_reached_destination
                  ? "1px solid oklch(0.80 0.14 158 / 0.5)"
                  : "1px solid var(--amber)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                marginTop: 1,
              }}
              aria-hidden="true"
            >
              {cont.no_real_packet_reached_destination ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6.2l2.2 2.3 4.8-5" stroke="var(--green)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 3v3.4M6 8.6v.05" stroke="var(--amber)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span
              style={{
                fontSize: 14.5,
                color: cont.no_real_packet_reached_destination ? "var(--t1)" : "var(--amber)",
                fontWeight: 500,
                lineHeight: 1.5,
              }}
            >
              {cont.no_real_packet_reached_destination
                ? "No real packet reached its destination"
                : "Containment was NOT confirmed for this run"}
            </span>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--t3)", lineHeight: 1.6, margin: 0 }}>
            {cont.containment_notes ||
              (cont.no_real_packet_reached_destination
                ? ""
                : "This run did not produce a positive proof that egress was fully contained. Treat any captured outbound attempt as potentially uncontained and run this code only inside a disposable environment.")}
          </p>
          <div style={{ display: "flex", gap: 18, marginTop: 14, flexWrap: "wrap" }}>
            <ContainmentFlag on={cont.external_monitor_saw_egress} label="External monitor saw the egress attempt" />
            <ContainmentFlag on={cont.in_vm_saw_egress} label="In-VM trace corroborated it" />
          </div>
        </Block>
      </div>
      {/* U1: an escalated repo carries NO "what this sandbox run did not verify"
          hedge and no "reported as unverified" dormant note — the sandbox RAN it,
          and the report states what running it showed with confidence. The
          never-a-bare-"Safe" rail is met by the evidence above (what it ran, the
          network intent, the containment proof, the in-VM behavior), not a hedge. */}
    </section>
  );
}

/** The network-intent table: domain · intended IP · geolocation · port. */
function NetworkIntentTable({
  attempts,
  blockedNoHostCount,
}: {
  attempts: ForensicsAttemptView[];
  blockedNoHostCount: number;
}) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, overflow: "hidden", background: "var(--s1)" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr 1.4fr 0.6fr",
          gap: 12,
          padding: "12px 20px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <ColHead>Domain called</ColHead>
        <ColHead>Routing</ColHead>
        <ColHead>Geolocation</ColHead>
        <ColHead>Port</ColHead>
      </div>
      {attempts.map((a, i) => {
        const host = a.intended_host ?? a.http_host_header ?? a.sni ?? "—";
        return (
          <div
            key={`${host}-${a.captured_at ?? i}`}
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 1fr 1.4fr 0.6fr",
              gap: 12,
              padding: "14px 20px",
              borderBottom: "1px solid var(--line)",
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: a._color, boxShadow: `0 0 6px ${a._color}`, flexShrink: 0 }} />
                <span className="tnum" style={{ fontSize: 13, color: "var(--t1)", fontWeight: 500, wordBreak: "break-all" }}>
                  {host}
                </span>
              </div>
              {(a.http_method || a.http_path) && (
                <div className="tnum" style={{ fontSize: 11.5, color: "var(--t4)", marginTop: 4, wordBreak: "break-all" }}>
                  {[a.http_method, a.http_path].filter(Boolean).join(" ")}
                </div>
              )}
            </div>
            <span className="tnum" style={{ fontSize: 12.5, color: "var(--t3)" }}>
              not routed to
            </span>
            <span className="tnum" style={{ fontSize: 12.5, color: "var(--t3)", wordBreak: "break-word" }}>
              {a._geoLabel || "unresolved"}
            </span>
            <span className="tnum" style={{ fontSize: 12.5, color: "var(--t2)" }}>
              {a.dest_port ?? "—"}
            </span>
          </div>
        );
      })}
      {blockedNoHostCount > 0 && (
        <div style={{ padding: "12px 20px", fontSize: 12, color: "var(--t4)", lineHeight: 1.5 }}>
          + {blockedNoHostCount} further outbound attempt(s) intercepted with no resolved destination.
        </div>
      )}
      <div style={{ padding: "11px 20px", borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--t4)", lineHeight: 1.5 }}>
        Intended IPs were resolved off-VM for intelligence only and were never routed to.
      </div>
    </div>
  );
}

/** A column header in the network-intent table. */
function ColHead({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 10.5, color: "var(--t4)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
      {children}
    </span>
  );
}

/** One decoded would-be payload, shown inert. */
function PayloadBlock({ payload }: { payload: ForensicsPayloadView }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 13, overflow: "hidden", background: "var(--s2)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "11px 16px", borderBottom: "1px solid var(--line)" }}>
        <span className="tnum" style={{ fontSize: 12, color: "var(--t3)", wordBreak: "break-all" }}>
          {payload.host ? `to ${payload.host}` : "captured payload"}
        </span>
        <span className="tnum" style={{ fontSize: 11.5, color: "var(--t4)", flexShrink: 0 }}>
          {payload.bytesLen} bytes, inert
        </span>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "14px 16px",
          fontFamily: "inherit",
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--t2)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 220,
          overflow: "auto",
        }}
      >
        {payload.text}
        {payload.truncated ? "\n… (truncated)" : ""}
      </pre>
    </div>
  );
}

/** A single in-VM behavior stat (serif figure + label), red when dangerous. */
function BehaviorStat({
  value,
  label,
  danger,
  hint,
}: {
  value: number | string;
  label: string;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div className="serif tnum" style={{ fontSize: 24, color: danger ? "var(--red)" : "var(--t1)", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--t4)", marginTop: 7, lineHeight: 1.4 }}>
        {label}
        {hint ? <span style={{ color: "var(--t4)" }}> · {hint}</span> : null}
      </div>
    </div>
  );
}

/** A check/cross flag for a containment corroboration source. */
function ContainmentFlag({ on, label }: { on: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: on ? "var(--green)" : "var(--t5)" }} aria-hidden="true" />
      <span style={{ fontSize: 12, color: "var(--t3)" }}>{label}</span>
    </div>
  );
}
