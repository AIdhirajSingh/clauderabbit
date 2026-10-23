import type { ReportPayload } from "@/lib/engine/types";

/** The meta description from the real verdict, score and summary, cut on a word near 300 characters. */
export function reportDescription(name: string, p: ReportPayload): string {
  const text = `${name}: ${p.verdict}, ${p.score}/100. ${p.headline || p.summary}`.replace(/\s+/g, " ").trim();
  if (text.length <= 300) return text;
  const cut = text.slice(0, 299);
  const sp = cut.lastIndexOf(" ");
  return `${cut.slice(0, sp > 200 ? sp : 299)}…`;
}
