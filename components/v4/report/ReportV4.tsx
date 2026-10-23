/**
 * The v4 public report (project/term/Report.dc.html), server-rendered from the stored 2.0 report and its run's
 * observed events. Every value on the page comes from the report or the events; a section with no data is left out.
 * The verdict word and score come from the engine (never a bare "Safe"); reputation sits in its own card, apart
 * from the code and behaviour cards, and is not part of the score breakdown shown above it.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { Band, ForgedCallData, ScoreDelta, StageName } from "@/lib/engine/types";
import { notVerifiedBullets, plainTitle, reputationChips, shortMiddle } from "@/lib/cr/result-format";
import { toneOf } from "@/lib/cr/verdict";
import { ADS_ENABLED } from "@/lib/ads-enabled";
import { AdSlot } from "@/components/ads/AdSlot";
import type { Ad as WebAd } from "@/lib/engine/types";
import type { V2Report } from "./data";
import { plainEvidence, plainJev, type PlainEvidence } from "./plain";
import s from "./report.module.css";

const BAND_GA: Record<Band, string> = { green: "ga-green", blue: "ga-blue", yellow: "ga-amber", red: "ga-red" };
const TONE_PILL = { ok: "p-ok", warn: "p-warn", bad: "p-bad" } as const;
const BAD = "#FF9592";
const WARN = "#FFCA16";
const OK = "#3DD68C";
const MUTE = "#A1A1A1";
const SEG = ["#FF9592", "#F08A96", "#E5A0A8", "#C9878F", "#B07A82"];

/** List caps that keep the two columns close in height on typical reports; the rest sits behind "Show all N". */
const NETWORK_CAP = 6;
const TIMELINE_CAP = 6;
const EVIDENCE_CAP = 4;
const NV_CAP = 2;
const JEV_CAP = 2;

const P = {
  key: "M15 7a4 4 0 11-3.9 5H4v3h3v3h3v-3h1.1A4 4 0 0115 7z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  term: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  down: "M12 3v12M7 10l5 5 5-5M5 21h14",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  warn: "M12 3l10 18H2zM12 10v5M12 18h.01",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  bars: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  q: "M9 9a3 3 0 115 2c-1 .6-2 1.3-2 2.5M12 17h.01M12 3a9 9 0 100 18 9 9 0 000-18z",
  doc: "M6 3h12v18H6zM9 8h6M9 12h6M9 16h4",
};

