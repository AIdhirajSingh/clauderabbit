/**
 * Burst rate-limit floor for scan requests (DESIGN.md section 4, CLAUDE.md V1
 * scope). There is no daily quota; this only stops a request flood. Counter
 * state lives in Postgres (`check_scan_rate_limit`, migration 20260702000001),
 * so it holds across serverless instances.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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
  /** Set when the limiter RPC failed; the request is let through (fail open) and the reason is reported. */
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

/**
 * Check and count one request. A limiter failure lets the request through
 * (a counter outage never blocks scanning) and returns the reason so the
 * route can log it.
 */
export async function checkRateLimit(db: Pick<SupabaseClient, "rpc">, caller: { userId: string | null; ip: string | null }): Promise<RateLimitDecision> {
  const b = bucketFor(caller);
  try {
    const { data, error } = await db.rpc("check_scan_rate_limit", { p_bucket_key: b.key, p_limit: b.limit, p_window_seconds: b.windowSeconds });
    if (error) return { allowed: true, retryAfter: 0, bucket: b.key, limiterError: error.message };
    const row = (Array.isArray(data) ? data[0] : data) as RpcRow | undefined;
    if (!row || typeof row.allowed !== "boolean") return { allowed: true, retryAfter: 0, bucket: b.key, limiterError: "check_scan_rate_limit returned no row" };
    return { allowed: row.allowed, retryAfter: row.allowed ? 0 : Math.max(1, Number(row.retry_after) || b.windowSeconds), bucket: b.key };
  } catch (err) {
    return { allowed: true, retryAfter: 0, bucket: b.key, limiterError: err instanceof Error ? err.message : String(err) };
  }
}
