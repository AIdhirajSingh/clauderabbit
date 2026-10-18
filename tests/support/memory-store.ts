/**
 * Test-only in-memory ScanStore with the same semantics the Supabase store
 * implements: a SHA cache over completed runs, one running run per
 * (subject, SHA), ordered events per run, and a daily budget. Never imported by
 * production code.
 */

import type { CostLedger } from "../../lib/engine/cost.ts";
import type { OwnerCache, OwnerInfo } from "../../lib/engine/reputation.ts";
import type { BudgetCharge, CachedRun, ClaimRequest, ClaimResult, ReportRecord, ScanStore } from "../../lib/engine/store.ts";
import type { ErrorCode, ScanEvent } from "../../lib/engine/types.ts";

interface RunRow extends ClaimRequest {
  status: "running" | "done" | "error";
  errorCode?: ErrorCode;
  finishedAt?: number;
  timings?: Record<string, number>;
  cost?: CostLedger;
}

export class MemoryStore implements ScanStore {
  readonly runs = new Map<string, RunRow>();
  readonly events = new Map<string, ScanEvent[]>();
  readonly reports = new Map<string, ReportRecord>();
  readonly owners = new Map<string, OwnerInfo>();
  budget = { seconds: 0, tokens: 0 };

  readonly ownerCache: OwnerCache = {
    get: async (login) => this.owners.get(login.toLowerCase()) ?? null,
    put: async (info) => {
      this.owners.set(info.login.toLowerCase(), info);
    },
  };

  async findCached(subject: string, commitSha: string): Promise<CachedRun | null> {
    const done = [...this.runs.values()].filter((r) => r.subject === subject && r.commitSha === commitSha && r.status === "done" && this.reports.has(r.runId));
    done.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    const r = done[0];
    if (!r) return null;
    return { runId: r.runId, report: this.reports.get(r.runId)!.report, events: [...(this.events.get(r.runId) ?? [])].sort((a, b) => a.seq - b.seq) };
  }

  async claimRun(req: ClaimRequest): Promise<ClaimResult> {
    const running = [...this.runs.values()].find((r) => r.subject === req.subject && r.commitSha === req.commitSha && r.status === "running");
    if (running) return { status: "running", runId: running.runId };
    this.runs.set(req.runId, { ...req, status: "running" });
    return { status: "claimed", runId: req.runId };
  }

  async appendEvents(events: ScanEvent[]): Promise<void> {
    for (const e of events) {
      const list = this.events.get(e.run_id) ?? [];
      if (list.some((x) => x.seq === e.seq)) throw new Error(`duplicate seq ${e.seq} for ${e.run_id}`);
      list.push(e);
      this.events.set(e.run_id, list);
    }
  }

  async saveReport(record: ReportRecord): Promise<void> {
    this.reports.set(record.runId, record);
  }

  async finishRun(runId: string, result: { status: "done" | "error"; errorCode?: ErrorCode; timings: Record<string, number>; cost?: CostLedger }): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`unknown run ${runId}`);
    r.status = result.status;
    r.finishedAt = Date.now();
    r.timings = result.timings;
    if (result.cost) r.cost = result.cost;
    if (result.errorCode) r.errorCode = result.errorCode;
  }

  async chargeBudget(c: BudgetCharge): Promise<boolean> {
    if (this.budget.seconds >= c.capSeconds || this.budget.tokens >= c.capTokens) return false;
    this.budget.seconds += c.sandboxSeconds;
    this.budget.tokens += c.tokens;
    return true;
  }
}
