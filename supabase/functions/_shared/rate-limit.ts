/**
 * Burst/velocity rate limiting for the public scan endpoint.
 *
 * WHY (the BUG-9 security review): scans are intentionally UNLIMITED — no daily
 * quota — because free unmetered scans are core to the product's growth and the
 * GCP credit covers the model cost. That is preserved. What was missing is
 * DoS/abuse protection: every scan POST triggers a real billed Vertex/Gemini call
 * plus a live GitHub API call on the shared 5000/hr token, with zero throttling.
 * A scripted loop with random owner/repo/deviceId per request could drain both in
 * seconds. This module adds a per-source velocity cap that stops that flood while
 * never tripping on legitimate human or CLI/MCP-agent usage.
 *
 * The counter state lives in Postgres (check_scan_rate_limit), NOT in memory —
 * edge functions are stateless and multi-instance, so an in-process counter would
 * silently fail to limit anything across invocations/instances.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// --- Limit tuning ------------------------------------------------------------
//
// A fixed 60-second window with a generous cap. The numbers are chosen to be an
// order of magnitude above any plausible legitimate burst yet far below what a
// scripted flood needs to be damaging:
//
//   * A human pasting repos scans one every several seconds at most — nowhere
//     near 20/min. A CLI/MCP agent doing occasional real scans is similar; even
//     an agent batch-scanning a handful of dependencies stays well under the cap.
//   * An abusive loop hammers dozens–thousands of requests/second. Capping a
//     single source at 20/min throttles it to <0.34 req/s — the billed model call
//     and the shared GitHub token are protected, and the attacker gains nothing by
//     looping faster.
//
// Cheaper than a token bucket and adequate for V1. Tunable here in one place.
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX_REQUESTS = 20;

// --- Global anonymous circuit breaker ----------------------------------------
//
// The per-source (IP + device) limits above are the first line of defense, but
// per-source keying can be defeated by a caller with a genuine pool of many
// distinct real IPs (a botnet / large proxy pool) — each individual source stays
// under its own cap while the aggregate flood still drains the shared GitHub
// token and the model budget. deviceId is client-supplied and trivially omitted,
// so it is not a backstop for that case either.
//
// So a COARSE system-wide circuit breaker caps total ANONYMOUS (no-deviceId)
// scan traffic to the endpoint, keyed on a single fixed global bucket that does
// NOT depend on trusting any client-controlled identity. It bounds a distributed
// flood even when per-source keying is fully defeated. It is intentionally set an
// order of magnitude above real aggregate anonymous demand for a free tool at
// this stage — it is a flood ceiling, not a usage quota — and it applies ONLY to
// anonymous (no deviceId, no user) requests, so a legitimate logged-in / device-
// identified population is never collectively throttled by other users' floods.
export const GLOBAL_ANON_WINDOW_SECONDS = 60;
export const GLOBAL_ANON_MAX_REQUESTS = 300;
/** The single fixed bucket key for the global anonymous circuit breaker. */
export const GLOBAL_ANON_BUCKET_KEY = "global:anon";

/** Outcome of a rate-limit check. */
export interface RateLimitResult {
  /** true = allowed to proceed; false = over the limit, block with 429. */
  allowed: boolean;
  /** Seconds until the caller's current window rolls over (for Retry-After). */
  retryAfter: number;
  /** Which bucket tripped, for logging. Null when allowed. */
  trippedBy: "ip" | "device" | "global-anon" | null;
}

