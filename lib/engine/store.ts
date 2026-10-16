/**
 * Persistence seam for the engine (DESIGN.md sections 4, 6, 7).
 *
 * The orchestrator talks to storage only through `ScanStore`: the SHA cache,
 * the per-(subject, SHA) running-run dedup, the event log that a database
 * trigger broadcasts on Realtime topic `scan:<run_id>`, the report row the
 * existing pages read, and the daily spend floor. The Supabase implementation
 * (tables `scan_runs`, `scan_events`, `reports`, `scan_budget`, RPC
 * `scan_budget_charge`) lands with the step 5 migrations; tests use an
 * in-memory implementation under tests/support.
 */

import type { OwnerCache } from "./reputation";
import type { ErrorCode, ReportPayload, ScanEvent } from "./types";

export type TargetKind = "github" | "npm" | "tarball";

export interface CachedRun {
  runId: string;
  report: ReportPayload;
  /** The stored events of that run, ordered by seq. */
  events: ScanEvent[];
}

export interface ClaimRequest {
  runId: string;
  targetKind: TargetKind;
  /** `owner/repo`, `npm:<name>` or `tarball:<label>`. */
  subject: string;
  /** Git SHA, or `<version>+<sha512 integrity>` for npm and tarball targets. */
  commitSha: string;
  modelId: string;
  template: string;
}

export type ClaimResult = { status: "claimed"; runId: string } | { status: "running"; runId: string };

/** Everything the reports-table mapping needs (DESIGN.md section 7.3). */
export interface ReportRecord {
  runId: string;
  targetKind: TargetKind;
  subject: string;
  /** `owner_login` / `repo_name` for the existing pages (`npm` + package name for npm). */
  ownerLogin: string;
  repoName: string;
  commitSha: string;
  report: ReportPayload;
  /** Per-surface report fields: dependency list with OSV results, findings, stage chapters. */
  packages: unknown;
  risky: unknown;
  logs: unknown;
  stats: unknown;
}

export interface BudgetCharge {
  sandboxSeconds: number;
  tokens: number;
  capSeconds: number;
  capTokens: number;
}

export interface ScanStore {
  readonly ownerCache: OwnerCache;
  /** Latest completed run for this subject and SHA, with its events. */
  findCached(subject: string, commitSha: string): Promise<CachedRun | null>;
  /** Insert a running row; when one is already running for the same key, return it instead. */
  claimRun(req: ClaimRequest): Promise<ClaimResult>;
  /** Append a batch of events (ordered by seq). */
  appendEvents(events: ScanEvent[]): Promise<void>;
  /** Upsert the report row and link it to the run. */
  saveReport(record: ReportRecord): Promise<void>;
  finishRun(runId: string, result: { status: "done" | "error"; errorCode?: ErrorCode; timings: Record<string, number> }): Promise<void>;
  /**
   * Add usage to today's budget. Returns false when the day is already over a
   * cap (the charge is not applied); a zero charge is a pure check.
   */
  chargeBudget(charge: BudgetCharge): Promise<boolean>;
}
