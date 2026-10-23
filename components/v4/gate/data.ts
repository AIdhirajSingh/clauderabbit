/** Server-only reads for the homepage (app/page.tsx). */
import { cachedLatestReport } from "@/lib/server/report-cache";
import { toneOf } from "@/lib/cr/verdict";

/** What the homepage shows of one real stored report. Every number here comes from the database. */
export interface ShownReport {
  slug: string;
  score: number;
  verdict: string;
  /** The design's pill class for the verdict: p-ok, p-warn or p-bad. */
  pill: "p-ok" | "p-warn" | "p-bad";
  /** Up to two real findings from the report, most severe first. */
  findings: { title: string; severity: string }[];
  /** How many packages the report scored, 0 when none were recorded. */
  installed: number;
}

const RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

/** The latest stored report for owner/repo shaped for the homepage, or null when there is none or the read fails. */
export async function shownReport(owner: string, repo: string): Promise<ShownReport | null> {
  try {
    const r = await cachedLatestReport(owner, repo);
    if (!r || typeof r.score !== "number") return null;
    const findings = [...(r.risky ?? [])]
      .filter((x) => x.kind !== "rep")
      .sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3))
      .slice(0, 2)
      .map((x) => ({ title: x.title, severity: x.severity }));
    return { slug: `${r.owner}/${r.name}`, score: r.score, verdict: r.verdict, pill: `p-${toneOf(r.verdict)}`, findings, installed: r.packages?.length ?? 0 };
  } catch {
    return null;
  }
}

