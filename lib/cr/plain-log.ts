/**
 * The scan page's event log in plain words. The engine's stored events keep every
 * raw detail (fences, byte and millisecond counts, scanner errors, every file write
 * and forged call); this turns them into the short lines a builder reads. The same
 * mapping serves the live scan and the replay. Anything not listed here is hidden
 * from the screen, never dropped from the record.
 */

import type { ScanEvent, StageName } from "@/lib/engine/types";

export type LogTone = "ok" | "warn" | "bad" | null;
export interface LogLine {
  at: number;
  text: string;
  tone: LogTone;
  seq: number;
}

export const STAGE_WORD: Record<StageName, string> = {
  cache: "Starting",
  resolve: "Finding the commit",
  fetch: "Fetching the repo",
  verify: "Checking the download",
  reach: "Mapping what install reaches",
  osv: "Checking the malware database",
  detonate: "Installing and running it",
  static: "Reading the code",
  checks: "Answering the security questions",
  score: "Scoring",
  report: "Writing the report",
  persist: "Saving the report",
};

/** Stage starts shown in the log; the rest only change the stage label. */
const SHOWN_STARTS = new Set<StageName>(["resolve", "fetch", "static", "osv", "detonate", "score", "report"]);

/** Package registries and code hosts: traffic to them is install plumbing, not a finding. */
const PLUMBING_HOST = /(^|\.)(registry\.npmjs\.org|npmjs\.com|yarnpkg\.com|pypi\.org|pythonhosted\.org|github\.com|githubusercontent\.com|codeload\.github\.com|nodejs\.org|corepack)/i;

const n = (s: string | undefined, re: RegExp): number | null => {
  const m = s?.match(re);
  return m?.[1] ? Number(m[1]) : null;
};
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

function stageDone(name: StageName, status: string, detail: string | undefined): { text: string; tone: LogTone }[] {
  if (status === "error") {
    if (name === "static") return [{ text: "The code scanners did not finish", tone: "warn" }];
    return [{ text: `${STAGE_WORD[name]} did not finish`, tone: "warn" }];
  }
  if (status === "skipped") return [];
  switch (name) {
    case "resolve": {
      const sha = detail?.match(/\bat ([0-9a-f]{7,40})\b/i)?.[1];
      return [{ text: sha ? `Found commit ${sha.slice(0, 7)}` : "Found the commit", tone: null }];
    }
    case "fetch":
      return [{ text: "Fetched the repo", tone: null }];
    case "static": {
      const k = n(detail, /(\d+) scanner finding/);
      if (k === null) return [{ text: "Read the code", tone: null }];
      return [{ text: k === 0 ? "The code scanners found nothing" : `The code scanners flagged ${plural(k, "spot", "spots")}`, tone: k === 0 ? "ok" : "warn" }];
    }
    case "osv": {
      const locked = n(detail, /(\d+) locked/);
      const bad = n(detail, /(\d+) malicious/);
      if (bad && bad > 0) return [{ text: `${plural(bad, "malware record", "malware records")} in ${plural(locked ?? 0, "package", "packages")}`, tone: "bad" }];
      if (locked && locked > 0) return [{ text: `No malware records in ${plural(locked, "package", "packages")}`, tone: "ok" }];
      return [{ text: "No locked packages to look up", tone: null }];
    }
    case "checks":
      return [{ text: "Security questions answered", tone: null }];
    case "detonate": {
      const out: { text: string; tone: LogTone }[] = [];
      const d = detail ?? "";
      if (/install timeout/i.test(d)) out.push({ text: "Install stopped at its time limit", tone: "warn" });
      else if (/install (completed|done|ok)|installed/i.test(d)) out.push({ text: "Installed", tone: null });
      if (/entry skipped/i.test(d)) out.push({ text: "Entry point not run", tone: "warn" });
      else if (/entry (ran|completed|ok)/i.test(d)) out.push({ text: "Ran the entry point", tone: null });
      const calls = n(d, /(\d+) forged call/);
      if (calls !== null) out.push({ text: calls === 0 ? "No outbound calls" : `${plural(calls, "call", "calls")} answered by the forge`, tone: calls === 0 ? "ok" : null });
      if (out.length === 0) out.push({ text: "Install and run finished", tone: null });
      return out;
    }
    case "score": {
      const m = detail?.match(/^(\d+)\s+(.+)$/);
      return [{ text: m ? `Score: ${m[1]}, ${m[2]}` : "Scored", tone: null }];
    }
    case "report":
      return [{ text: "Report written", tone: null }];
    default:
      return [];
  }
}

function checkLine(name: string, ok: boolean, detail: string | undefined): { text: string; tone: LogTone } | null {
  switch (name) {
    case "package_manager": {
      const pm = detail?.match(/^([a-z]+)/i)?.[1];
      return pm ? { text: `Installing with ${pm}`, tone: null } : null;
    }
    case "egress_contained":
      return ok ? { text: "Every outbound call goes to the forge", tone: "ok" } : { text: "Outbound containment check failed", tone: "bad" };
    case "sandbox_killed":
      return { text: "Machine destroyed", tone: null };
    default:
      return null;
  }
}

/** Plain log lines for the events shown so far, deduplicated, in order. */
export function plainLog(events: readonly ScanEvent[]): LogLine[] {
  const out: LogLine[] = [];
  const seen = new Set<string>();
  const push = (e: ScanEvent, l: { text: string; tone: LogTone } | null) => {
    if (!l || seen.has(l.text)) return;
    seen.add(l.text);
    out.push({ at: e.t_ms, text: l.text, tone: l.tone, seq: e.seq });
  };
  for (const e of events) {
    switch (e.type) {
      case "stage": {
        if (e.data.name === "cache" || e.data.name === "persist") break;
        if (e.data.status === "start") {
          if (SHOWN_STARTS.has(e.data.name)) push(e, { text: STAGE_WORD[e.data.name], tone: null });
        } else {
          for (const l of stageDone(e.data.name, e.data.status, e.data.detail)) push(e, l);
        }
        break;
      }
      case "check":
        push(e, checkLine(e.data.name, e.data.ok, e.data.detail));
        break;
      case "forged_call":
        if (!PLUMBING_HOST.test(e.data.host) && e.data.proto !== "dns") push(e, { text: `Call to ${e.data.host} answered by the forge`, tone: "warn" });
        break;
      case "file":
        if (e.data.op === "read_decoy") push(e, { text: "Read a decoy credential file", tone: "bad" });
        break;
      default:
        break;
    }
  }
  return out;
}
