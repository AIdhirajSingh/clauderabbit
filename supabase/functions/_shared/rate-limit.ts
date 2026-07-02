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

/** Outcome of a rate-limit check. */
export interface RateLimitResult {
  /** true = allowed to proceed; false = over the limit, block with 429. */
  allowed: boolean;
  /** Seconds until the caller's current window rolls over (for Retry-After). */
  retryAfter: number;
  /** Which bucket tripped ('ip' | 'device'), for logging. Null when allowed. */
  trippedBy: "ip" | "device" | null;
}

/**
 * Derive the trustworthy client IP from a Supabase Edge Function request, or null
 * when none is determinable.
 *
 * Supabase's platform gateway sits in front of every edge function and populates
 * `x-forwarded-for`. XFF is a comma-separated chain where each proxy APPENDS the
 * address it received the connection from. A client can only forge entries on the
 * LEFT (it prepends whatever it likes); it cannot forge the entry the trusted
 * gateway itself appended on the RIGHT. So the last entry — the address our own
 * gateway observed — is the spoof-resistant client identity, and that is what we
 * key the limit on. Taking the first (leftmost) entry, as naive examples do, would
 * let an attacker rotate a fake `X-Forwarded-For: <random>` per request and dodge
 * an IP-based limit entirely; taking the last entry defeats that.
 *
 * `x-real-ip` is used only as a fallback and is likewise gateway-set here.
 *
 * XFF can be absent on some Supabase routes; callers must handle a null IP by
 * falling back to the device-id bucket rather than failing open on all limiting.
 */
export function clientIpFromRequest(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length > 0) {
      // The rightmost hop is the one our trusted gateway saw — not client-forgeable.
      const candidate = parts[parts.length - 1];
      if (isPlausibleIp(candidate)) return candidate;
      // If the tail is malformed, scan right-to-left for the first plausible IP.
      for (let i = parts.length - 1; i >= 0; i--) {
        if (isPlausibleIp(parts[i])) return parts[i];
      }
    }
  }
  const real = req.headers.get("x-real-ip");
  if (real && isPlausibleIp(real.trim())) return real.trim();
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

/**
 * Check the burst limit for a request against BOTH the caller's IP and their
 * device id, whichever trips first. This layering is deliberate:
 *
 *   * IP bucket catches a flood from one host even when it sends no device id
 *     (the CLI/MCP client sends none) or rotates fake device ids.
 *   * Device bucket catches a flood that spoofs/rotates IPs (e.g. behind a large
 *     NAT/proxy pool) but reuses one client fingerprint.
 *
 * At least one bucket must be present. When NEITHER an IP nor a device id is
 * available we fail OPEN (allow) — that only happens on the rare Supabase route
 * with no XFF and a caller sending no device id, and the alternative (blocking
 * every anonymous scan) would break the free-first-scan product rail. This is an
 * accepted, documented gap; the common attack (a scripted loop) always presents
 * an IP via the gateway.
 *
 * A DB error also fails OPEN: the limiter must never take the whole scan endpoint
 * down. The error is logged; a degraded limiter is better than a hard outage.
 */
export async function checkBurstLimit(
  db: SupabaseClient,
  opts: { ip: string | null; deviceIdHash: string | null },
): Promise<RateLimitResult> {
  const buckets: Array<{ kind: "ip" | "device"; key: string }> = [];
  if (opts.ip) buckets.push({ kind: "ip", key: `ip:${opts.ip}` });
  if (opts.deviceIdHash) buckets.push({ kind: "device", key: `dev:${opts.deviceIdHash}` });

  // No identity at all → cannot limit; allow (see doc comment).
  if (buckets.length === 0) {
    return { allowed: true, retryAfter: 0, trippedBy: null };
  }

  let maxRetryAfter = 0;
  for (const bucket of buckets) {
    try {
      const { data, error } = await db.rpc("check_scan_rate_limit", {
        p_bucket_key: bucket.key,
        p_limit: RATE_LIMIT_MAX_REQUESTS,
        p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
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
          : RATE_LIMIT_WINDOW_SECONDS;
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
