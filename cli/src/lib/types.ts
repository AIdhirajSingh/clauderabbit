/**
 * Minimal, standalone mirror of the ClaudeRabbit `Report` shape this CLI
 * needs (see the main app's `lib/types.ts`). Reimplemented here rather than
 * imported because `cli/` is a fully separate package with no dependency on
 * the Next.js app's `lib/`. Fields not used by this CLI's output are typed
 * loosely (`unknown`) rather than omitted, so an unexpected upstream shape
 * does not throw — see `normalizeReport`.
 *
 * This mirrors the shape the (production-verified) `mcp-server/` package uses,
 * so the CLI and the MCP server never disagree about the same repo.
 */

export type Severity = "high" | "med" | "low";
export type RiskKind = "behavior" | "code" | "rep";

export interface OwnerHistory {
  handle: string;
  name: string;
  age: string;
  established: boolean;
  repos: number;
  note: string;
}

export interface Reputation {
  stars: string;
  forks: string;
  sentiment: string;
  sentScore: number;
}

export interface RepoStats {
  loc: string;
  packages: number;
  stars: string;
  created: string;
}

export interface PackageScore {
  name: string;
  score: number;
  note: string;
}

export interface RiskyItem {
  title: string;
  severity: Severity;
  kind: RiskKind;
  detail: string;
}

export interface LogChapter {
  ch: string;
  kind: "ok" | "warn" | "bad";
  lines: string[];
}

export interface ForensicsHonesty {
  possibly_dormant_unverified: boolean;
  notes: string[];
}

export interface ForensicsVerdict {
  dynamic_score: number;
  one_word: string;
  headline: string;
  attack_egress_intercepted: boolean;
  not_verified: string[];
}

/**
 * The dynamic sandbox forensic record. Its mere PRESENCE on a report is the
 * honest signal that the sandbox actually executed the repo — the `deep` /
 * `scan_path` fields on the report only record that escalation was DECIDED,
 * not that a detonation ran (see the main app's `lib/report-view.ts`, the
 * `_ranSandbox` derivation). This CLI must never conflate the two.
 */
export interface Forensics {
  verdict: ForensicsVerdict;
  honesty: ForensicsHonesty;
  [key: string]: unknown;
}

/** A ClaudeRabbit safety report for a single repo. */
export interface Report {
  id: string;
  owner: string;
  name: string;
  score: number;
  verdict: string;
  cached: boolean;
  /** True only when escalation to the dynamic sandbox was DECIDED — see `forensics`. */
  deep: boolean;
  summary: string;
  ownerHistory: OwnerHistory;
  reputation: Reputation;
  stats: RepoStats;
  packages: PackageScore[];
  risky: RiskyItem[];
  logs: LogChapter[];
  /** Present ONLY when the dynamic sandbox actually ran and produced a record. */
  forensics?: Forensics;
  commit_sha?: string;
}
