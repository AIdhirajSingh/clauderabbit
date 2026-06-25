/**
 * Domain types for Claude Rabbit, derived from the Claude Design prototype's
 * data shapes (`design-source/Claude Rabbit.dc.html`, REPOS / LEADERBOARD /
 * ACTIVITY / useCases, lines ~1009–1110 and ~1285–1290).
 *
 * Per CLAUDE.md, reputation signals and code/behavior signals are kept
 * structurally separate: `OwnerHistory` + `Reputation` describe the owner and
 * community; `RiskyItem.kind` distinguishes a behavior/code finding from a
 * reputation ('rep') finding so a report can always tell the user which is
 * which.
 */

/** Severity of a single risky finding. */
export type Severity = "high" | "med" | "low";

/**
 * What kind of signal a risky finding is. `behavior` = observed when run;
 * `code` = found by reading the code; `rep` = a reputation signal (owner/account).
 */
export type RiskKind = "behavior" | "code" | "rep";

/** Status of a single chapter in the live scan log. */
export type LogKind = "ok" | "warn" | "bad";

/** Owner / account history — a reputation signal, kept separate from code behavior. */
export interface OwnerHistory {
  handle: string;
  name: string;
  /** Human-readable account age, e.g. "8 yr 2 mo" or "3 days". */
  age: string;
  established: boolean;
  repos: number;
  note: string;
}

/** Community reputation — a reputation signal, kept separate from code behavior. */
export interface Reputation {
  stars: string;
  forks: string;
  sentiment: string;
  /** Sentiment score 0–100. */
  sentScore: number;
}

/** Top-line repository statistics. */
export interface RepoStats {
  /** Lines of code, formatted (e.g. "14,820"). */
  loc: string;
  packages: number;
  stars: string;
  created: string;
}

/** Per-package safety score with a short note. */
export interface PackageScore {
  name: string;
  score: number;
  note: string;
}

/** A single risky finding — code, behavior, or reputation. */
export interface RiskyItem {
  title: string;
  severity: Severity;
  kind: RiskKind;
  detail: string;
}

/** One chapter of the live scan log (clone, static scan, reputation, etc.). */
export interface LogChapter {
  /** Chapter label, e.g. "Clone", "Static scan", "Dynamic run". */
  ch: string;
  kind: LogKind;
  lines: string[];
}

/** A full safety report for a single repo. */
export interface Report {
  id: string;
  owner: string;
  name: string;
  /** Safety score 0–100. */
  score: number;
  /** One-word verdict, e.g. "Trusted", "Likely safe", "Caution", "Malicious". */
  verdict: string;
  /** Whether this report is served from cache. */
  cached: boolean;
  /** Whether this report involved a deep (dynamic sandbox) run. */
  deep: boolean;
  summary: string;
  ownerHistory: OwnerHistory;
  reputation: Reputation;
  stats: RepoStats;
  packages: PackageScore[];
  risky: RiskyItem[];
  logs: LogChapter[];
}

/** A row on the public dangerous-repos leaderboard. */
export interface LeaderboardEntry {
  owner: string;
  name: string;
  score: number;
  reason: string;
  /** Linked report id, or null when the report is not in this demo set. */
  id: string | null;
}

/** A recent-activity ticker entry on the homepage. */
export interface ActivityEntry {
  owner: string;
  name: string;
  score: number;
  /** Relative timestamp, e.g. "just now", "12s ago". */
  when: string;
}

/** A homepage "use case" card. */
export interface UseCase {
  no: string;
  title: string;
  body: string;
}
