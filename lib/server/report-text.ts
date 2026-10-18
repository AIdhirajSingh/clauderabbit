/**
 * Plain-text rendering of a final scan line for the remote MCP tool
 * (DESIGN.md section 8.2): verdict, score, what was observed, what was not
 * verified, the report URL and the ad. Never a bare "Safe".
 */

import { adText } from "../engine/ads";
import type { FinalLine } from "./scan-service";

export function finalLineText(final: FinalLine): string {
  if (final.type === "error") {
    const lines = [`ClaudeRabbit scan failed (${final.code}): ${final.message}`];
    if (final.signInUrl) lines.push(`Sign in: ${final.signInUrl}`);
    lines.push("", adText(final.ad));
    return lines.join("\n");
  }
  const r = final.report;
  const lines: string[] = [];
  lines.push(`ClaudeRabbit: ${r.target} at ${r.commit_sha.slice(0, 40)}`);
  lines.push(`Verdict: ${r.verdict} (score ${r.score}/100)${final.outcome === "cached" ? " [cached report for this exact commit]" : ""}`);
  if (r.headline) lines.push(r.headline);
  if (r.summary) lines.push("", r.summary);
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", `${title}:`);
    for (const i of items.slice(0, 12)) lines.push(`- ${i}`);
  };
  section("Observed when the code ran (behaviour)", r.evidence.behaviour);
  section("Found in the code (static scanners and Jev checks)", r.evidence.code);
  section("Reputation signals (separate from code and behaviour)", r.evidence.reputation);
  section("Not verified", r.not_verified);
  lines.push("", `Full report: ${final.report_url}`);
  lines.push("", adText(final.ad));
  return lines.join("\n");
}

/** Structured content for MCP clients that read it. */
export function finalLineStructured(final: FinalLine): Record<string, unknown> {
  if (final.type === "error") return { ok: false, code: final.code, message: final.message, ad: final.ad };
  const r = final.report;
  return {
    ok: true,
    outcome: final.outcome,
    runId: final.run_id,
    target: r.target,
    commitSha: r.commit_sha,
    score: r.score,
    verdict: r.verdict,
    band: r.band,
    headline: r.headline,
    evidence: r.evidence,
    notVerified: r.not_verified,
    reportUrl: final.report_url,
    ad: final.ad,
  };
}
