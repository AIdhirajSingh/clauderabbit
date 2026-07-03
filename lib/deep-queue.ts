/**
 * deep-queue.ts — the pure, in-process FIFO authority for /api/deep dispatch.
 *
 * /api/deep detonates unknown repos as ephemeral Cloud Run Job executions, each
 * routing its egress through the ONE shared NVA gateway VM (cr-forge-gateway) —
 * that gateway, not the detonation compute itself, is the real bottleneck this
 * controller throttles against, capped at MAX_CONCURRENT simultaneous
 * detonations (see app/api/deep/route.ts and docs/INFRASTRUCTURE.md for the
 * real, measured concurrency proof this cap is tuned against). When all slots
 * are busy, a further request no longer gets a flat 429 — it QUEUES and waits
 * its turn. This module is the ordering + position + wait-estimate + timeout
 * brain for that queue.
 *
 * WHY IN-PROCESS IS THE AUTHORITY:
 *   /api/deep only ever runs on a single local controller Node process (Vercel
 *   deploys have it inert), and the existing `inFlight` counter there is already a
 *   correct, race-free arbiter of "is a slot actually free" for one process. So
 *   FIFO ordering must ALSO be a single-process, synchronous fact — never a DB
 *   round-trip whose latency could let a later arrival jump an earlier waiter, or
 *   whose unavailability could stall the queue. This registry is that fact: an
 *   ordered list of waiter tokens, mutated synchronously. The `deep_scan_queue`
 *   table mirrors it for OBSERVABILITY and honest position reporting only.
 *
 * Pure + dependency-free (no I/O, no timers, no Next/Deno) so every ordering,
 * position, estimate, and timeout decision is unit-tested directly.
 */

/** The lifecycle states the queue row can hold (must match the SQL enum). */
export type QueueStatus = "queued" | "active" | "done" | "failed" | "timed_out";

/** A waiter's live standing in the queue. All fields are derived from real state. */
export interface QueueStanding {
  /** Still-`queued` rows AHEAD of this one (0 == next in line). */
  ahead: number;
  /** Total still-waiting entries, including this one (for "position N of M"). */
  waitingTotal: number;
  /** 1-based human position ("position 1 of 3"): ahead + 1. */
  position: number;
}

/**
 * A single in-process FIFO queue of deep-scan waiters. One instance is shared by
 * the /api/deep route for the lifetime of the controller process (module-level
 * singleton below). Ordering is insertion order; a token is removed the instant it
 * acquires a slot, times out, or the client disconnects.
 */
export class DeepScanQueue {
  /** Waiter tokens in strict arrival order; index 0 is the oldest still-waiting. */
  private waiters: string[] = [];

  /** Append a token to the tail. Idempotent: a re-enqueue of a present token is a no-op. */
  enqueue(token: string): void {
    if (!this.waiters.includes(token)) this.waiters.push(token);
  }

  /** Remove a token from the queue (on acquire / timeout / disconnect). */
  remove(token: string): void {
    const i = this.waiters.indexOf(token);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  /** True if the token is still waiting in the queue. */
  has(token: string): boolean {
    return this.waiters.includes(token);
  }

  /** Total number of waiters currently in the queue. */
  size(): number {
    return this.waiters.length;
  }

  /** The oldest waiting token (next in line), or null when the queue is empty. */
  head(): string | null {
    return this.waiters[0] ?? null;
  }

  /**
   * This token's live standing: how many are ahead, the waiting total, and the
   * 1-based position. A token not in the queue reports `ahead: -1` / `position: 0`
   * so callers can distinguish "not waiting" from "next in line" (ahead 0).
   */
  standing(token: string): QueueStanding {
    const idx = this.waiters.indexOf(token);
    const waitingTotal = this.waiters.length;
    if (idx < 0) return { ahead: -1, waitingTotal, position: 0 };
    return { ahead: idx, waitingTotal, position: idx + 1 };
  }

  /**
   * Strict-FIFO admission test — the ONE rule that guarantees a later arrival can
   * never take a freed slot ahead of an earlier waiter: a token may acquire a slot
   * IFF it is the head of the queue (the oldest still-waiting) AND a slot is
   * genuinely free in the caller's authoritative `inFlight` counter.
   *
   * The route calls this on each poll tick; only when it returns true does it
   * atomically increment `inFlight` and dequeue this token.
   */
  canAcquire(token: string, inFlight: number, maxConcurrent: number): boolean {
    return this.head() === token && inFlight < maxConcurrent;
  }
}

/**
 * Estimated wait in milliseconds for a waiter, from real state:
 *   ceil((ahead + 1) / slots) * perDetonationMs
 * i.e. how many detonation "rounds" of `slots` parallel runs must clear before
 * this waiter's own round starts. `ahead` is the number of waiters ahead of it
 * (0 == next in line, so it waits at most one round for a slot to free).
 *
 * perDetonationMs is grounded in a REAL measured detonation (~76s on the 4-vCPU
 * host per docs/runs/2026-07-01-host-restart-and-concurrency.md); the route
 * passes a slightly conservative value to account for attach + reset overhead.
 */
export function estimateWaitMs(
  ahead: number,
  slots: number,
  perDetonationMs: number,
): number {
  if (ahead < 0) return 0; // not waiting
  const safeSlots = Math.max(1, slots);
  const rounds = Math.ceil((ahead + 1) / safeSlots);
  return rounds * perDetonationMs;
}

/** Format an estimated-wait in ms as a short human string ("~3 min", "~40 sec"). */
export function formatWait(ms: number): string {
  if (ms <= 0) return "under a minute";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `~${totalSec} sec`;
  const min = Math.round(totalSec / 60);
  return `~${min} min`;
}

/**
 * The honest queue line shown to the user, e.g.
 *   "Queued — position 2 of 3, ~3 min estimated wait".
 * Position is 1-based; the estimate comes from `estimateWaitMs`/`formatWait`.
 */
export function queueLine(
  standing: QueueStanding,
  slots: number,
  perDetonationMs: number,
): string {
  const wait = formatWait(estimateWaitMs(standing.ahead, slots, perDetonationMs));
  return `Queued — position ${standing.position} of ${standing.waitingTotal}, ${wait} estimated wait`;
}

/**
 * Has this waiter exceeded its max-wait deadline? Pure so the timeout path is
 * unit-testable without real clocks/timers — the route passes Date.now().
 * `startedAt` is when the request was first queued.
 */
export function isExpired(startedAt: number, now: number, deadlineMs: number): boolean {
  return now - startedAt >= deadlineMs;
}

// ── module-level singleton ──────────────────────────────────────────────────
// One queue shared across all /api/deep invocations in this controller process.
// (A fresh DeepScanQueue is used directly in unit tests; the route uses this.)
export const deepScanQueue = new DeepScanQueue();
