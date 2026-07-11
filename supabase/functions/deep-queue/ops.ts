/**
 * ops.ts — pure request-shape validation for the deep-queue edge function.
 *
 * The function is a thin, runner-key-gated wrapper over the service-role-only
 * queue RPCs (deep_queue_enqueue / deep_queue_position / deep_queue_set_status).
 * This leaf module validates the untrusted POST body into one of the discrete
 * queue operations WITHOUT touching Deno or the network, so the parsing contract
 * is unit-tested directly (ops.test.ts) — the same discipline as _shared modules.
 */

/** The terminal + lifecycle states the controller may set (must match the SQL enum). */
export const QUEUE_STATUSES = ["queued", "active", "done", "failed", "timed_out"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** A validated queue operation, discriminated by `op`. */
export type QueueOp =
  | { op: "enqueue"; token: string; owner: string; repo: string; sha: string }
  | { op: "position"; token: string }
  | { op: "status"; token: string; status: QueueStatus }
  | { op: "set_stage"; token: string; stage: string; detail: string }
  | { op: "get_stage"; token: string }
  // Atomic per-(owner,repo,sha) detonation dispatch lock (dedups /api/deep across
  // Vercel instances — see supabase/migrations/20260711000001_deep_dispatch_lock.sql).
  | { op: "claim"; token: string; owner: string; repo: string; sha: string }
  | { op: "release"; token: string; owner: string; repo: string; sha: string };

/** A clean, VM-name-safe token: the route's buildSlug charset. */
export function isToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(v);
}

/** A clean owner/repo segment (no slashes/metacharacters). Mirrors attach-forensics. */
export function isSegment(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(v);
}

/** A clean commit sha. Mirrors attach-forensics' sha charset. */
export function isSha(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(v);
}

/** A valid lifecycle status. */
export function isStatus(v: unknown): v is QueueStatus {
  return typeof v === "string" && (QUEUE_STATUSES as readonly string[]).includes(v);
}

/** A real stage marker name — short, machine-readable, from a fixed vocabulary
 * the entrypoint and the client both know (see app/api/deep/route.ts's
 * STAGE_LABELS for the human-facing text each one maps to).
 *
 * Deliberately ONE "agents_exploring" stage, not three sequential per-agent
 * stages — the install-time/runtime/payload agents run CONCURRENTLY
 * (parallel_agents.py), so reporting them as sequential steps would overclaim
 * an ordering that doesn't exist, the same honesty standard the verdict/score
 * rails already hold everywhere else. */
export const STAGES = [
  "container_start",
  "cloning",
  "installing",
  "building",
  "agents_exploring",
  "running",
  "assembling_forensics",
  "persisting",
] as const;
export type Stage = (typeof STAGES)[number];

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

/** A short, real, freeform detail string (the actual package manager detected,
 * which agent started, etc.) — bounded so a compromised runner can't smuggle
 * an oversized payload through a "detail" field. */
export function isStageDetail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 200;
}

/**
 * Validate a parsed POST body into a `QueueOp`, or return an error string. Every
 * field is strictly charset-checked so a compromised runner cannot inject through
 * the token/owner/repo/sha into the DB layer.
 */
export function parseQueueOp(body: unknown): { ok: true; value: QueueOp } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const op = b.op;

  if (op === "enqueue") {
    if (!isToken(b.token)) return { ok: false, error: "invalid token" };
    if (!isSegment(b.owner)) return { ok: false, error: "invalid owner" };
    if (!isSegment(b.repo)) return { ok: false, error: "invalid repo" };
    if (!isSha(b.sha)) return { ok: false, error: "invalid sha" };
    return { ok: true, value: { op: "enqueue", token: b.token, owner: b.owner, repo: b.repo, sha: b.sha } };
  }
  if (op === "position") {
    if (!isToken(b.token)) return { ok: false, error: "invalid token" };
    return { ok: true, value: { op: "position", token: b.token } };
  }
  if (op === "status") {
    if (!isToken(b.token)) return { ok: false, error: "invalid token" };
    if (!isStatus(b.status)) return { ok: false, error: "invalid status" };
    return { ok: true, value: { op: "status", token: b.token, status: b.status } };
  }
  if (op === "set_stage") {
    if (!isToken(b.token)) return { ok: false, error: "invalid token" };
    if (!isStage(b.stage)) return { ok: false, error: "invalid stage" };
    if (!isStageDetail(b.detail)) return { ok: false, error: "invalid detail" };
    return { ok: true, value: { op: "set_stage", token: b.token, stage: b.stage, detail: b.detail } };
  }
  if (op === "get_stage") {
    if (!isToken(b.token)) return { ok: false, error: "invalid token" };
    return { ok: true, value: { op: "get_stage", token: b.token } };
  }
  // claim / release share enqueue's exact (token, owner, repo, sha) shape — the
  // (owner, repo, sha) is the lock identity, the token is the claim holder.
  if (op === "claim" || op === "release") {
    if (!isToken(b.token)) return { ok: false, error: "invalid token" };
    if (!isSegment(b.owner)) return { ok: false, error: "invalid owner" };
    if (!isSegment(b.repo)) return { ok: false, error: "invalid repo" };
    if (!isSha(b.sha)) return { ok: false, error: "invalid sha" };
    return { ok: true, value: { op, token: b.token, owner: b.owner, repo: b.repo, sha: b.sha } };
  }
  return { ok: false, error: "unknown op" };
}
