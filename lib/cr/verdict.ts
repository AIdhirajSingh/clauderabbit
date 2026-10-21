/**
 * Verdict display for the 2.0 UI. The verdict word and the score always come
 * from the engine (lib/engine/score.ts verdictFor); this file only decides the
 * tone (green, amber, red) and which board filter a verdict falls under. It never
 * derives a verdict from a score on its own, and it never says "Safe".
 */

export type EngineVerdict = "No threats observed" | "Low risk" | "Caution" | "High risk" | "Malicious";
export type Tone = "ok" | "warn" | "bad";
export type BoardFilter = "all" | "Malicious" | "High risk" | "Caution" | "Low risk";

export const BOARD_FILTERS: { id: BoardFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "Malicious", label: "Malicious" },
  { id: "High risk", label: "High risk" },
  { id: "Caution", label: "Caution" },
  { id: "Low risk", label: "Low risk" },
];

/** Engine verdicts each board filter covers. "No threats observed" is the green end of Low risk. */
export const FILTER_VERDICTS: Record<Exclude<BoardFilter, "all">, EngineVerdict[]> = {
  Malicious: ["Malicious"],
  "High risk": ["High risk"],
  Caution: ["Caution"],
  "Low risk": ["Low risk", "No threats observed"],
};

export function toneOf(verdict: string): Tone {
  if (verdict === "Low risk" || verdict === "No threats observed") return "ok";
  if (verdict === "Caution") return "warn";
  return "bad";
}

export const TONE_STYLE: Record<Tone, { pill: { background: string; color: string }; tile: { background: string; color: string }; dot: string }> = {
  ok: { pill: { background: "var(--ok-tint)", color: "var(--ok-text)" }, tile: { background: "var(--ok-tint)", color: "var(--ok-text)" }, dot: "var(--ok)" },
  warn: { pill: { background: "var(--warn-tint)", color: "var(--warn-text)" }, tile: { background: "var(--warn-tint)", color: "var(--warn-text)" }, dot: "var(--warn)" },
  bad: { pill: { background: "var(--bad-tint)", color: "var(--bad-text)" }, tile: { background: "var(--bad-tint)", color: "var(--bad-text)" }, dot: "var(--bad)" },
};

/** The board's and the result's one-line finding: the top deduction, or "Nothing taken off". */
export function topFinding(breakdown: ReadonlyArray<{ points: number; detail: string; group?: string }> | null | undefined): string {
  const code = (breakdown ?? []).filter((d) => d.points < 0 && d.group !== "reputation");
  if (code.length === 0) return "Nothing taken off";
  const top = [...code].sort((a, b) => a.points - b.points)[0];
  return top ? top.detail : "Nothing taken off";
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d} days ago`;
  return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** "owner/repo" for GitHub, the package name for npm (stored with owner "npm"). */
export function displayName(owner: string, repo: string): { name: string; kind: "gh" | "npm" } {
  if (owner === "npm") return { name: repo, kind: "npm" };
  return { name: `${owner}/${repo}`, kind: "gh" };
}