function Ico({ d, color = MUTE, size = 15 }: { d: string; color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Card({ icon, color, title, aside, asideMono, asideColor, children, pad = "0 20px 6px" }: { icon: string; color: string; title: string; aside?: string; asideMono?: boolean; asideColor?: string; children: ReactNode; pad?: string }) {
  return (
    <section className="card">
      <div className="card-h" style={{ padding: "14px 20px", flexWrap: "wrap" }}>
        <h2 className="card-t" style={{ margin: 0, fontSize: 15 }}>
          <span style={{ display: "inline-flex", width: 24, height: 24, borderRadius: 7, background: `${color}1F`, alignItems: "center", justifyContent: "center", marginRight: 10, verticalAlign: -6 }}>
            <Ico d={icon} color={color} size={13} />
          </span>
          {title}
        </h2>
        {aside ? <span className={asideMono ? "mono faint" : "faint"} style={{ fontSize: 13, ...(asideColor ? { color: asideColor } : {}) }}>{aside}</span> : null}
      </div>
      <div style={{ padding: pad }}>{children}</div>
    </section>
  );
}

function KV({ k, v, dim }: { k: string; v: string; dim?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "11px 0", borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: 14 }}>
      <span className="dim" style={{ flex: "none" }}>{k}</span>
      <span style={{ color: dim ? MUTE : "#F0F0F0", textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** A forged call that is not plain registry traffic. */
function offRegistry(c: ForgedCallData): boolean {
  if (c.canary_hits.length > 0) return true;
  return !/registry|mirror|pypi|pythonhosted|npmjs|yarnpkg|rubygems|crates|proxy\.golang/i.test(`${c.forged_kind} ${c.host}`);
}

const STAGE_TEXT: Partial<Record<StageName, { pill: string; cls: string; color: string; icon: string; text: string }>> = {
  fetch: { pill: "Fetched", cls: "p-cyan", color: "#4CCCE6", icon: P.down, text: "Downloaded the code" },
  static: { pill: "Read", cls: "p-cyan", color: "#4CCCE6", icon: P.doc, text: "Read the code with the static scanners" },
  osv: { pill: "Checked", cls: "p-cyan", color: "#4CCCE6", icon: P.shield, text: "Checked dependencies against malware records" },
  detonate: { pill: "Sandbox", cls: "p-info", color: "#70B8FF", icon: P.box, text: "Installed and ran it on a fresh machine" },
  checks: { pill: "Jev", cls: "p-violet", color: "#BAA7FF", icon: P.q, text: "Answered questions from the evidence" },
  score: { pill: "Score", cls: "p-mute", color: MUTE, icon: P.bars, text: "Scored from the evidence" },
};

const JEV_LABEL: Record<string, string> = { "jev.install": "Install check", "jev.flagged": "Flagged code check", "jev.docs": "Docs check" };

export interface ReportV4Props {
  report: V2Report;
  /** Shown above the score: github.com/owner/repo or npmjs.com/package/name. */
  sourceLabel: string;
  /** The ad for the slots when ADS_ENABLED; ignored otherwise. */
  ad: WebAd | null;
  /** Where "Scan another" goes. */
  newScanHref: string;
}

export function ReportV4({ report, sourceLabel, ad, newScanHref }: ReportV4Props) {
  const p = report.payload;
  const tone = toneOf(p.verdict);
  const ev = report.events;
  const calls = ev.flatMap((e) => (e.type === "forged_call" ? [e.data] : []));
  const files = ev.flatMap((e) => (e.type === "file" ? [{ ...e.data, t: e.t_ms }] : []));
  const decoys = files.filter((f) => f.op === "read_decoy");
  const writes = files.filter((f) => f.op !== "read_decoy");
  const offCalls = calls.filter(offRegistry);
  const canaryCalls = calls.filter((c) => c.canary_hits.length > 0);
  const jev = ev.flatMap((e) => (e.type === "transcript" && e.data.source.startsWith("jev.") && e.data.text.trim() ? [{ source: e.data.source, lines: plainJev(e.data.text) }] : [])).filter((j) => j.lines.length > 0);
  const stages = ev.flatMap((e) => (e.type === "stage" && e.data.status === "done" && STAGE_TEXT[e.data.name] ? [{ name: e.data.name, t: e.t_ms, detail: e.data.detail }] : []));
  const seenStage = new Set<string>();
  const timeline = stages.filter((s) => (seenStage.has(s.name) ? false : (seenStage.add(s.name), true)));
  const lastT = ev.length ? ev[ev.length - 1]!.t_ms : 0;

  const deductions: ScoreDelta[] = p.breakdown.filter((d) => d.points < 0 && d.group !== "reputation").sort((a, b) => a.points - b.points);
  const raises = p.breakdown.filter((d) => d.points > 0 && d.group !== "reputation");
  const totalOff = deductions.reduce((s, d) => s + d.points, 0);
  const codeOff = deductions.filter((d) => d.group === "static" || d.group === "docs");
  const nv = notVerifiedBullets(p.not_verified, 12);
  const nvAll = [...nv.shown, ...nv.more];
  const rep = reputationChips(p.reputation_section?.facts ?? []);
  const repWarn = p.reputation_section?.warnings ?? [];
  const ran = p.ran;
  const short = p.commit_sha ? p.commit_sha.slice(0, 7) : "";
  const words = (raw: string) => {
    const e = plainEvidence(raw);
    return e.where ? `${e.text} at ${e.where}` : e.text;
  };
  const title = (detail: string) => words(plainTitle(detail));

  // At a glance: one card per signal the run produced, from the run's own events and deductions.
  const glance: { icon: string; label: string; pill: string; cls: string; line: string }[] = [];
  if (decoys.length) glance.push({ icon: P.key, label: "Credentials", pill: "Read a decoy", cls: "p-bad", line: shortMiddle([...new Set(decoys.map((d) => d.path))].join(", "), 48) });
  if (ran?.network) {
    const n = ran.network;
    glance.push(
      n.kind === "forged"
        ? { icon: P.send, label: "Network", pill: canaryCalls.length ? "Exfiltration" : offCalls.length ? "Unknown hosts" : "Forged", cls: canaryCalls.length || offCalls.length ? "p-bad" : "p-warn", line: `${plural(n.calls, "call", "calls")}, answered by the forge` }
        : { icon: P.send, label: "Network", pill: n.kind === "none" ? "None" : "Registry only", cls: "p-ok", line: n.kind === "none" ? "No network calls" : "Registry traffic only" },
    );
  }
  if (writes.length) glance.push({ icon: P.file, label: "Files", pill: plural(writes.length, "change", "changes"), cls: "p-warn", line: shortMiddle(writes[0]!.path, 48) });
  glance.push(codeOff.length ? { icon: P.term, label: "Code", pill: plural(codeOff.length, "finding", "findings"), cls: "p-bad", line: shortMiddle(title(codeOff[0]!.detail), 48) } : { icon: P.term, label: "Code", pill: "Nothing taken off", cls: "p-ok", line: "no code deduction" });

  // How the attack works: the run's suspicious events in order, only when there are any.
  const flow: { icon: string; color: string; head: string; sub: string; t: number }[] = [];
  for (const d of decoys) flow.push({ icon: P.key, color: BAD, head: shortMiddle(d.path, 22), sub: `decoy read in ${d.phase}`, t: d.t });
  for (const e of ev) {
    if (e.type !== "forged_call" || !offRegistry(e.data)) continue;
    const c = e.data;
    flow.push({ icon: P.send, color: BAD, head: `${c.method ?? c.proto.toUpperCase()} ${shortMiddle(c.host, 18)}`, sub: c.canary_hits.length ? "planted credential sent" : `${c.req_bytes} B sent`, t: e.t_ms });
  }
  if (flow.length) {
    for (const w of writes.filter((f) => !/node_modules|site-packages|\/tmp\//.test(f.path)).slice(0, 2)) flow.push({ icon: P.file, color: WARN, head: shortMiddle(w.path.split("/").pop() ?? w.path, 22), sub: `${w.op} in ${w.phase}`, t: w.t });
  }
  flow.sort((a, b) => a.t - b.t);
  const flowSteps = flow.slice(0, 6);
  if (flowSteps.length && calls.length) flowSteps.push({ icon: P.shield, color: OK, head: "Forge", sub: "answered, nothing real left", t: Infinity });

  const withAds = ADS_ENABLED && ad !== null;
  const adBanner = withAds ? <div style={{ marginTop: 4 }}><AdSlot ad={ad} /></div> : null;
  const side = withAds ? <aside className="side" aria-label="Sponsored"><div className="stick"><AdSlot ad={ad} /></div></aside> : null;
  const replayHref = p.run_id ? `/app/scan/${encodeURIComponent(p.run_id)}?replay=1&r=0` : null;

  const head = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "28px 36px", paddingBottom: 36, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={{ flex: "999 1 440px", minWidth: 0 }}>
        <div className="mono dim" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{sourceLabel}{short ? ` · ${short}` : ""}</div>
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 16px" }}>
          <h1 style={{ margin: 0, display: "contents" }}>
            <span className={`ga ${BAND_GA[p.band]}`} style={{ fontSize: "clamp(64px,7vw,96px)", fontWeight: 400, letterSpacing: "-0.05em", lineHeight: 1.05 }}>{p.score}</span>
            <span className="dim" style={{ fontSize: 20 }}>/ 100</span>
          </h1>
          <span className={`pill ${TONE_PILL[tone]}`} style={{ height: 28, padding: "0 12px", fontSize: 14 }}>{p.verdict}</span>
          {p.partial ? <span className="pill p-warn" style={{ height: 28, padding: "0 12px", fontSize: 14 }}>Partial run</span> : null}
        </div>
        <p className="lede" style={{ marginTop: 10, maxWidth: 620 }}>
          <span style={{ color: "#F0F0F0" }}>{p.headline || p.summary}</span>
          {report.createdAt ? ` Scanned ${new Date(report.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}.` : ""}
        </p>
        {p.partial && p.partial_reason ? <p className="body faint" style={{ marginTop: 6, fontSize: 14 }}>{p.partial_reason}</p> : null}
      </div>
      <div className={s.actions} style={{ flex: "1 1 260px" }}>
        {replayHref ? <Link href={replayHref} className="btn btn-s btn-sm">Watch how it happened</Link> : null}
        <Link href={newScanHref} className="btn btn-p btn-sm">Scan another</Link>
      </div>
    </div>
  );

  const hero = (
    <div className={s.hero}>
      {head}
      {adBanner}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(210px, 100%), 1fr))", gap: 12 }}>
        {glance.map((g) => (
          <div key={g.label} className="card" style={{ padding: 18, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }} className="dim"><Ico d={g.icon} /> {g.label}</span>
              <span className={`pill ${g.cls}`}>{g.pill}</span>
            </div>
            <div className="mono" style={{ marginTop: 14, fontSize: 12, color: "#F0F0F0", overflowWrap: "anywhere" }}>{g.line}</div>
          </div>
        ))}
      </div>

      {flowSteps.length ? (
        <Card icon={P.send} color={BAD} title="How the attack works" aside="as the sandbox saw it" pad="0 20px">
          <div className={s.flow}>
            {flowSteps.map((st, i) => (
              <div key={`${st.head}-${i}`} className={s.flowStep}>
                <div className={s.flowText}>
                  <span className="node" style={{ borderColor: `${st.color}55` }}><Ico d={st.icon} color={st.color} /></span>
                  <div className={s.flowLabel}>
                    <div className={`mono ${s.ellipsis}`} style={{ fontSize: 12, color: "#F0F0F0" }}>{st.head}</div>
                    <div className={`faint ${s.ellipsis}`} style={{ fontSize: 12 }}>{st.sub}</div>
                  </div>
                </div>
                {i < flowSteps.length - 1 ? <span aria-hidden="true" className={s.flowLine} /> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card icon={P.bars} color="#FFA057" title="Score" aside={deductions.length ? `100 ${totalOff < 0 ? "−" : "+"} ${Math.abs(totalOff)}${raises.length ? " with adjustments" : ""} = ${p.score}${p.score === 0 ? ", floored" : ""}` : `${p.score} / 100`} asideMono pad="0 20px">
        <div style={{ padding: "20px 0 18px" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }} className="mono faint"><span style={{ fontSize: 12 }}>100</span><span style={{ fontSize: 12 }}>0</span></div>
          <div style={{ position: "relative", marginTop: 8, display: "flex", gap: 2, borderRadius: 6, overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
            {deductions.length ? deductions.map((d, i) => (
              <div key={`${d.code}-${i}`} title={title(d.detail)} style={{ flex: `${-d.points} 1 0`, height: 10, background: SEG[i % SEG.length] }} />
            )) : <div style={{ flex: `${p.score} 1 0`, height: 10, background: OK }} />}
          </div>
          {deductions.length ? (
            <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: "8px 20px" }}>
              {deductions.map((d, i) => (
                <span key={`${d.code}-l${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, minWidth: 0, maxWidth: "100%" }} className="dim">
                  <span style={{ flex: "none", width: 8, height: 8, borderRadius: 2, background: SEG[i % SEG.length] }} />
                  <span className={s.ellipsis}>{shortMiddle(title(d.detail), 48)}</span> <span className="mono" style={{ color: "#F0F0F0" }}>−{-d.points}</span>
                </span>
              ))}
            </div>
          ) : <p className="body" style={{ marginTop: 14, fontSize: 14 }}>Nothing was taken off for what the code did or what running it showed.</p>}
        </div>
      </Card>
    </div>
  );

  const pointsCard = deductions.length ? (
    <Card icon={P.warn} color={BAD} title="Points taken off" aside={`−${-totalOff}${p.score === 0 ? ", floored at 0" : ""}`} asideMono asideColor={BAD} pad="0 20px 4px">
      {deductions.map((d, i) => {
        const items = (d.evidence ?? []).filter(Boolean).map(plainEvidence);
        return (
          <div key={`${d.code}-d${i}`} style={{ padding: "22px 0", borderTop: i ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
            <div style={{ display: "flex", gap: 18 }}>
              <span className="mono" style={{ flex: "none", width: 44, fontSize: 18, color: BAD }}>−{-d.points}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="h3" style={{ fontSize: 17, overflowWrap: "anywhere" }}>{title(d.detail)}</div>
                {items.length ? (
                  <div style={{ marginTop: 14, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, background: "#000", overflow: "hidden" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <span className="mono dim" style={{ fontSize: 12 }}>evidence</span>
                      <span className="faint" style={{ fontSize: 12 }}>{d.group === "behaviour" ? "seen running in the sandbox" : d.group === "intel" ? "from malware records" : "found in the code"}</span>
                    </div>
                    <div style={{ padding: "4px 16px" }}>
                      <Capped items={items} cap={EVIDENCE_CAP} noun="lines" render={(e, j) => <EvidenceRow key={`${j}-${e.text}-${e.where ?? ""}`} e={e} first={j === 0} />} />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  ) : null;

  const timelineCard = timeline.length ? (
    <Card icon={P.clock} color="#70B8FF" title="What it did" aside={`${plural(ev.length, "event", "events")} in ${secs(lastT)}`} pad="22px 20px 6px">
      <Capped
        items={timeline}
        cap={TIMELINE_CAP}
        noun="steps"
        render={(st, i) => {
          const tx = STAGE_TEXT[st.name]!;
          return (
            <div key={st.name} style={{ position: "relative", display: "flex", gap: 14, paddingBottom: 16 }}>
              {i < timeline.length - 1 ? <span aria-hidden="true" style={{ position: "absolute", left: 15.5, top: 36, bottom: -8, width: 1, background: "rgba(255,255,255,0.1)" }} /> : null}
              <span className="node" style={{ borderColor: `${tx.color}55` }}><Ico d={tx.icon} color={tx.color} /></span>
              <div style={{ minWidth: 0, flex: 1, paddingTop: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span className={`pill ${tx.cls}`}>{tx.pill}</span><span className="mono faint" style={{ fontSize: 12 }}>{secs(st.t)}</span></div>
                <div style={{ marginTop: 8, fontSize: 14, color: MUTE, lineHeight: 1.6, overflowWrap: "anywhere" }}>{st.detail ? shortMiddle(words(st.detail), 120) : tx.text}</div>
              </div>
            </div>
          );
        }}
      />
    </Card>
  ) : null;

  const networkCard = calls.length ? (
    <Card icon={P.send} color="#4CCCE6" title="Network" aside="nothing real left the machine">
      <Capped
        items={calls}
        cap={NETWORK_CAP}
        noun="calls"
        render={(c, i) => (
          <div key={`${c.host}-${i}`} style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "12px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <span className="mono faint" style={{ fontSize: 12 }}>{c.method ?? c.proto.toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <div className={`mono ${s.ellipsis}`} style={{ fontSize: 13 }}>{c.host}{c.path ? shortMiddle(c.path, 40) : ""}</div>
              <div className="faint" style={{ fontSize: 13, marginTop: 2 }}>{c.req_bytes} B sent in {c.phase}{c.canary_hits.length ? ", carrying a planted credential" : ""}</div>
            </div>
            <span className={`pill ${c.canary_hits.length ? "p-bad" : offRegistry(c) ? "p-warn" : "p-ok"}`}>{c.tls === "refused" ? "TLS refused" : `Forged ${c.forged_kind}`}</span>
          </div>
        )}
      />
    </Card>
  ) : null;

  const lunaCard = p.luna_report || p.summary ? (
    <Card icon={P.doc} color="#FF8DCC" title="Luna's report">
      {p.luna_report ? (
        <>
          <p style={{ margin: 0, padding: "18px 0 8px", fontSize: 16, lineHeight: 1.7, color: "#F0F0F0" }}>{p.luna_report.what_matters}</p>
          <p style={{ margin: 0, padding: "0 0 14px", fontSize: 15, lineHeight: 1.7 }} className="dim">{p.luna_report.what_ran}</p>
        </>
      ) : <p style={{ margin: 0, padding: "18px 0 14px", fontSize: 16, lineHeight: 1.7, color: "#F0F0F0" }}>{p.summary}</p>}
    </Card>
  ) : null;

  const ranCard = ran ? (
    <Card icon={P.shield} color={OK} title="What it ran">
      {ran.package_manager ? <KV k="Installed" v={`${ran.package_manager}${ran.installed !== null ? ` · ${plural(ran.installed, "package", "packages")}` : ""}${ran.install_ms !== null ? ` · ${secs(ran.install_ms)}` : ""}`} /> : <KV k="Installed" v="Nothing to install" dim />}
      {ran.install_scripts !== null ? <KV k="Install scripts" v={String(ran.install_scripts)} /> : null}
      {ran.skipped ? <KV k="Skipped" v={plural(ran.skipped, "package", "packages")} /> : null}
      <KV k="Entry point" v={ran.entry_point ? `${shortMiddle(ran.entry_point.command, 36)}${ran.entry_point.exit_code !== null ? ` · exit ${ran.entry_point.exit_code}` : ""}` : "None found"} dim={!ran.entry_point} />
      {ran.network ? <KV k="Network" v={ran.network.kind === "forged" ? `${plural(ran.network.calls, "call", "calls")}, forged` : ran.network.kind === "none" ? "No calls" : "Registry only"} /> : null}
      <KV k="Machine" v="Destroyed after the scan" />
    </Card>
  ) : null;

  const jevCard = jev.length ? (
    <Card icon={P.q} color="#BAA7FF" title="Jev's answers" aside="answered from the evidence">
      {jev.map((j, i) => (
        <div key={`${j.source}-${i}`} style={{ padding: "11px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: 14 }}>{JEV_LABEL[j.source] ?? "Check"}</div>
          <Capped items={j.lines} cap={JEV_CAP} noun="answers" render={(l, k) => <EvidenceRow key={`${k}-${l.text}-${l.where ?? ""}`} e={l} first small />} />
        </div>
      ))}
    </Card>
  ) : null;

  const nvCard = nvAll.length ? (
    <Card icon={P.warn} color={WARN} title="Not verified">
      <Capped items={nvAll} cap={NV_CAP} noun="items" render={(t) => <p key={t} style={{ margin: 0, padding: "11px 0", borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: 14, overflowWrap: "anywhere" }} className="dim">{words(t)}</p>} />
    </Card>
  ) : null;

  const repCard = rep.length || repWarn.length ? (
    <Card icon={P.user} color={MUTE} title="Reputation">
      {rep.map((r) => <KV key={`${r.source}-${r.text}`} k={r.source} v={r.text} />)}
      {repWarn.map((w) => <p key={w} style={{ margin: 0, padding: "11px 0", borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: 14, color: WARN, overflowWrap: "anywhere" }}>{w}</p>)}
      <p className="faint" style={{ margin: "10px 0 6px", fontSize: 12 }}>Shown apart from the code and behaviour findings.</p>
    </Card>
  ) : null;

  const body = (
    <>
      {hero}
      <div className={s.cols}>
        <div className={s.col}>
          {pointsCard}
          {timelineCard}
          {networkCard}
        </div>
        <div className={s.col}>
          {lunaCard}
          {ranCard}
          {jevCard}
          {nvCard}
          {repCard}
        </div>
      </div>
    </>
  );

  if (withAds) {
    return (
      <div className="rw">
        {side}
        <main className={s.mainAds}>{body}</main>
        {side}
      </div>
    );
  }
  return <main className={`wrap ${s.main}`}>{body}</main>;
}

/** One evidence line: plain words, then the file:line in a code chip when there is one. */
function EvidenceRow({ e, first, small }: { e: PlainEvidence; first?: boolean; small?: boolean }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px", padding: small ? "6px 0 0" : "10px 0", borderTop: first ? "none" : "1px solid rgba(255,255,255,0.06)", minWidth: 0 }}>
      <span style={{ fontSize: small ? 13 : 14, color: small ? MUTE : "#F0F0F0", lineHeight: 1.6, minWidth: 0, overflowWrap: "anywhere" }}>{e.text}</span>
      {e.where ? <code className={`chip mono ${s.chip}`}>{e.where}</code> : null}
    </div>
  );
}

/** The first `cap` items, the rest behind a "Show all N" toggle (a <details>, so the page stays server-rendered). */
function Capped<T>({ items, cap, noun, render }: { items: readonly T[]; cap: number; noun: string; render: (item: T, index: number) => ReactNode }) {
  const head = items.slice(0, cap);
  const rest = items.slice(cap);
  return (
    <>
      {head.map((it, i) => render(it, i))}
      {rest.length ? (
        <details className={s.more}>
          <summary>{`Show all ${items.length} ${noun}`}</summary>
          {rest.map((it, i) => render(it, i + cap))}
        </details>
      ) : null}
    </>
  );
}
