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
  | { op: "status"; token: string; status: QueueStatus };

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
  return { ok: false, error: "unknown op" };
}
