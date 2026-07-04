/**
 * Formats a `RepoView` (the exact view-model app/[owner]/[repo]/page.tsx and
 * the SPA report screen already render from) into MCP tool response text —
 * so the remote MCP server's output is built from the same source of truth
 * as the web report, not a separately-maintained copy.
 */

import type { RepoView } from "@/lib/report-view";

export function formatReportText(view: RepoView, reportUrl: string, fresh: boolean): string {
  const lines: string[] = [];
  lines.push(`# ${view.owner}/${view.name} — ClaudeRabbit safety report`);
  lines.push("");
  lines.push(`Score: ${view.score}/100 (${view._band})`);
  lines.push(`Verdict: ${view.verdict}`);
  lines.push(`Source: ${fresh ? "fresh scan just run" : "cached report"}${view.commit_sha ? ` @ ${view.commit_sha.slice(0, 12)}` : ""}`);
  lines.push("");

  lines.push("## What was actually verified");
  if (view._ranSandbox) {
    lines.push("- RAN in a hermetic, network-locked-down sandbox reimaged after every scan.");
  } else {
    lines.push("- STATIC READ ONLY: static scanners + a model read the source. No dynamic sandbox execution has produced a forensic record for this report.");
    for (const item of view._notVerified) lines.push(`- ${item}`);
  }
  lines.push("");

  const codeBehavior = view.risky.filter((r) => r.kind !== "rep");
  lines.push("## Code / behavior findings (separate from reputation)");
  if (codeBehavior.length === 0) {
    lines.push("- None flagged.");
  } else {
    for (const r of codeBehavior) lines.push(`- [${r.severity.toUpperCase()}] ${r.title}: ${r.detail}`);
  }
  lines.push("");

  lines.push("## Reputation signals (owner/community — separate from code behavior)");
  lines.push(
    `- Owner: ${view.ownerHistory.handle} (${view.ownerHistory.name}) — account age ${view.ownerHistory.age}, ` +
      `${view.ownerHistory.established ? "established" : "new"}, ${view.ownerHistory.repos} public repos.`,
  );
  lines.push(
    `- Community: ${view.reputation.stars} stars, ${view.reputation.forks} forks, sentiment "${view.reputation.sentiment}" (${view.reputation.sentScore}/100).`,
  );
  lines.push("");

  lines.push("## Summary");
  lines.push(view.summary);
  lines.push("");
  lines.push(`Full report: ${reportUrl}`);

  return lines.join("\n");
}

export function structuredReport(view: RepoView, reportUrl: string, fresh: boolean) {
  return {
    owner: view.owner,
    repo: view.name,
    score: view.score,
    verdict: view.verdict,
    reportUrl,
    fresh,
    escalationDecided: view.deep === true,
    sandboxActuallyRan: view._ranSandbox,
    commitSha: view.commit_sha ?? null,
    codeBehaviorFindings: view.risky
      .filter((r) => r.kind !== "rep")
      .map((r) => ({ title: r.title, severity: r.severity, kind: r.kind, detail: r.detail })),
    reputationSignals: {
      owner: {
        handle: view.ownerHistory.handle,
        name: view.ownerHistory.name,
        age: view.ownerHistory.age,
        established: view.ownerHistory.established,
        repos: view.ownerHistory.repos,
      },
      community: {
        stars: view.reputation.stars,
        forks: view.reputation.forks,
        sentiment: view.reputation.sentiment,
        sentScore: view.reputation.sentScore,
      },
    },
    notVerified: view._notVerified,
    summary: view.summary,
  };
}
