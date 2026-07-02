/**
 * Shape a `Report` into the CLI's two outputs — human-readable text and the
 * `--json` structured object — and centralize the "proceed?" policy that the
 * install wrappers use.
 *
 * Per CLAUDE.md the copy here must obey the product's core rails:
 *  - NEVER state a bare "Safe". The verdict itself is already rail-enforced by
 *    `normalizeReport`/`enforceVerdict`; the copy here never adds an
 *    unqualified "safe" of its own, and always states what was NOT verified.
 *  - Reputation signals (owner/account/stars/sentiment) and code/behavior
 *    signals (what the code does, what running it showed) are kept in visibly
 *    separate sections/fields — never blended.
 *  - The sandbox-ran-vs-static-read distinction is honest: a report can have
 *    `deep: true` (escalation DECIDED) with no `forensics` (the sandbox never
 *    actually EXECUTED). "Did the sandbox run" is keyed off `forensics`, never
 *    off `deep`.
 */

import type { Report, RiskyItem } from "./types.js";

/** ANSI color helpers — only emitted when stdout is a TTY (set by caller). */
export interface Palette {
  green: (s: string) => string;
  blue: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const wrap = (code: number) => (s: string) => `[${code}m${s}[0m`;
export const colorPalette: Palette = {
  green: wrap(32),
  blue: wrap(34),
  yellow: wrap(33),
  red: wrap(31),
  dim: wrap(2),
  bold: wrap(1),
};
const identity = (s: string) => s;
export const plainPalette: Palette = {
  green: identity,
  blue: identity,
  yellow: identity,
  red: identity,
  dim: identity,
  bold: identity,
};

/** Score-color band, matching the product's fixed logic everywhere a score appears. */
export type ScoreColor = "green" | "blue" | "yellow" | "red";
export function scoreColor(score: number): ScoreColor {
  if (score >= 90) return "green"; // high / secure
  if (score >= 80) return "blue"; // upper-middle
  if (score >= 60) return "yellow"; // warning
  return "red"; // low / dangerous
}
export function scoreBandLabel(score: number): string {
  return {
    green: "green (high / secure)",
    blue: "blue (upper-middle)",
    yellow: "yellow (warning)",
    red: "red (low / dangerous)",
  }[scoreColor(score)];
}

function severityLabel(s: string): string {
  return s === "high" ? "HIGH" : s === "med" ? "MEDIUM" : "LOW";
}
function kindLabel(k: string): string {
  return k === "behavior" ? "Behavior (observed)" : k === "rep" ? "Reputation" : "Code (static)";
}

/**
 * The honest "what was NOT verified" list. Mirrors the main app's
 * `report-view.ts` `notVerified()` — an escalated repo that the sandbox
 * genuinely RAN carries no such list (running it is the point, not a caveat);
 * a static read always does.
 */
export function notVerifiedList(ranSandbox: boolean): string[] {
  if (ranSandbox) return [];
  return [
    "Full runtime behavior (this repo was not executed in a sandbox on this pass)",
    "Every conditional and time-triggered branch",
    "Behavior under real credentials (no sandbox was run on this pass)",
  ];
}

/**
 * A single honest one-line hedge/summary describing exactly what was and
 * wasn't verified — used by the install wrappers so an agent or human ALWAYS
 * sees the real caveat before proceeding, never just a green light.
 */
export function honestHedge(report: Report): string {
  const ran = !!report.forensics;
  if (ran) {
    if (report.forensics?.verdict.attack_egress_intercepted) {
      return "Ran in the hermetic sandbox and caught an outbound exfiltration/credential-access attempt (every attempt was intercepted and never reached its destination). This is malware behavior.";
    }
    return "Ran in the hermetic sandbox; no malicious behavior, credential access, or outbound exfiltration was observed during the run.";
  }
  // Static read — never imply the code was executed.
  const base =
    "Static read only (static scanners + a model read the source); this repo was NOT executed in a sandbox on this pass, so this is not a proof of safety.";
  if (report.deep) {
    return `${base} Claude Rabbit flagged it as ambiguous enough to escalate, but no forensic record is attached, so a full dynamic run has not been confirmed for this report yet.`;
  }
  return base;
}

/** Whether the sandbox genuinely executed this repo (honest signal). */
export function ranSandbox(report: Report): boolean {
  return !!report.forensics;
}

/**
 * The proceed policy for the install wrappers. Per the reviewer's concern #1,
 * ONLY a "Trusted" (>=90) verdict may proceed with a brief one-line
 * confirmation; everything else must print the full honest hedge before
 * proceeding, and anything below "Caution" (i.e. High risk / Malicious) is a
 * strong warning the caller should treat as a stop-and-think, never an
 * automatic green light. This never emits a bare "Safe".
 */
export interface ProceedPolicy {
  /** True only for a Trusted (>=90) verdict — the sole "brief confirm" case. */
  trusted: boolean;
  /** True for High risk / Malicious (score < 60) — a strong warning. */
  strongWarning: boolean;
  /** The one-line hedge to print regardless of decision. */
  hedge: string;
}
export function proceedPolicy(report: Report): ProceedPolicy {
  const band = scoreColor(report.score);
  return {
    trusted: band === "green" && report.score >= 90,
    strongWarning: report.score < 60,
    hedge: honestHedge(report),
  };
}

// ─────────────────────────── JSON output ───────────────────────────

/**
 * The `--json` output shape. Field names are chosen to be correct against the
 * real `Report` type AND to satisfy the sibling Claude Code plugin's
 * PreToolUse hook, which reads: target, score, verdict, reportUrl, reputation,
 * behavior, notVerified. See cli/README.md for the full documented schema and
 * the reconciliation note.
 */
export interface ScanJson {
  target: string;
  owner: string;
  repo: string;
  score: number;
  verdict: string;
  scoreColor: ScoreColor;
  reportUrl: string;
  cached: boolean;
  fresh: boolean;
  /** Escalation to the dynamic sandbox was DECIDED (not proof it ran). */
  escalationDecided: boolean;
  /** The sandbox actually EXECUTED the repo and produced a forensic record. */
  sandboxActuallyRan: boolean;
  commitSha: string | null;
  resolvedVia: "github" | "npm";
  npmPackage: string | null;
  /** Code/behavior findings only (kind !== "rep") — kept separate from reputation. */
  behavior: RiskyItem[];
  /** Reputation signals — owner/community, kept separate from code/behavior. */
  reputation: {
    owner: Report["ownerHistory"];
    community: Report["reputation"];
    findings: RiskyItem[];
  };
  /** Honest "what was NOT verified" list (empty when the sandbox genuinely ran). */
  notVerified: string[];
  /** One-line honest hedge — always states what was / wasn't verified. */
  hedge: string;
  summary: string;
  stats: Report["stats"];
  packages: Report["packages"];
  /** The full forensic record, present ONLY when the sandbox actually ran. */
  forensics: Report["forensics"] | null;
  /** Convenience flags for install-hook / agent decision logic. */
  proceed: {
    trusted: boolean;
    strongWarning: boolean;
  };
}

export function reportUrlFor(siteUrl: string, report: Report): string {
  return `${siteUrl}/${report.owner}/${report.name}`;
}

export function toJson(
  report: Report,
  siteUrl: string,
  opts: { fresh: boolean; resolvedVia: "github" | "npm"; npmPackage?: string },
): ScanJson {
  const ran = ranSandbox(report);
  const behavior = report.risky.filter((r) => r.kind !== "rep");
  const repFindings = report.risky.filter((r) => r.kind === "rep");
  const policy = proceedPolicy(report);
  return {
    target: `${report.owner}/${report.name}`,
    owner: report.owner,
    repo: report.name,
    score: report.score,
    verdict: report.verdict,
    scoreColor: scoreColor(report.score),
    reportUrl: reportUrlFor(siteUrl, report),
    cached: report.cached,
    fresh: opts.fresh,
    escalationDecided: report.deep === true,
    sandboxActuallyRan: ran,
    commitSha: report.commit_sha ?? null,
    resolvedVia: opts.resolvedVia,
    npmPackage: opts.npmPackage ?? null,
    behavior,
    reputation: {
      owner: report.ownerHistory,
      community: report.reputation,
      findings: repFindings,
    },
    notVerified: notVerifiedList(ran),
    hedge: policy.hedge,
    summary: report.summary,
    stats: report.stats,
    packages: report.packages,
    forensics: report.forensics ?? null,
    proceed: {
      trusted: policy.trusted,
      strongWarning: policy.strongWarning,
    },
  };
}

// ─────────────────────────── text output ───────────────────────────

function paintScore(p: Palette, score: number): string {
  const s = `${score}/100`;
  switch (scoreColor(score)) {
    case "green":
      return p.green(p.bold(s));
    case "blue":
      return p.blue(p.bold(s));
    case "yellow":
      return p.yellow(p.bold(s));
    case "red":
      return p.red(p.bold(s));
  }
}

/** Render a full human-readable report to a string. */
export function toText(
  report: Report,
  siteUrl: string,
  opts: { fresh: boolean; resolvedVia: "github" | "npm"; npmPackage?: string },
  p: Palette,
): string {
  const ran = ranSandbox(report);
  const behavior = report.risky.filter((r) => r.kind !== "rep");
  const repFindings = report.risky.filter((r) => r.kind === "rep");
  const lines: string[] = [];

  lines.push("");
  lines.push(p.bold(`  ${report.owner}/${report.name} — Claude Rabbit safety report`));
  if (opts.resolvedVia === "npm" && opts.npmPackage) {
    lines.push(p.dim(`  (resolved from npm package "${opts.npmPackage}")`));
  }
  lines.push("");
  lines.push(`  Score:   ${paintScore(p, report.score)}   ${p.dim(scoreBandLabel(report.score))}`);
  lines.push(`  Verdict: ${p.bold(report.verdict)}`);
  lines.push(
    `  Source:  ${opts.fresh ? "fresh scan just run" : "cached report"}${
      report.commit_sha ? ` @ ${report.commit_sha.slice(0, 12)}` : ""
    }`,
  );
  lines.push("");

  lines.push(p.bold("  What was actually verified"));
  if (ran) {
    lines.push(
      "    - RAN in a hermetic, network-locked-down sandbox that is reimaged after every scan.",
    );
    lines.push("      Findings below reflect observed runtime behavior, not just a code read.");
    if (report.forensics?.verdict.attack_egress_intercepted) {
      lines.push(
        p.red(
          "    - The sandbox caught an outbound exfiltration/callback attempt. Every attempt was",
        ),
      );
      lines.push(p.red("      intercepted and never reached its real destination."));
    } else {
      lines.push(
        "    - No malicious behavior, credential access, or outbound exfiltration was observed.",
      );
    }
    if (report.forensics?.honesty.possibly_dormant_unverified) {
      lines.push(
        "    - The code may be dormant/conditional (time- or trigger-gated); the run did not",
      );
      lines.push("      necessarily exercise every code path.");
    }
  } else {
    lines.push(
      p.dim("    - STATIC READ ONLY: static scanners + a model read the source. No dynamic"),
    );
    lines.push(p.dim("      sandbox execution has produced a forensic record for this report."));
    if (report.deep) {
      lines.push(
        p.yellow(
          "    - NOTE: flagged as ambiguous enough to escalate, but escalation being DECIDED is",
        ),
      );
      lines.push(
        p.yellow("      not the sandbox having EXECUTED. No forensic record is attached yet."),
      );
    }
    lines.push(p.dim("    Not verified:"));
    for (const nv of notVerifiedList(false)) lines.push(p.dim(`      - ${nv}`));
  }
  lines.push("");

  lines.push(p.bold("  Code / behavior findings (separate from reputation)"));
  if (behavior.length === 0) {
    lines.push("    - None flagged.");
  } else {
    for (const it of behavior) {
      lines.push(`    - [${severityLabel(it.severity)}] (${kindLabel(it.kind)}) ${it.title}`);
      if (it.detail) lines.push(p.dim(`        ${it.detail}`));
    }
  }
  lines.push("");

  lines.push(p.bold("  Reputation signals (owner / community — separate from code behavior)"));
  lines.push(
    `    - Owner: ${report.ownerHistory.handle} (${report.ownerHistory.name}) — account age ${report.ownerHistory.age}, ${
      report.ownerHistory.established ? "established" : "not yet long-established"
    }, ${report.ownerHistory.repos} public repos.`,
  );
  lines.push(
    `    - Community: ${report.reputation.stars} stars, ${report.reputation.forks} forks${
      report.reputation.sentiment
        ? `, sentiment "${report.reputation.sentiment}" (${report.reputation.sentScore}/100)`
        : ""
    }.`,
  );
  for (const it of repFindings) {
    lines.push(`    - [${severityLabel(it.severity)}] ${it.title}`);
    if (it.detail) lines.push(p.dim(`        ${it.detail}`));
  }
  lines.push("");

  lines.push(p.bold("  Summary"));
  lines.push(`    ${report.summary || "(no summary text returned)"}`);
  lines.push("");
  lines.push(p.dim(`  Full report: ${reportUrlFor(siteUrl, report)}`));
  lines.push("");

  return lines.join("\n");
}
