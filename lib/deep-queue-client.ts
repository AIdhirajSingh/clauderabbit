/**
 * deep-queue-client.ts — the /api/deep route's thin, best-effort client for the
 * `deep-queue` edge function (which persists the queue table via service-role RPCs).
 *
 * These calls are for OBSERVABILITY and honest post-hoc reporting only. FIFO
 * ordering and slot admission are decided in-process (lib/deep-queue.ts +
 * the route's `inFlight` counter) and NEVER depend on these round-trips. So every
 * call here FAILS SOFT: a DB/network error is swallowed (logged server-side) and
 * the queue keeps working correctly off in-process state. The one call that returns
 * data — `position` — degrades to null on failure, and the route then falls back to
 * the in-process standing for the user-facing "position N of M".
 *
 * Auth mirrors the forensics attach: anon key for the Functions gateway + the
 * `CR_DEEP_RUNNER_KEY` for the function's own auth. No secret is handled here.
 */

import type { QueueStatus } from "@/lib/deep-queue";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const RUNNER_KEY = process.env.CR_DEEP_RUNNER_KEY ?? "";

/** The live position record read back from the DB. */
export interface QueuePosition {
  ahead: number;
  waitingTotal: number;
}

function queueUrl(): string | null {
  if (!SUPABASE_URL) return null;
  return `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/deep-queue`;
}

/** Common headers: gateway anon + function runner-key auth. */
function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    "x-runner-key": RUNNER_KEY,
  };
}

/** POST a queue op, returning the parsed JSON or null on any failure. Never throws. */
async function post(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const url = queueUrl();
  if (!url || !RUNNER_KEY) return null;
  try {
    const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(payload) });
    if (!res.ok) {
      // Best-effort: log server-side, never surface to the queue logic.
      const txt = await res.text().catch(() => "");
      console.error(`deep-queue ${payload.op} ${res.status}: ${txt.slice(0, 160)}`);
      return null;
    }
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch (e) {
    console.error(`deep-queue ${payload.op} request failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Record a newly-queued request (observability). Fire-and-forget; never throws. */
export async function enqueueRow(args: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
}): Promise<void> {
  await post({ op: "enqueue", token: args.token, owner: args.owner, repo: args.repo, sha: args.sha });
}

/**
 * Read this token's live DB position, or null when the DB is unavailable (the
 * route then uses the in-process standing so the emitted position is still real).
 */
export async function fetchPosition(token: string): Promise<QueuePosition | null> {
  const data = await post({ op: "position", token });
  if (!data) return null;
  const ahead = typeof data.ahead === "number" ? data.ahead : null;
  const waitingTotal = typeof data.waiting_total === "number" ? data.waiting_total : null;
  if (ahead === null || waitingTotal === null) return null;
  return { ahead, waitingTotal };
}

/** Flip the row's lifecycle status (active/done/failed/timed_out). Never throws. */
export async function setStatus(token: string, status: QueueStatus): Promise<void> {
  await post({ op: "status", token, status });
}

/**
 * Atomically claim the detonation of one commit (dedups /api/deep dispatch across
 * Vercel instances — see supabase/migrations/20260711000001_deep_dispatch_lock.sql).
 * Returns true ONLY when this caller won the claim and should dispatch Cloud Run.
 *
 * Fails CLOSED — unlike the observability calls above, this returns `false` (do
 * NOT dispatch) on ANY failure (misconfig, DB/network error, a non-true result).
 * That is deliberate and load-bearing: this call is the sole thing preventing the
 * duplicate-detonation flood, so a hiccup must never silently re-open it. The
 * caller then just polls the report row for the in-flight run's forensics instead
 * of starting a second execution; if nothing is actually running, that honestly
 * degrades to a static-only result the user can retry — never a false success.
 */
export async function tryClaimDispatch(args: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
}): Promise<boolean> {
  const data = await post({ op: "claim", token: args.token, owner: args.owner, repo: args.repo, sha: args.sha });
  return data?.claimed === true;
}

/**
 * Release a detonation claim when the run truly concludes (forensics attached, or
 * a hard dispatch failure that should allow an immediate retry). Best-effort;
 * never throws. Deliberately NOT called on the streaming-deadline "pending" path —
 * there the detonation is still running, so the claim must persist (TTL-bounded)
 * to keep deduping re-requests during the run's tail.
 */
export async function releaseDispatch(args: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
}): Promise<void> {
  await post({ op: "release", token: args.token, owner: args.owner, repo: args.repo, sha: args.sha });
}

/** The real, granular progress marker read back from the DB (or null fields
 * when the execution hasn't reported one yet). */
export interface QueueStage {
  stage: string | null;
  detail: string | null;
  updatedAt: string | null;
}

/**
 * Read this token's live stage marker — the granular processing-timeline
 * feature's polling read, called from /api/deep DURING the detonation wait
 * (not just after). Never throws; a DB hiccup just means one missed tick, the
 * next poll tries again.
 */
export async function fetchStage(token: string): Promise<QueueStage | null> {
  const data = await post({ op: "get_stage", token });
  if (!data) return null;
  return {
    stage: typeof data.stage === "string" ? data.stage : null,
    detail: typeof data.detail === "string" ? data.detail : null,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}
