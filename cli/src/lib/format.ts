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

import { Chalk, type ChalkInstance } from "chalk";
import boxen from "boxen";
import type { Report, RiskyItem } from "./types.js";

/**
 * Real terminal styling (chalk), not hand-rolled ANSI codes. `level: 0`
 * fully disables styling for --no-color / non-TTY / NO_COLOR, matching the
 * CLI's own explicit color decision (wantsColor() in index.ts) rather than
 * relying on chalk's independent auto-detection, which could disagree with it.
 */
export interface Palette {
  green: (s: string) => string;
  blue: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

function paletteFor(color: boolean): Palette {
  const c = new Chalk({ level: color ? 3 : 0 });
  return {
    green: (s) => c.green(s),
    blue: (s) => c.blue(s),
    yellow: (s) => c.yellow(s),
    red: (s) => c.red(s),
    dim: (s) => c.dim(s),
    bold: (s) => c.bold(s),
  };
}
export const colorPalette: Palette = paletteFor(true);
export const plainPalette: Palette = paletteFor(false);

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
    return `${base} ClaudeRabbit flagged it as ambiguous enough to escalate, but no forensic record is attached, so a full dynamic run has not been confirmed for this report yet.`;
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
 * real `Report` type: target, score, verdict, reportUrl, reputation, behavior,
 * notVerified. See cli/README.md for the full documented schema.
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

/** boxen only accepts these literal color names — the exact set scoreColor() returns. */
const BOX_BORDER_COLOR: Record<ScoreColor, "green" | "blue" | "yellow" | "red"> = {
  green: "green",
  blue: "blue",
  yellow: "yellow",
  red: "red",
};

/** A colored background "chip" for a severity, e.g. a red HIGH badge. Falls back to a plain bracketed label when color is off. */
function severityBadge(c: ChalkInstance, color: boolean, severity: string): string {
  const label = severityLabel(severity);
  if (!color) return `[${label}]`;
  switch (severity) {
    case "high":
      return c.bgRed.white.bold(` ${label} `);
    case "med":
      return c.bgYellow.black.bold(` ${label} `);
    default:
      return c.bgGray.white.bold(` ${label} `);
  }
}

/** A small dim tag distinguishing static/behavior/reputation findings. */
function kindTag(c: ChalkInstance, color: boolean, kind: string): string {
  const label = kindLabel(kind);
  return color ? c.dim(`(${label})`) : `(${label})`;
}

function sectionHeader(c: ChalkInstance, color: boolean, icon: string, title: string): string {
  return color ? `${c.bold(icon)} ${c.bold.underline(title)}` : `${icon} ${title}`;
}

/** Render a full human-readable report to a string. */
export function toText(
  report: Report,
  siteUrl: string,
  opts: { fresh: boolean; resolvedVia: "github" | "npm"; npmPackage?: string },
  p: Palette,
  color = true,
): string {
  const c = new Chalk({ level: color ? 3 : 0 });
  const ran = ranSandbox(report);
  const behavior = report.risky.filter((r) => r.kind !== "rep");
  const repFindings = report.risky.filter((r) => r.kind === "rep");
  const band = scoreColor(report.score);
  const lines: string[] = [];

  // ── Score / verdict / source, in a clean bordered box colored by the
  // product's fixed score-color logic (green/blue/yellow/red everywhere).
  const boxLines = [
    c.bold(`${report.owner}/${report.name}`) +
      (opts.resolvedVia === "npm" && opts.npmPackage ? c.dim(` (npm: ${opts.npmPackage})`) : ""),
    "",
    `${c.dim("Score")}    ${p.bold(`${report.score}/100`)}  ${c.dim(`(${scoreBandLabel(report.score)})`)}`,
    `${c.dim("Verdict")}  ${c.bold(report.verdict)}`,
    `${c.dim("Source")}   ${opts.fresh ? "fresh scan just run" : "cached report"}${
      report.commit_sha ? c.dim(` @ ${report.commit_sha.slice(0, 12)}`) : ""
    }`,
  ].join("\n");
  lines.push(
    boxen(boxLines, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderStyle: "round",
      ...(color ? { borderColor: BOX_BORDER_COLOR[band] } : {}),
    }),
  );
  lines.push("");

