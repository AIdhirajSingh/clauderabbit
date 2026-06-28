/**
 * attach-forensics — the server-side persistence endpoint for the deep-sandbox
 * runner. When `sandbox/run-deep-queue.sh` finishes a genuine detonation it POSTs
 * the forensic record here; this function writes it onto the matching report row
 * via the service-role-only `attach_forensics` RPC, so the report flips to a real
 * "Sandbox run" (its `_ranSandbox` signal becomes true) and the board surfaces the
 * captured geo + the deep-run count.
 *
 * The service key is read from the Supabase-provided `SUPABASE_SECRET_KEYS`
 * (auto-available in the edge runtime per docs/INFRASTRUCTURE.md §3) — it is never
 * handled by the runner or the repo. The caller is authorized by a shared
 * `CR_DEEP_RUNNER_KEY` secret (set with `supabase secrets set`): without it the
 * function fails closed, so a forensic record can only be attached by the trusted
 * runner, never by an anonymous caller fabricating runtime evidence.
 *
 * This is a MACHINE-TO-MACHINE endpoint (curl from the trusted runner). It has no
 * legitimate browser caller, so — unlike the public scan endpoint — it emits NO
 * permissive CORS headers and rejects the preflight, removing any cross-origin
 * browser surface against this service-role write path.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Max bytes we will read for a forensic record before rejecting (DoS guard). */
const MAX_BODY_BYTES = 512 * 1024;

/** JSON Response with NO CORS headers — this endpoint has no browser caller. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Constant-time secret comparison. Both sides are SHA-256-hashed first, so the
 * compare runs over fixed 32-byte digests — it leaks neither the key length nor
 * the position of the first differing byte, defeating timing-based enumeration
 * of CR_DEEP_RUNNER_KEY. (A SHA-256 collision is infeasible, so equal digests
 * imply equal keys.)
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

/** A clean owner/repo segment (no slashes/metacharacters). */
function isSegment(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(v);
}

/**
 * Structural check that a payload is a genuine forensic record, not arbitrary
 * JSON. Mirrors `normalizeForensics`'s `looksLikeRecord` gate: a forensic-record
 * schema OR one of the record's load-bearing sections present as a NON-null
 * object (so `{"verdict": null}` does not slip through and flip _ranSandbox).
 */
function looksLikeForensicRecord(f: unknown): f is Record<string, unknown> {
  if (!f || typeof f !== "object") return false;
  const r = f as Record<string, unknown>;
  const hasSchema =
    typeof r.schema === "string" && r.schema.startsWith("claude-rabbit/forensic-record");
  const hasSection = ["network_intent", "in_vm_behavior", "containment", "verdict"].some(
    (k) => k in r && r[k] !== null && typeof r[k] === "object",
  );
  return hasSchema || hasSection;
}

export async function handler(req: Request): Promise<Response> {
  // No browser caller — refuse the preflight and any non-POST method.
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // Authorize the runner. Fail CLOSED: with no configured key, nobody may attach.
  const runnerKey = Deno.env.get("CR_DEEP_RUNNER_KEY");
  if (!runnerKey) {
    return jsonResponse({ error: "Persistence is not configured (no runner key)." }, 503);
  }
  const presented =
    req.headers.get("x-runner-key") ??
    (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!(await timingSafeEqual(presented, runnerKey))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Cap the body BEFORE parsing so a compromised authorized caller cannot push
  // an arbitrarily large blob into the report row or spike edge-runtime memory.
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

  const b = (body ?? {}) as Record<string, unknown>;
  const owner = b.owner;
  const repo = b.repo;
  const sha = b.sha;
  const forensics = b.forensics;

  if (!isSegment(owner) || !isSegment(repo)) {
    return jsonResponse({ error: "owner and repo must be clean segments" }, 400);
  }
  if (typeof sha !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(sha)) {
    return jsonResponse({ error: "commit sha is required" }, 400);
  }
  if (!looksLikeForensicRecord(forensics)) {
    return jsonResponse({ error: "payload is not a forensic record" }, 422);
  }

  let db: SupabaseClient;
  try {
    db = serviceClient();
  } catch (e) {
    console.error("service client failed:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  const { data, error } = await db.rpc("attach_forensics", {
    p_owner_login: owner,
    p_repo_name: repo,
    p_commit_sha: sha,
    p_forensics: forensics,
  });

  if (error) {
    const msg = error.message || "attach failed";
    const status = /no report|not found/i.test(msg) ? 404 : 500;
    // Log the detail server-side only; return a generic message so DB/schema
    // internals never leak to the caller.
    console.error("attach_forensics RPC failed:", msg);
    return jsonResponse({ error: status === 404 ? "Report not found" : "Attach failed" }, status);
  }

  return jsonResponse({ ok: true, report_id: data ?? null });
}

Deno.serve((req) =>
  handler(req).catch((e) => {
    console.error("attach-forensics unhandled:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Internal error" }, 500);
  })
);
