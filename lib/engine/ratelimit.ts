/**
 * Burst rate-limit floor for scan requests (DESIGN.md section 4, CLAUDE.md V1
 * scope), and the per-key daily quota on fresh CLI and MCP scans (`checkDailyQuota`).
 * The web app has no daily quota; stored results are free everywhere. Counter
 * state lives in Postgres (`v2.check_scan_rate_limit`, migration
 * 20261016000002), so it holds across serverless instances.
 */

import type { SqlExecutor } from "./db";

/** Per caller (user id when signed in, else client IP): requests per window. */
export const RATE_LIMIT_MAX_REQUESTS = 20;
export const RATE_LIMIT_WINDOW_SECONDS = 60;
/** Shared bucket for every anonymous request without a usable IP. */
export const GLOBAL_ANON_MAX_REQUESTS = 300;
export const GLOBAL_ANON_WINDOW_SECONDS = 60;
export const GLOBAL_ANON_BUCKET_KEY = "global:anon";

export type HeaderSource = { get(name: string): string | null };

/** IPv4 dotted quad or an IPv6 literal, bounded so a header can never widen the key. */
export function isPlausibleIp(s: string): boolean {
  if (!s || s.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");
}

function firstPlausible(chain: string | null): string | null {
  if (!chain) return null;
  for (const part of chain.split(",")) {
    const p = part.trim();
    if (isPlausibleIp(p)) return p;
  }
  return null;
}

/**
 * Client IP on Vercel. Vercel sets `x-vercel-forwarded-for` and `x-real-ip`
 * itself and overwrites any client-supplied `x-forwarded-for`; the leftmost
 * entry of each chain is the connecting client.
 */
export function clientIp(headers: HeaderSource): string | null {
  return firstPlausible(headers.get("x-vercel-forwarded-for")) ?? firstPlausible(headers.get("x-real-ip")) ?? firstPlausible(headers.get("x-forwarded-for"));
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number;
  bucket: string;
  /**
   * Set when the limiter RPC failed. Signed-in callers are let through (the
   * daily budget ledger, which fails closed, still bounds spend); anonymous
   * callers are refused until the limiter answers again.
   */
  limiterError?: string;
}

interface RpcRow {
  allowed: boolean;
  current_count: number;
  retry_after: number;
}

/** Bucket key for a caller: the user id when signed in, else the IP, else the shared anonymous bucket. */
export function bucketFor(caller: { userId: string | null; ip: string | null }): { key: string; limit: number; windowSeconds: number } {
  if (caller.userId) return { key: `user:${caller.userId}`, limit: RATE_LIMIT_MAX_REQUESTS, windowSeconds: RATE_LIMIT_WINDOW_SECONDS };
  if (caller.ip) return { key: `ip:${caller.ip}`, limit: RATE_LIMIT_MAX_REQUESTS, windowSeconds: RATE_LIMIT_WINDOW_SECONDS };
  return { key: GLOBAL_ANON_BUCKET_KEY, limit: GLOBAL_ANON_MAX_REQUESTS, windowSeconds: GLOBAL_ANON_WINDOW_SECONDS };
}

/** Retry-After sent to anonymous callers while the limiter is unavailable. */
export const LIMITER_DOWN_RETRY_SECONDS = 30;

/**
 * Check and count one request. On a limiter failure an anonymous caller is
 * refused (fail closed: an outage must not open unlimited sandbox and model
 * spend), a signed-in caller is let through, and the reason is returned so the
 * route can log it.
 */
export async function checkRateLimit(db: SqlExecutor, caller: { userId: string | null; ip: string | null }): Promise<RateLimitDecision> {
  const b = bucketFor(caller);
  const down = (reason: string): RateLimitDecision =>
    caller.userId
      ? { allowed: true, retryAfter: 0, bucket: b.key, limiterError: reason }
      : { allowed: false, retryAfter: LIMITER_DOWN_RETRY_SECONDS, bucket: b.key, limiterError: reason };
  try {
    const rows = await db.query<RpcRow>("select allowed, current_count, retry_after from v2.check_scan_rate_limit($1, $2::int, $3::int)", [b.key, b.limit, b.windowSeconds]);
    const row = rows[0];
    if (!row || typeof row.allowed !== "boolean") return down("check_scan_rate_limit returned no row");
    return { allowed: row.allowed, retryAfter: row.allowed ? 0 : Math.max(1, Number(row.retry_after) || b.windowSeconds), bucket: b.key };
  } catch (err) {
    return down(err instanceof Error ? err.message : String(err));
  }
}

/** Fresh CLI and MCP scans a signed-in key may start per day (stored results never count). */
export const DAILY_FRESH_SCANS_PER_KEY = 25;
export const DAILY_QUOTA_WINDOW_SECONDS = 86_400;

/**
 * Count one fresh CLI or MCP scan against the caller's key for the day, on the same Postgres counter as the burst
 * limit (bucket `daily:user:<id>`). Fails closed: a counter that cannot answer starts no fresh scan.
 */
export async function checkDailyQuota(db: SqlExecutor, caller: { userId: string | null; ip: string | null }): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const key = caller.userId ? `daily:user:${caller.userId}` : caller.ip ? `daily:ip:${caller.ip}` : "daily:anon";
  const rows = await db.query<RpcRow>("select allowed, current_count, retry_after from v2.check_scan_rate_limit($1, $2::int, $3::int)", [key, DAILY_FRESH_SCANS_PER_KEY, DAILY_QUOTA_WINDOW_SECONDS]);
  const row = rows[0];
  if (!row || typeof row.allowed !== "boolean") return { allowed: false, message: "the daily quota counter returned no row" };
  if (row.allowed) return { allowed: true };
  const hours = Math.max(1, Math.ceil((Number(row.retry_after) || DAILY_QUOTA_WINDOW_SECONDS) / 3600));
  return { allowed: false, message: `this key has used its ${DAILY_FRESH_SCANS_PER_KEY} fresh scans for today; stored reports are still free, and fresh scans open again in about ${hours} h` };
}
