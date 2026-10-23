/**
 * Pure derivations for the v4 scan screen (project/term/Scan.dc.html). Every value
 * is read from the run's real events; nothing here is sample data. A value the
 * events do not carry is left out (null or an empty list), never invented.
 */

import type { ScanEvent, StageName } from "@/lib/engine/types";
import { plainLog, type LogTone } from "@/lib/cr/plain-log";

export const IC = {
  git: "M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  key: "M15 7a4 4 0 11-3.9 5H4v3h3v3h3v-3h1.1A4 4 0 0115 7z",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  cpu: "M8 8h8v8H8zM5 9h3M5 15h3M16 9h3M16 15h3M9 5v3M15 5v3M9 16v3M15 16v3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  term: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
} as const;

export const TONE: Record<string, string> = { "p-ok": "#3DD68C", "p-warn": "#FFCA16", "p-bad": "#FF9592", "p-info": "#70B8FF", "p-mute": "#A1A1A1", "p-cyan": "#4CCCE6", "p-violet": "#BAA7FF", "p-orange": "#FFA057", "p-pink": "#FF8DCC" };

/** Package registries and code hosts: install plumbing (same list as lib/cr/plain-log.ts). */
export const PLUMBING_HOST = /(^|\.)(registry\.npmjs\.org|npmjs\.com|yarnpkg\.com|pypi\.org|pythonhosted\.org|github\.com|githubusercontent\.com|codeload\.github\.com|nodejs\.org|corepack)/i;

/** The design's six steps, each fed by the engine stages that make it up. */
const STEP_STAGES: { label: string; stages: StageName[] }[] = [
  { label: "Fetch", stages: ["cache", "resolve", "fetch", "verify"] },
  { label: "Sandbox", stages: [] },
  { label: "Install", stages: [] },
  { label: "Read code", stages: ["reach", "osv", "static"] },
  { label: "Run", stages: [] },
  { label: "Decide", stages: ["checks", "score", "report", "persist"] },
];

export type StepState = "queued" | "active" | "done";

export function steps(visible: readonly ScanEvent[], finished: boolean): { label: string; state: StepState }[] {
  const started = new Set<StageName>();
  const ended = new Set<StageName>();
  let entrySeen = false;
  let installSeen = false;
  for (const e of visible) {
    if (e.type === "stage") (e.data.status === "start" ? started : ended).add(e.data.name);
    if ((e.type === "process" || e.type === "file" || e.type === "forged_call") && e.data.phase === "entry") entrySeen = true;
    if ((e.type === "process" || e.type === "file" || e.type === "forged_call") && e.data.phase === "install") installSeen = true;
  }
  const of = (names: StageName[]): StepState => {
    const st = names.filter((n) => started.has(n) || ended.has(n));
    if (st.length === 0) return "queued";
    return st.every((n) => ended.has(n)) && !names.some((n) => started.has(n) && !ended.has(n)) ? "done" : "active";
  };
  const fetchDone = ended.has("fetch") || ended.has("verify");
  const detStart = started.has("detonate") || installSeen;
  const detEnd = ended.has("detonate");
  const sandbox: StepState = detStart ? "done" : fetchDone ? "active" : "queued";
  const install: StepState = entrySeen || detEnd ? "done" : detStart ? "active" : "queued";
  const run: StepState = detEnd ? "done" : entrySeen ? "active" : "queued";
  const out = STEP_STAGES.map((s, i) => {
    if (i === 1) return { label: s.label, state: sandbox };
    if (i === 2) return { label: s.label, state: install };
    if (i === 4) return { label: s.label, state: run };
    return { label: s.label, state: of(s.stages) };
  });
  return finished ? out.map((s) => ({ ...s, state: s.state === "queued" ? "queued" : "done" })) : out;
}

/** The phase pill while running, named after the step in progress. */
export function phaseWord(st: { label: string; state: StepState }[]): string {
  const active = st.filter((s) => s.state === "active").map((s) => s.label);
  const last = active[active.length - 1];
  switch (last) {
    case "Fetch":
      return "Fetching";
    case "Sandbox":
      return "Booting";
    case "Install":
      return "Installing";
    case "Read code":
    case "Run":
      return "Checking";
    case "Decide":
      return "Deciding";
    default:
      return st.some((s) => s.state === "done") ? "Checking" : "Starting";
  }
}

