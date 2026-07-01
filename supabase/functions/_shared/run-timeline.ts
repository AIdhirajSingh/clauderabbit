/**
 * run-timeline.ts — turn the deep sandbox's REAL streamed run milestones into the
 * persisted log chapters of an escalated report.
 *
 * The /api/deep route streams genuine milestones as the moat works (provision ->
 * build -> run -> capture -> reset) and now POSTs that timeline to attach-forensics
 * alongside the forensic record. This leaf module validates the untrusted array and
 * collapses it into one clean chapter per step, so the cached report's "view logs"
 * shows the COMPLETE real record rather than a 2-line stub.
 *
 * Pure + dependency-free (no Deno/network), so the collapse logic is unit-tested
 * directly (run-timeline.test.ts) without standing up the edge function.
 */

export type LogKind = "ok" | "warn" | "bad";

export interface LogChapter {
  ch: string;
  kind: LogKind;
  lines: string[];
}

/** One streamed stage as received from the deep route (status carried, then dropped). */
export interface IncomingStage {
  ch: string;
  kind?: LogKind;
  lines: string[];
}

// Defense in depth: the caller is runner-key-authorized, but every field is bounded
// so a compromised runner cannot bloat the report row or the rendered log.
export const MAX_TIMELINE_STAGES = 40;
export const MAX_LINES_PER_STAGE = 8;
export const MAX_LINE_LEN = 300;
export const MAX_CHAPTER_LINES = 10;

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Bound and clean an untrusted timeline array from the POST body. */
export function sanitizeTimeline(raw: unknown): IncomingStage[] {
  const out: IncomingStage[] = [];
  for (const item of arr(raw)) {
    if (out.length >= MAX_TIMELINE_STAGES) break;
    const o = obj(item);
    const ch = typeof o.ch === "string" ? o.ch.trim().slice(0, 80) : "";
    if (!ch) continue;
    const kind: LogKind | undefined =
      o.kind === "ok" || o.kind === "warn" || o.kind === "bad" ? o.kind : undefined;
    const lines = arr(o.lines)
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.trim().slice(0, MAX_LINE_LEN))
      .filter((l) => l.length > 0)
      .slice(0, MAX_LINES_PER_STAGE);
    out.push({ ch, kind, lines });
  }
  return out;
}

/**
 * Collapse the streamed stages (which emit an "active" then a "done" event per
 * step) into one chapter per step, in first-seen order: the worst kind wins, lines
 * are unioned and de-duplicated. The "Persist" bookkeeping step is dropped (it is
 * the act of writing THIS very log). Empty in → empty out (a legacy runner that
 * sends no timeline simply contributes no chapters).
 */
export function timelineToChapters(stages: IncomingStage[]): LogChapter[] {
  const rank: Record<LogKind, number> = { ok: 0, warn: 1, bad: 2 };
  const out: LogChapter[] = [];
  const index = new Map<string, number>();
  for (const s of stages) {
    if (/^persist$/i.test(s.ch)) continue;
    const at = index.get(s.ch);
    if (at === undefined) {
      index.set(s.ch, out.length);
      out.push({ ch: s.ch, kind: s.kind ?? "ok", lines: [...s.lines] });
      continue;
    }
    const c = out[at];
    if (!c) continue;
    if (s.kind && rank[s.kind] >= rank[c.kind]) c.kind = s.kind;
    for (const l of s.lines) if (!c.lines.includes(l)) c.lines.push(l);
  }
  return out.map((c) => ({ ...c, lines: c.lines.slice(0, MAX_CHAPTER_LINES) }));
}

/**
 * The chapter names a deep run contributes: the /api/deep milestone ch-names (route
 * `milestone()`) + the initial "Escalate" + the "Sandbox run" outcome chapter.
 * rewriteEscalatedLogs drops any PRE-EXISTING ones before re-appending, so a second
 * attach on the same row (a re-detonation of the same commit) REPLACES the run
 * section instead of compounding it — fixing a duplicate "Sandbox run" that re-attach
 * produced before. Keep in sync with route.ts `milestone()`.
 */
export const DEEP_RUN_CHAPTERS: ReadonlySet<string> = new Set([
  "Escalate",
  "Seal the network",
  "Clone + pin",
  // Current microVM+forge chapter names (route.ts milestone()).
  "Bring up the forge",
  "Boot the microVM",
  "Detonate through the forge",
  "Build under containment",
  "Capture + reset",
  "Compute verdict",
  "Sandbox run",
  // Retired two-VM names — kept so a re-attach still drops chapters from a
  // timeline persisted before the microVM+forge rename.
  "Provision trap host",
  "Provision detonation VM",
  "Run under the sinkhole",
]);

/** True if a persisted chapter came from a deep run (so a re-attach can drop it). */
export function isDeepRunChapter(ch: string): boolean {
  return DEEP_RUN_CHAPTERS.has(ch.trim());
}
