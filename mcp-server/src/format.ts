/**
 * Shape a `Report` into the compact, honest text this server returns from
 * both tools. Per CLAUDE.md:
 *  - never state a bare "Safe" (the underlying `verdict` is already rail-
 *    enforced by `normalizeReport`/`enforceVerdict`, but the surrounding copy
 *    here must not undo that by adding an unqualified "safe" of its own);
 *  - reputation signals (owner/account/stars/sentiment) and code/behavior
 *    signals (what the code does, what running it showed) are always kept in
 *    visibly separate sections;
 *  - the sandbox-ran-vs-static-read distinction is stated honestly: a report
 *    can have `deep: true` (escalation was DECIDED) with no `forensics`
 *    (the sandbox never actually EXECUTED) — this must never be blurred.
 */

import type { Report } from "./types.js";

function scoreBand(score: number): string {
  if (score >= 90) return "green (high/secure)";
  if (score >= 80) return "blue (upper-middle)";
  if (score >= 60) return "yellow (warning)";
  return "red (low/dangerous)";
}

function severityLabel(s: string): string {
  return s === "high" ? "HIGH" : s === "med" ? "MEDIUM" : "LOW";
}

function kindLabel(k: string): string {
  return k === "behavior" ? "Behavior (observed)" : k === "rep" ? "Reputation" : "Code (static)";
}

export interface FormattedReport {
  /** Structured data for programmatic MCP clients. */
  structured: Record<string, unknown>;
  /** Human-readable text for the MCP `content` block. */
  text: string;
}

export function formatReport(report: Report, reportUrl: string, opts: { fresh: boolean }): FormattedReport {
  const ranSandbox = !!report.forensics;
  const escalationDecided = report.deep === true;
  const codeRisky = report.risky.filter((r) => r.kind !== "rep");
  const repRisky = report.risky.filter((r) => r.kind === "rep");

  const lines: string[] = [];
  lines.push(`# ${report.owner}/${report.name} — ClaudeRabbit safety report`);
  lines.push("");
  lines.push(`Score: ${report.score}/100 (${scoreBand(report.score)})`);
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Source: ${opts.fresh ? "fresh scan just run" : "cached report"}${report.commit_sha ? ` @ ${report.commit_sha.slice(0, 12)}` : ""}`);
  lines.push("");

  lines.push("## What was actually verified");
  if (ranSandbox) {
    lines.push(
      "- RAN in a hermetic, network-locked-down sandbox that is reimaged after every scan. The findings below reflect observed runtime behavior, not just a code read.",
    );
    if (report.forensics?.verdict.attack_egress_intercepted) {
      lines.push(
        "- The sandbox caught an outbound exfiltration/callback attempt. Every attempt was intercepted and never reached its real destination (hermetic egress lockdown).",
      );
    } else {
      lines.push("- No malicious behavior, credential access, or outbound exfiltration was observed during the run.");
    }
    if (report.forensics?.honesty.possibly_dormant_unverified) {
      lines.push(
        "- The code may be dormant/conditional (e.g. time- or trigger-gated) — the run did not necessarily exercise every code path.",
      );
    }
  } else {
    lines.push(
      "- STATIC READ ONLY: static scanners + a model read the source. No dynamic sandbox execution has produced a forensic record for this report.",
    );
    if (escalationDecided) {
      lines.push(
        "- NOTE: ClaudeRabbit's fast path flagged this repo as ambiguous enough to escalate to a dynamic sandbox run (`deep: true`), but escalation being DECIDED is not the same as the sandbox having EXECUTED. No forensic record is attached, so a full dynamic run has not been confirmed for this report yet. Call scan again later, or view the full report page, for an updated result.",
      );
    }
    lines.push("- Full runtime behavior (this repo has not been executed in a sandbox for this report)");
    lines.push("- Every conditional and time-triggered code branch");
    lines.push("- Behavior under real credentials");
  }
  lines.push("");

  lines.push("## Code / behavior findings (separate from reputation)");
  if (codeRisky.length === 0) {
    lines.push("- None flagged.");
  } else {
    for (const item of codeRisky) {
      lines.push(`- [${severityLabel(item.severity)}] (${kindLabel(item.kind)}) ${item.title}: ${item.detail}`);
    }
  }
  lines.push("");

  lines.push("## Reputation signals (owner/community — separate from code behavior)");
  lines.push(
    `- Owner: ${report.ownerHistory.handle} (${report.ownerHistory.name}) — account age ${report.ownerHistory.age}, ${report.ownerHistory.established ? "established" : "not yet long-established"}, ${report.ownerHistory.repos} public repos.`,
  );
  lines.push(
    `- Community: ${report.reputation.stars} stars, ${report.reputation.forks} forks${report.reputation.sentiment ? `, sentiment "${report.reputation.sentiment}" (${report.reputation.sentScore}/100)` : ""}.`,
  );
  if (repRisky.length > 0) {
    for (const item of repRisky) {
      lines.push(`- [${severityLabel(item.severity)}] ${item.title}: ${item.detail}`);
    }
  }
  lines.push("");

  lines.push("## Summary");
  lines.push(report.summary || "(no summary text returned)");
  lines.push("");
  lines.push(`Full report: ${reportUrl}`);

  const structured = {
    owner: report.owner,
    repo: report.name,
    score: report.score,
    verdict: report.verdict,
    cached: report.cached,
    escalationDecided,
    sandboxActuallyRan: ranSandbox,
    commitSha: report.commit_sha ?? null,
    reportUrl,
    codeBehaviorFindings: codeRisky,
    reputationSignals: {
      owner: report.ownerHistory,
      community: report.reputation,
      findings: repRisky,
    },
    stats: report.stats,
    packages: report.packages,
    logs: report.logs,
    forensics: report.forensics ?? null,
    summary: report.summary,
  };

  return { structured, text: lines.join("\n") };
}