export interface TimelineRow {
  seq: number;
  t: string;
  icon: string;
  pc: string;
  pt: string;
  text: string;
}

function toneClass(t: LogTone): string {
  return t === "bad" ? "p-bad" : t === "warn" ? "p-warn" : t === "ok" ? "p-ok" : "p-mute";
}

const STAGE_LABEL: Partial<Record<StageName, { pt: string; icon: string; pc?: string }>> = {
  resolve: { pt: "Fetched", icon: IC.git, pc: "p-cyan" },
  fetch: { pt: "Fetched", icon: IC.git, pc: "p-cyan" },
  verify: { pt: "Fetched", icon: IC.git, pc: "p-cyan" },
  reach: { pt: "Reach map", icon: IC.search, pc: "p-orange" },
  osv: { pt: "Malware list", icon: IC.shield },
  static: { pt: "Scanners", icon: IC.search, pc: "p-orange" },
  detonate: { pt: "Sandbox", icon: IC.box, pc: "p-info" },
  checks: { pt: "Jev", icon: IC.spark, pc: "p-violet" },
  score: { pt: "Score", icon: IC.cpu },
  report: { pt: "Luna", icon: IC.spark, pc: "p-pink" },
};

/** The live timeline, newest first, in the plain words of lib/cr/plain-log.ts. */
export function timeline(visible: readonly ScanEvent[]): TimelineRow[] {
  const bySeq = new Map(visible.map((e) => [e.seq, e]));
  return plainLog(visible)
    .map((l) => {
      const e = bySeq.get(l.seq);
      let pt = "Event";
      let icon: string = IC.term;
      let pc = toneClass(l.tone);
      if (e?.type === "stage") {
        const m = STAGE_LABEL[e.data.name];
        if (m) {
          pt = m.pt;
          icon = m.icon;
          if (l.tone === null && m.pc) pc = m.pc;
        }
      } else if (e?.type === "check") {
        if (e.data.name === "sandbox_killed") {
          pt = "Destroyed";
          icon = IC.trash;
        } else if (e.data.name === "egress_contained") {
          pt = "Forge";
          icon = IC.shield;
        } else if (e.data.name === "package_manager") {
          pt = "Installing";
          icon = IC.download;
          if (l.tone === null) pc = "p-info";
        }
      } else if (e?.type === "forged_call") {
        pt = "Forged";
        icon = IC.send;
      } else if (e?.type === "file") {
        pt = "Decoy read";
        icon = IC.key;
      }
      return { seq: l.seq, t: `${(l.at / 1000).toFixed(1)}s`, icon, pc, pt, text: l.text };
    })
    .reverse();
}

export interface Proc {
  key: string;
  depth: number;
  cmd: string;
  color: string;
}

/** The last processes the sandbox recorded, indented by parent. */
export function processes(visible: readonly ScanEvent[], decoyPids: Set<number>, max = 5): Proc[] {
  const depth = new Map<number, number>();
  const out: Proc[] = [];
  for (const e of visible) {
    if (e.type !== "process") continue;
    const d = depth.has(e.data.ppid) ? Math.min(4, (depth.get(e.data.ppid) ?? 0) + 1) : 0;
    depth.set(e.data.pid, d);
    const cmd = e.data.argv.join(" ").trim();
    if (!cmd) continue;
    out.push({ key: `${e.seq}`, depth: d, cmd, color: decoyPids.has(e.data.pid) ? "#FF9592" : d === 0 ? "#8A8A8A" : "#F0F0F0" });
  }
  return out.slice(-max);
}

/** Home-directory writes worth showing (persistence, shell rc, credentials). */
const HOME_TOUCH = /(^~|\/home\/[^/]+|\/root)\/\.(config|ssh|bashrc|profile|zshrc|npmrc|aws|gnupg|local\/share\/autostart)/;

export interface FileChip {
  path: string;
  bad: boolean;
}