  // ── What was actually verified.
  lines.push(sectionHeader(c, color, "🔎", "What was actually verified"));
  if (ran) {
    lines.push(
      c.green("  ✓ RAN in a hermetic, network-locked-down sandbox that is reimaged after every scan."),
    );
    lines.push(c.dim("    Findings below reflect observed runtime behavior, not just a code read."));
    if (report.forensics?.verdict.attack_egress_intercepted) {
      lines.push(
        c.red.bold("  ✗ The sandbox caught an outbound exfiltration/callback attempt."),
      );
      lines.push(c.red("    Every attempt was intercepted and never reached its real destination."));
    } else {
      lines.push(c.green("  ✓ No malicious behavior, credential access, or outbound exfiltration observed."));
    }
    if (report.forensics?.honesty.possibly_dormant_unverified) {
      lines.push(
        c.yellow("  ⚠ The code may be dormant/conditional (time- or trigger-gated); the run did"),
      );
      lines.push(c.yellow("    not necessarily exercise every code path."));
    }
  } else {
    lines.push(c.dim("  ○ STATIC READ ONLY: static scanners + a model read the source. No dynamic"));
    lines.push(c.dim("    sandbox execution has produced a forensic record for this report."));
    if (report.deep) {
      lines.push(c.yellow("  ⚠ NOTE: flagged as ambiguous enough to escalate, but escalation being"));
      lines.push(c.yellow("    DECIDED is not the sandbox having EXECUTED — no forensic record yet."));
    }
    lines.push(c.dim("  Not verified:"));
    for (const nv of notVerifiedList(false)) lines.push(c.dim(`    · ${nv}`));
  }
  lines.push("");

  // ── Code / behavior findings — always visually separate from reputation.
  lines.push(sectionHeader(c, color, "🧩", "Code / behavior findings"));
  lines.push(c.dim("  (separate from reputation, below)"));
  if (behavior.length === 0) {
    lines.push(c.green("  None flagged."));
  } else {
    for (const it of behavior) {
      lines.push(`  ${severityBadge(c, color, it.severity)} ${kindTag(c, color, it.kind)} ${it.title}`);
      if (it.detail) lines.push(c.dim(`      ${it.detail}`));
    }
  }
  lines.push("");

  // ── Reputation signals — owner/community, kept visibly separate above.
  lines.push(sectionHeader(c, color, "👤", "Reputation signals"));
  lines.push(c.dim("  (owner / community — separate from code behavior, above)"));
  lines.push(
    `  Owner:     ${c.bold(report.ownerHistory.handle)} (${report.ownerHistory.name}) — ${report.ownerHistory.age}, ${
      report.ownerHistory.established ? c.green("established") : c.yellow("not yet long-established")
    }, ${report.ownerHistory.repos} public repos.`,
  );
  lines.push(
    `  Community: ${report.reputation.stars} stars, ${report.reputation.forks} forks${
      report.reputation.sentiment
        ? `, sentiment "${report.reputation.sentiment}" (${report.reputation.sentScore}/100)`
        : ""
    }.`,
  );
  for (const it of repFindings) {
    lines.push(`  ${severityBadge(c, color, it.severity)} ${it.title}`);
    if (it.detail) lines.push(c.dim(`      ${it.detail}`));
  }
  lines.push("");

  // ── Summary.
  lines.push(sectionHeader(c, color, "📋", "Summary"));
  lines.push(`  ${report.summary || "(no summary text returned)"}`);
  lines.push("");
  lines.push(c.dim(`Full report: ${reportUrlFor(siteUrl, report)}`));
  lines.push("");

  return lines.join("\n");
}
