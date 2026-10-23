"use client";

import { useEffect, useState } from "react";
import type { ShownReport } from "./data";
import { TONE } from "./tone";

/**
 * The hero's animated scan card (Gate.dc.html): a replay of the sandbox run on our own exfiltration test fixture.
 * The repo name, the final score and the verdict come from that fixture's real stored report; without one the
 * replay ends on the machine being destroyed and shows no score.
 */

const IC: Record<string, string> = {
  git: "M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  key: "M15 7a4 4 0 11-3.9 5H4v3h3v3h3v-3h1.1A4 4 0 0115 7z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  cpu: "M8 8h8v8H8zM5 9h3M5 15h3M16 9h3M16 15h3M9 5v3M15 5v3M9 16v3M15 16v3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  term: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
};

/** A part of an event line: plain text, or a chip (mono when the flag is set). */
type Part = string | [string, (1 | 0)?];
type Ev = [number, string, string, string, Part[]];

function events(fixture: ShownReport | null): Ev[] {
  const name = fixture?.slug ?? "our test fixture";
  const ev: Ev[] = [
    [0.3, "git", "p-cyan", "Fetched", ["Downloaded ", [name, 1]]],
    [1.0, "box", "p-cyan", "Sandbox", ["Fresh machine booted with ", ["4 vCPU"], " and ", ["4 GB"]]],
    [1.8, "download", "p-info", "Installing", ["Ran ", ["npm install", 1], " with scripts on"]],
    [2.8, "shield", "p-ok", "Clean", ["No malware records in ", ["4 packages"]]],
    [3.8, "term", "p-warn", "Script", [["postinstall", 1], " started ", ["node setup.js", 1]]],
    [4.8, "key", "p-bad", "Decoy read", ["Opened ", ["~/.npmrc", 1], " which holds a planted token"]],
    [5.8, "send", "p-bad", "Exfiltration", ["Sent ", ["2.1 KB"], " to ", ["c2.cr-fixture.invalid", 1]]],
    [6.6, "shield", "p-ok", "Forged", ["The forge answered ", ["200 OK", 1], " so nothing left the machine"]],
    [7.8, "file", "p-pink", "Persistence", ["Wrote ", ["~/.config/autostart/update.desktop", 1]]],
    [9.0, "alert", "p-bad", "Payload", ["Decoded base64 and ran it with ", ["node -e", 1]]],
    [10.2, "spark", "p-violet", "Jev", ["Answered ", ["6 questions"], " from the evidence"]],
  ];
  if (fixture) ev.push([11.2, "cpu", fixture.pill, "Score", [[`${fixture.score} / 100`], ` ${fixture.verdict}`]]);
  ev.push([12.2, "trash", "p-mute", "Destroyed", ["The machine was deleted with everything it touched"]]);
  return ev;
}

const END = 12.4;
const LOOP = 16;
const pad = (n: number) => (n < 10 ? "0" : "") + n;

export function HeroScan({ fixture }: { fixture: ShownReport | null }) {
  const [t, setT] = useState(0);

  useEffect(() => {
    let still = false;
    try {
      still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // no matchMedia: animate
    }
    if (still) {
      const id = setTimeout(() => setT(END), 0);
      return () => clearTimeout(id);
    }
    const id = setInterval(() => setT((p) => {
      const n = Math.round((p + 0.1) * 10) / 10;
      return n >= LOOP ? 0 : n;
    }), 100);
    return () => clearInterval(id);
  }, []);

  const tt = Math.min(t, END);
  const done = tt >= END;
  const list = events(fixture).filter((e) => tt >= e[0]).reverse();
  const s = Math.floor(tt);
  const clock = `${pad(Math.floor(s / 60))}:${pad(s % 60)}.${Math.round((tt - s) * 10)}`;
  const phase = done ? (fixture ? `${fixture.verdict} · ${fixture.score}` : "Destroyed") : tt < 1.8 ? "Booting" : tt < 4.8 ? "Installing" : tt < 10.2 ? "Watching" : "Deciding";
  const phasePill = done ? (fixture ? fixture.pill : "p-mute") : "p-info";
  const progress = `${(Math.min(1, tt / END) * 100).toFixed(1)}%`;

  return (
    <div className="card" style={{ boxShadow: "0 40px 120px rgba(0,0,0,0.8)" }}>
      <div aria-hidden="true" style={{ position: "absolute", left: "0", top: "0", height: "2px", width: progress, background: "#F0F0F0", transition: "width .1s linear" }} />
      <div className="card-h">
        <span style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: "0" }}>
          {!done && (
            <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.15)" strokeWidth="2.4" /><path d="M21 12a9 9 0 00-9-9" stroke="#F0F0F0" strokeWidth="2.4" strokeLinecap="round" /></svg>
          )}
          <span className="mono dim" style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fixture?.slug ?? "test fixture"}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span className="mono faint" style={{ fontSize: "12px", fontVariantNumeric: "tabular-nums" }}>{clock}</span>
          <span className={`pill ${phasePill}`}>{phase}</span>
        </span>
      </div>
      <div aria-hidden="true" style={{ height: "468px", overflow: "hidden", padding: "20px 20px 0", WebkitMaskImage: "linear-gradient(180deg, #000 78%, transparent)", maskImage: "linear-gradient(180deg, #000 78%, transparent)" }}>
        {list.map((e) => (
          <div key={e[0]} className="in" style={{ position: "relative", display: "flex", gap: "14px", paddingBottom: "16px" }}>
            <span aria-hidden="true" style={{ position: "absolute", left: "15.5px", top: "36px", bottom: "-2px", width: "1px", background: "rgba(255,255,255,0.1)" }} />
            <span className="node" style={{ borderColor: `${TONE[e[2]]}55` }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={TONE[e[2]]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={IC[e[1]]} /></svg>
            </span>
            <div style={{ minWidth: "0", flex: 1, paddingTop: "4px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}><span className={`pill ${e[2]}`}>{e[3]}</span><span className="mono faint" style={{ fontSize: "12px" }}>{e[0].toFixed(1)}s</span></div>
              <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", fontSize: "14px", color: "#A1A1A1", lineHeight: 1.6 }}>
                {e[4].map((p, i) => (typeof p === "string" ? <span key={i}>{p}</span> : <span key={i} className={`chip ${p[1] ? "mono" : ""}`}>{p[0]}</span>))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
        {fixture ? `A replay of the sandbox run on ${fixture.slug}: ${fixture.verdict}, ${fixture.score} out of 100.` : "A replay of a sandbox run on a test fixture."}
      </p>
    </div>
  );
}