export function fileChips(visible: readonly ScanEvent[], max = 3): FileChip[] {
  const seen = new Map<string, FileChip>();
  for (const e of visible) {
    if (e.type !== "file") continue;
    if (e.data.op === "read_decoy") seen.set(e.data.path, { path: e.data.path, bad: true });
    else if ((e.data.op === "write" || e.data.op === "create") && HOME_TOUCH.test(e.data.path)) seen.set(e.data.path, { path: e.data.path, bad: true });
  }
  return [...seen.values()].slice(-max);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface JevRow {
  key: string;
  q: string;
  a: string;
  pc: string;
}

function questionFor(subject: string, answer: string): { q: string; a: string; pc: string } {
  const sig = answer.match(/^install_([a-z]+)=(true|false)$/);
  if (sig) {
    const label: Record<string, string> = { network: "use the network", credentials: "access credentials", exec: "run a shell or a payload", obfuscation: "use obfuscated code" };
    const yes = sig[2] === "true";
    return { q: `Does install code ${label[sig[1]!] ?? sig[1]}?`, a: yes ? "Yes" : "No", pc: yes ? "p-bad" : "p-ok" };
  }
  const decl = answer.match(/^declares_(no_network|pure)=(true|false)$/);
  if (decl) {
    const yes = decl[2] === "true";
    return { q: decl[1] === "no_network" ? "Do the docs say it makes no network calls?" : "Do the docs say it has no side effects?", a: yes ? "Yes" : "No", pc: "p-mute" };
  }
  const word = answer.charAt(0).toUpperCase() + answer.slice(1).replace(/_/g, " ");
  const pc = answer === "malicious" || answer === "mismatch" ? "p-bad" : answer === "suspicious" ? "p-warn" : answer === "benign" || answer === "fits" || answer === "match" ? "p-ok" : "p-mute";
  if (subject === "documentation versus measured capabilities") return { q: "Do the docs explain what the code does?", a: word, pc };
  return { q: `What does ${subject} do?`, a: word, pc };
}

/**
 * Jev's answers, parsed from its transcript lines (lib/engine/model/checks.ts
 * summarize: `Jev <check> check: <subject> <answer> p=0.00; ...`). A Jev check
 * that failed (check event jev_<name> not ok) shows as not answered.
 */
export function jevRows(visible: readonly ScanEvent[]): JevRow[] {
  const out: JevRow[] = [];
  for (const e of visible) {
    if (e.type === "transcript" && e.data.source.startsWith("jev.")) {
      const body = e.data.text.replace(/^Jev [a-z]+ check:\s*/, "");
      body.split("; ").forEach((part, i) => {
        const m = part.trim().match(/^(.*) (\S+?)(?: p=[\d.]+)?$/);
        if (!m) return;
        out.push({ key: `${e.seq}-${i}`, ...questionFor(m[1]!, m[2]!) });
      });
    } else if (e.type === "check" && /^jev_(install|docs|flagged)$/.test(e.data.name) && !e.data.ok) {
      const which = e.data.name.slice(4);
      out.push({ key: `${e.seq}`, q: `The ${which} check did not finish`, a: "Not answered", pc: "p-warn" });
    }
  }
  return out;
}

/** Luna's report text from its transcript line: what ran, then what matters. */
export function lunaText(visible: readonly ScanEvent[]): { text: string; atMs: number } | null {
  const e = visible.find((x) => x.type === "transcript" && x.data.source === "luna.report");
  if (!e || e.type !== "transcript") return null;
  const lines = e.data.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const text = lines.length >= 4 ? `${lines[2]} ${lines[3]}` : lines.slice(1).join(" ") || lines[0] || "";
  return text ? { text, atMs: e.t_ms } : null;
}

export function vmCpu(visible: readonly ScanEvent[]): number | null {
  for (const e of visible) if (e.type === "check" && e.data.name === "vm_size") return Number(e.data.detail?.match(/(\d+) vCPU/)?.[1] ?? NaN) || null;
  return null;
}

export function clock(ms: number): string {
  const t = Math.max(0, ms) / 1000;
  const s = Math.floor(t);
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}.${Math.min(9, Math.floor((t - s) * 10))}`;
}
