/**
 * Report summary reconciliation. The read model writes `summary` BEFORE the score
 * exists (the score is computed afterwards by _shared/scoring.ts), so its prose can
 * contradict the final verdict — e.g. "No malicious intent is observed" on a repo
 * the formula scores 0/100 Malicious. This makes the summary agree with the verdict
 * deterministically, with no extra model call:
 *   1. a lead sentence states the score, the verdict, and the code reasons that
 *      moved it (from the score breakdown — what the code DOES);
 *   2. the model's sentences follow, minus any sentence that contradicts the band.
 * A repo that calls itself a test fixture / demo keeps that sentence: context is
 * fine, only a claim contrary to the verdict is removed.
 */
import type { ScoreDelta } from "./scoring.ts";

const DANGEROUS = new Set(["Malicious", "High risk"]);
const CAUTION = "Caution";
const SAFE = new Set(["Trusted", "Likely safe"]);

/** Claims that the code is harmless — contradict Malicious / High risk / Caution. */
const SAFE_CLAIM =
  /\b((is|are|appears?( to be)?|looks?|seems?) (completely |entirely |perfectly )?(safe|benign|harmless)|poses? (no|little|minimal) (risk|threat)|safe to (use|install|run)|no (security )?(risk|threat)s? (is|are|was|were )?(found|observed|identified|detected))\b/i;

/** Denials of malice — contradict Malicious / High risk only. */
const NO_MALICE =
  /\b(no (malicious|harmful|dangerous|nefarious)\b|not (malicious|harmful|dangerous)\b|nothing (malicious|harmful|dangerous)\b|no (evidence|sign|indication)s? of (malic|harm))/i;

/** Un-negated assertions of malice — contradict Trusted / Likely safe. */
const MALICE_CLAIM =
  /\b((is|are|appears?( to be)?|looks?|seems?) (malicious|dangerous|malware)|contains? malware|exfiltrates)\b/i;
const NEGATION = /\b(no|not|never|without|nor)\b/i;

function contradicts(sentence: string, verdict: string): boolean {
  if (DANGEROUS.has(verdict)) return SAFE_CLAIM.test(sentence) || NO_MALICE.test(sentence);
  if (verdict === CAUTION) return SAFE_CLAIM.test(sentence);
  if (SAFE.has(verdict)) return MALICE_CLAIM.test(sentence) && !NEGATION.test(sentence);
  return false;
}

/** The code reasons that moved the score most (largest penalties first). */
function topReasons(breakdown: ScoreDelta[], max = 3): string[] {
  return breakdown
    .filter((d) => d.group === "code" && d.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, max)
    .map((d) => d.detail.replace(/\s*\.\s*$/, ""));
}

export function reconcileSummary(
  modelSummary: string,
  verdict: string,
  score: number,
  breakdown: ScoreDelta[],
): string {
  const reasons = topReasons(breakdown);
  const lead = reasons.length
    ? `Scored ${score}/100 (${verdict}). What the code does: ${reasons.join("; ")}.`
    : `Scored ${score}/100 (${verdict}). No code signals were flagged on the static read.`;
  const kept = (modelSummary ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !contradicts(s, verdict));
  return [lead, ...kept].join(" ").trim();
}