/**
 * Derive the trustworthy client IP from a Supabase Edge Function request, or null
 * when none is determinable.
 *
 * EMPIRICALLY VERIFIED against the live deployed function on 2026-07-02 (this
 * platform's real topology, NOT assumed). Ten rapid requests from ONE physical
 * client were captured; here is what each candidate signal actually did:
 *
 *   signal              | observed across 10 requests from one machine
 *   --------------------|---------------------------------------------------------
 *   cf-connecting-ip    | CONSTANT   49.36.136.144  (the true client IP)
 *   sb-forwarded-for    | CONSTANT   49.36.136.144  (the true client IP)
 *   x-forwarded-for [0] | CONSTANT   49.36.136.144  (leftmost = true client IP)
 *   x-forwarded-for[-1] | CHURNED    99.82.160.{78,73,76,74,77,50,…}  (rotating
 *                       |            AWS-side Supabase edge/NAT node, NOT the client)
 *   x-real-ip           | ABSENT (null)
 *
 * The full raw XFF on this platform is `49.36.136.144,49.36.136.144,99.82.160.XX`:
 * Cloudflare fronts Supabase's Functions gateway, so the TRUE client IP is on the
 * LEFT and Supabase's own multi-node edge fleet appends a per-request-rotating
 * internal IP on the RIGHT. The previous implementation took the RIGHTMOST entry
 * — believing it was "the hop our trusted gateway saw" — which is WRONG here: that
 * rightmost hop is a different internal node every request, so a real repeat client
 * scattered across a whole /24 of bucket keys and NEVER accumulated a consistent
 * count. A flood that simply omitted deviceId sailed through completely un-limited.
 * (Confirmed live: 85 requests, zero 429s.) The rightmost strategy is only correct
 * for a SINGLE conventional reverse proxy — not for a multi-node edge fleet.
 *
 * Spoof resistance was tested too, and the leftmost/Cloudflare signals hold:
 *   - A client that SET its own `cf-connecting-ip` was REJECTED by Cloudflare
 *     (HTTP-level "error code: 1000") — clients cannot forge it; CF sets it.
 *   - A client that PREPENDED a fake XFF chain (`9.9.9.9, 8.8.8.8, 7.7.7.7`) had
 *     it DISCARDED — Cloudflare rebuilt XFF starting from the real client IP, so
 *     the leftmost entry was still `49.36.136.144`, not the injected value.
 *
 * So the trustworthy client identity is taken in this priority order:
 *   1. `cf-connecting-ip` — Cloudflare-set, un-forgeable, single clean IP.
 *   2. `sb-forwarded-for` — Supabase-set true client IP (fallback if CF header
 *      shape ever changes).
 *   3. `x-forwarded-for` LEFTMOST plausible entry — the true client on this edge,
 *      spoof-resistant because Cloudflare overwrites the whole chain.
 *   4. `x-real-ip` — last resort (absent today, but free to check).
 *
 * Any header can be absent on some route; callers MUST handle a null IP by falling
 * back to the device-id bucket and the global anonymous circuit breaker rather
 * than failing open on all limiting.
 */
export function clientIpFromRequest(req: Request): string | null {
  // 1. Cloudflare's connecting-IP: the strongest signal here (see doc comment).
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && isPlausibleIp(cf.trim())) return cf.trim();

  // 2. Supabase's own forwarded-for: also the true client IP, constant per client.
  const sb = req.headers.get("sb-forwarded-for");
  if (sb) {
    // May itself be a chain; take the leftmost plausible entry.
    const first = firstPlausibleIp(sb);
    if (first) return first;
  }

  // 3. Standard XFF — the LEFTMOST plausible entry is the true client on this
  //    platform (Cloudflare rebuilds the chain from the real client and appends
  //    Supabase's rotating internal nodes on the right).
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = firstPlausibleIp(xff);
    if (first) return first;
  }

  // 4. Last resort.
  const real = req.headers.get("x-real-ip");
  if (real && isPlausibleIp(real.trim())) return real.trim();
  return null;
}

/** Return the leftmost plausible IP in a comma-separated forwarded-for chain, or
 * null. Leftmost = the original client on this edge (see clientIpFromRequest). */
function firstPlausibleIp(chain: string): string | null {
  const parts = chain.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  for (const p of parts) {
    if (isPlausibleIp(p)) return p;
  }
  return null;
}

/** Cheap sanity check: is this an IPv4 or IPv6-ish literal (bounds the key)? */
export function isPlausibleIp(s: string): boolean {
  if (!s || s.length > 45) return false; // max IPv6 textual length
  // IPv4 dotted quad, or anything with a colon (IPv6). Charset-bounded so a bogus
  // value can never widen the DB key or inject anything downstream.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(":")) return true;
  return false;
}

