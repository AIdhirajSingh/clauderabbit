/**
 * deep-queue — the server-side persistence endpoint for the /api/deep dispatch
 * queue. The local sandbox controller POSTs one of three queue operations here as
 * a deep request moves through the queue:
 *
 *   { op: "enqueue",  token, owner, repo, sha }  → records a newly-queued request;
 *                                                  returns its FIFO created_at.
 *   { op: "position", token }                    → returns { ahead, waiting_total }
 *                                                  for an HONEST live "position N of M".
 *   { op: "status",   token, status }            → flips the row's lifecycle state
 *                                                  (active / done / failed / timed_out).
 *
 * The queue table is OBSERVABILITY + FIFO ordering only — the controller's own
 * in-process `inFlight` counter remains the sole arbiter of a free detonation slot
 * (see lib/deep-queue.ts). This function just persists the record via the
 * service-role-only queue RPCs so position/wait reporting and operator visibility
 * are backed by real state.
 *
 * Auth + shape mirror `attach-forensics`: the service key is read from the
 * Supabase-provided env and NEVER handled by the controller or the repo; the
 * caller is authorized by the shared `CR_DEEP_RUNNER_KEY` secret. Without it the
 * function fails closed. This is a MACHINE-TO-MACHINE endpoint with no browser
 * caller, so it emits NO permissive CORS headers.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseQueueOp } from "./ops.ts";

/** Max bytes we will read before rejecting (DoS guard). The bodies are tiny. */
const MAX_BODY_BYTES = 8 * 1024;

/** JSON Response with NO CORS headers — this endpoint has no browser caller. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Constant-time secret comparison over SHA-256 digests (identical to
 * attach-forensics): leaks neither key length nor the first differing byte.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Resolve the service key from the new or legacy Supabase key system (auto-env). */
function resolveServiceKey(): string {
  const roleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (roleKey) return roleKey;
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
      if (typeof parsed === "string") return parsed;
    } catch {
      if (secretKeys.startsWith("sb_secret_")) return secretKeys;
    }
  }
  throw new Error("No service key available (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS)");
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return createClient(url, resolveServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function handler(req: Request): Promise<Response> {
  // No browser caller — refuse the preflight and any non-POST method.
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // Authorize the runner. Fail CLOSED: with no configured key, nobody may touch the queue.
  const runnerKey = Deno.env.get("CR_DEEP_RUNNER_KEY");
  if (!runnerKey) {
    return jsonResponse({ error: "Queue is not configured (no runner key)." }, 503);
  }
  const presented =
    req.headers.get("x-runner-key") ??
    (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!(await timingSafeEqual(presented, runnerKey))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const lenHeader = req.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Payload too large" }, 413);
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse({ error: "Invalid body" }, 400);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Payload too large" }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const parsed = parseQueueOp(body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
  const q = parsed.value;

  let db: SupabaseClient;
  try {
    db = serviceClient();
  } catch (e) {
    console.error("service client failed:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  if (q.op === "enqueue") {
    const { data, error } = await db.rpc("deep_queue_enqueue", {
      p_token: q.token,
      p_owner_login: q.owner,
      p_repo_name: q.repo,
      p_commit_sha: q.sha,
    });
    if (error) {
      console.error("deep_queue_enqueue failed:", error.message);
      return jsonResponse({ error: "Enqueue failed" }, 500);
    }
    // The RPC returns the row's created_at (the authoritative FIFO key).
    return jsonResponse({ ok: true, created_at: data });
  }

  if (q.op === "position") {
    const { data, error } = await db.rpc("deep_queue_position", { p_token: q.token });
    if (error) {
      console.error("deep_queue_position failed:", error.message);
      return jsonResponse({ error: "Position lookup failed" }, 500);
    }
    // SETOF (ahead, waiting_total) — one row.
    const row = Array.isArray(data) ? data[0] : data;
    const ahead = typeof row?.ahead === "number" ? row.ahead : 0;
    const waitingTotal = typeof row?.waiting_total === "number" ? row.waiting_total : 0;
    return jsonResponse({ ok: true, ahead, waiting_total: waitingTotal });
  }

  if (q.op === "status") {
    const { data, error } = await db.rpc("deep_queue_set_status", {
      p_token: q.token,
      p_status: q.status,
    });
    if (error) {
      console.error("deep_queue_set_status failed:", error.message);
      return jsonResponse({ error: "Status update failed" }, 500);
    }
    return jsonResponse({ ok: true, updated: data === true });
  }

  if (q.op === "set_stage") {
    // Called by the Cloud Run execution's own entrypoint — real, granular
    // progress markers (see supabase/migrations/20260703000001_deep_scan_queue_stage.sql).
    const { data, error } = await db.rpc("deep_queue_set_stage", {
      p_token: q.token,
      p_stage: q.stage,
      p_detail: q.detail,
    });
    if (error) {
      console.error("deep_queue_set_stage failed:", error.message);
      return jsonResponse({ error: "Stage update failed" }, 500);
    }
    return jsonResponse({ ok: true, updated: data === true });
  }

  if (q.op === "claim") {
    // Atomic per-(owner,repo,sha) detonation dispatch claim. `claimed: true`
    // means THIS caller won and should dispatch Cloud Run; `false` means another
    // dispatch already holds a fresh claim and the caller must NOT dispatch again.
    const { data, error } = await db.rpc("deep_dispatch_try_claim", {
      p_owner: q.owner,
      p_repo: q.repo,
      p_sha: q.sha,
      p_token: q.token,
    });
    if (error) {
      console.error("deep_dispatch_try_claim failed:", error.message);
      return jsonResponse({ error: "Claim failed" }, 500);
    }
    return jsonResponse({ ok: true, claimed: data === true });
  }

  if (q.op === "release") {
    const { data, error } = await db.rpc("deep_dispatch_release", {
      p_owner: q.owner,
      p_repo: q.repo,
      p_sha: q.sha,
      p_token: q.token,
    });
    if (error) {
      console.error("deep_dispatch_release failed:", error.message);
      return jsonResponse({ error: "Release failed" }, 500);
    }
    return jsonResponse({ ok: true, released: data === true });
  }

  // op === "get_stage" — /api/deep's polling read during the detonation wait.
  const { data, error } = await db.rpc("deep_queue_get_stage", { p_token: q.token });
  if (error) {
    console.error("deep_queue_get_stage failed:", error.message);
    return jsonResponse({ error: "Stage lookup failed" }, 500);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return jsonResponse({
    ok: true,
    stage: row?.current_stage ?? null,
    detail: row?.current_stage_detail ?? null,
    updated_at: row?.updated_at ?? null,
  });
}

Deno.serve((req) =>
  handler(req).catch((e) => {
    console.error("deep-queue unhandled:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Internal error" }, 500);
  })
);