/** One bucket to check: its logging kind, DB key, cap, and window. */
interface BucketCheck {
  kind: "ip" | "device" | "global-anon";
  key: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Check the burst limit for a request against the caller's IP, their device id,
 * AND — for anonymous traffic — a coarse system-wide anonymous circuit breaker,
 * whichever trips first. This layering is deliberate:
 *
 *   * IP bucket catches a flood from one host even when it sends no device id
 *     (the CLI/MCP client sends none) or rotates fake device ids. The IP is now
 *     derived correctly (cf-connecting-ip / leftmost XFF — see clientIpFromRequest
 *     for the empirical reason the previous rightmost-hop derivation was broken).
 *   * Device bucket catches a flood that spoofs/rotates IPs (e.g. behind a large
 *     NAT/proxy pool) but reuses one client fingerprint.
 *   * GLOBAL ANONYMOUS bucket is the honest backstop for the one case the two
 *     per-source buckets cannot bound: a flood spread across a genuine pool of
 *     MANY distinct real IPs while sending NO deviceId. Each source stays under
 *     its own IP cap, but the aggregate is still capped system-wide. It is keyed
 *     on a single fixed bucket that trusts NO client-controlled identity, and it
 *     is applied ONLY to anonymous requests (`isAnonymous`) so a legitimate
 *     logged-in / device-identified population is never collectively throttled by
 *     other users' anonymous floods.
 *
 * When NO per-source identity (neither IP nor device id) is available AND the
 * request is not anonymous-eligible for the global bucket, we fail OPEN (allow) —
 * blocking every such request would break the free-first-scan rail. But note the
 * global anonymous breaker now covers the previously wide-open case (no IP + no
 * device id on an anonymous request), so the endpoint is never left with zero
 * flood protection the way it effectively was before this fix.
 *
 * A DB error also fails OPEN per bucket: the limiter must never take the whole
 * scan endpoint down. The error is logged; a degraded limiter beats a hard outage.
 */
export async function checkBurstLimit(
  db: SupabaseClient,
  opts: { ip: string | null; deviceIdHash: string | null; isAnonymous?: boolean },
): Promise<RateLimitResult> {
  const buckets: BucketCheck[] = [];
  if (opts.ip) {
    buckets.push({
      kind: "ip",
      key: `ip:${opts.ip}`,
      limit: RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    });
  }
  if (opts.deviceIdHash) {
    buckets.push({
      kind: "device",
      key: `dev:${opts.deviceIdHash}`,
      limit: RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    });
  }
  // The global anonymous circuit breaker applies to anonymous traffic: no user
  // session and no device id. This is exactly the flood shape the per-source
  // buckets are weakest against (rotate IPs, send no deviceId), so it is the
  // system-wide ceiling on it.
  if (opts.isAnonymous) {
    buckets.push({
      kind: "global-anon",
      key: GLOBAL_ANON_BUCKET_KEY,
      limit: GLOBAL_ANON_MAX_REQUESTS,
      windowSeconds: GLOBAL_ANON_WINDOW_SECONDS,
    });
  }

  // No bucket at all → cannot limit; allow (see doc comment).
  if (buckets.length === 0) {
    return { allowed: true, retryAfter: 0, trippedBy: null };
  }

  let maxRetryAfter = 0;
  for (const bucket of buckets) {
    try {
      const { data, error } = await db.rpc("check_scan_rate_limit", {
        p_bucket_key: bucket.key,
        p_limit: bucket.limit,
        p_window_seconds: bucket.windowSeconds,
      });
      if (error) {
        // Fail open on a limiter error — never 500 the scan because the counter
        // hiccuped. Log and move on to the next bucket.
        console.error("rate-limit rpc error:", error.message);
        continue;
      }
      // The RPC returns a single row (a table-returning function).
      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.allowed === false) {
        const retryAfter = typeof row.retry_after === "number" && row.retry_after > 0
          ? row.retry_after
          : bucket.windowSeconds;
        return { allowed: false, retryAfter, trippedBy: bucket.kind };
      }
      if (row && typeof row.retry_after === "number") {
        maxRetryAfter = Math.max(maxRetryAfter, row.retry_after);
      }
    } catch (e) {
      console.error(
        "rate-limit check threw:",
        e instanceof Error ? e.message : String(e),
      );
      // Fail open (continue) — a thrown limiter must not break scanning.
    }
  }

  return { allowed: true, retryAfter: maxRetryAfter, trippedBy: null };
}

/**
 * Build the 429 body + headers for a tripped burst limit. Kept here so the shape
 * is consistent and testable. The `Retry-After` header is standard (seconds form).
 */
export function rateLimitedResponseInit(
  retryAfter: number,
): { body: { error: string; retryAfter: number }; headers: Record<string, string> } {
  const secs = Math.max(1, Math.floor(retryAfter));
  return {
    body: {
      error:
        "You're sending scans too quickly. This is a burst limit to protect the " +
        "free service from abuse — please wait a moment and try again. Normal usage " +
        "is never affected.",
      retryAfter: secs,
    },
    headers: { "Retry-After": String(secs) },
  };
}
