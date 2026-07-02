/**
 * Unit tests for the burst/velocity rate limiter (rate-limit.ts).
 *
 * Run: `deno test supabase/functions/_shared/rate-limit.test.ts`
 *
 * These lock in the BUG-9 security-review behavior:
 *   - the trustworthy client IP is the gateway-appended (RIGHTMOST) x-forwarded-for
 *     entry, so a client prepending a fake IP per request cannot dodge the limit;
 *   - checkBurstLimit TRIPS after exactly RATE_LIMIT_MAX_REQUESTS in a window and
 *     returns a Retry-After, then ALLOWS again once the window rolls over;
 *   - the IP bucket and the device bucket each independently catch a flood;
 *   - it FAILS OPEN when no identity is derivable and when the DB errors, so it can
 *     never take the scan endpoint down or block the free first scan.
 *
 * The DB is a faithful in-test double of the Postgres check_scan_rate_limit()
 * function: a fixed tumbling window keyed by bucket, atomic increment, and
 * allowed = (count <= limit). The window clock is injectable so a window rollover
 * can be simulated deterministically without sleeping.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkBurstLimit,
  clientIpFromRequest,
  isPlausibleIp,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  rateLimitedResponseInit,
} from "./rate-limit.ts";

// --- Fake DB: mirrors the SQL check_scan_rate_limit semantics ----------------

interface FakeClock {
  now: number; // epoch seconds
}

/**
 * Build a fake SupabaseClient whose `.rpc("check_scan_rate_limit", …)` reproduces
 * the migration's window-counter logic. `clock.now` (epoch seconds) is advanced by
 * tests to simulate window rollover. `failNext` forces an error to prove fail-open.
 */
function fakeDb(clock: FakeClock, failNext = false): SupabaseClient {
  const counters = new Map<string, { windowStart: number; count: number }>();
  let shouldFail = failNext;

  const rpc = (
    _fn: string,
    args: { p_bucket_key: string; p_limit: number; p_window_seconds: number },
  ) => {
    if (shouldFail) {
      shouldFail = false;
      return Promise.resolve({ data: null, error: { message: "simulated db error" } });
    }
    const { p_bucket_key, p_limit, p_window_seconds } = args;
    const windowStart = Math.floor(clock.now / p_window_seconds) * p_window_seconds;
    const nextWindow = windowStart + p_window_seconds;

    const existing = counters.get(p_bucket_key);
    let count: number;
    if (existing && existing.windowStart === windowStart) {
      count = existing.count + 1;
    } else {
      count = 1; // new window (or first request) resets the counter
    }
    counters.set(p_bucket_key, { windowStart, count });

    const retryAfter = Math.max(1, Math.ceil(nextWindow - clock.now));
    return Promise.resolve({
      data: [{ allowed: count <= p_limit, current_count: count, retry_after: retryAfter }],
      error: null,
    });
  };

  return { rpc } as unknown as SupabaseClient;
}

// --- clientIpFromRequest / isPlausibleIp -------------------------------------

Deno.test("isPlausibleIp accepts IPv4 and IPv6, rejects junk", () => {
  assert(isPlausibleIp("203.0.113.9"));
  assert(isPlausibleIp("2001:db8::1"));
  assertEquals(isPlausibleIp("not-an-ip"), false);
  assertEquals(isPlausibleIp(""), false);
  assertEquals(isPlausibleIp("a".repeat(60)), false); // over the length bound
});

Deno.test("clientIpFromRequest takes the RIGHTMOST (gateway-appended) x-forwarded-for entry", () => {
  // An attacker prepends a spoofed IP; the trusted gateway appends the real one.
  const req = new Request("https://x/functions/v1/scan", {
    method: "POST",
    headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" },
  });
  assertEquals(
    clientIpFromRequest(req),
    "203.0.113.9",
    "must use the last hop (our gateway's view), not the client-forgeable first hop",
  );
});

Deno.test("clientIpFromRequest handles a single-entry XFF and x-real-ip fallback", () => {
  const single = new Request("https://x", {
    method: "POST",
    headers: { "x-forwarded-for": "198.51.100.7" },
  });
  assertEquals(clientIpFromRequest(single), "198.51.100.7");

  const realIp = new Request("https://x", {
    method: "POST",
    headers: { "x-real-ip": "198.51.100.42" },
  });
  assertEquals(clientIpFromRequest(realIp), "198.51.100.42");
});

Deno.test("clientIpFromRequest skips a malformed tail and finds the nearest plausible IP", () => {
  const req = new Request("https://x", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.9, garbage" },
  });
  assertEquals(clientIpFromRequest(req), "203.0.113.9");
});

Deno.test("clientIpFromRequest returns null when no IP header is present", () => {
  const req = new Request("https://x", { method: "POST" });
  assertEquals(clientIpFromRequest(req), null);
});

// --- checkBurstLimit: trips after N, resets after the window -----------------

Deno.test("checkBurstLimit allows up to the cap, then trips on the next request", async () => {
  const clock: FakeClock = { now: 1_000_000 };
  const db = fakeDb(clock);
  const ip = "203.0.113.9";

  // The first RATE_LIMIT_MAX_REQUESTS are allowed.
  for (let i = 1; i <= RATE_LIMIT_MAX_REQUESTS; i++) {
    const r = await checkBurstLimit(db, { ip, deviceIdHash: null });
    assertEquals(r.allowed, true, `request #${i} should be allowed (cap ${RATE_LIMIT_MAX_REQUESTS})`);
  }

  // The very next request (cap + 1) trips.
  const tripped = await checkBurstLimit(db, { ip, deviceIdHash: null });
  assertEquals(tripped.allowed, false, "the request after the cap must be blocked");
  assertEquals(tripped.trippedBy, "ip");
  assert(tripped.retryAfter >= 1, "a blocked request must report a positive Retry-After");
});

Deno.test("checkBurstLimit allows again after the window rolls over (reset)", async () => {
  const clock: FakeClock = { now: 2_000_000 };
  const db = fakeDb(clock);
  const ip = "203.0.113.10";

  // Exhaust the window.
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    await checkBurstLimit(db, { ip, deviceIdHash: null });
  }
  const blocked = await checkBurstLimit(db, { ip, deviceIdHash: null });
  assertEquals(blocked.allowed, false, "should be blocked at the end of the exhausted window");

  // Advance past the window boundary — the counter resets.
  clock.now += RATE_LIMIT_WINDOW_SECONDS;
  const afterReset = await checkBurstLimit(db, { ip, deviceIdHash: null });
  assertEquals(afterReset.allowed, true, "a new window must allow requests again");
});

Deno.test("checkBurstLimit: the DEVICE bucket independently catches a flood (IP absent)", async () => {
  const clock: FakeClock = { now: 3_000_000 };
  const db = fakeDb(clock);
  const deviceIdHash = "a".repeat(64); // a sha256-shaped device hash, no IP

  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    const r = await checkBurstLimit(db, { ip: null, deviceIdHash });
    assertEquals(r.allowed, true);
  }
  const tripped = await checkBurstLimit(db, { ip: null, deviceIdHash });
  assertEquals(tripped.allowed, false, "device bucket must trip even with no IP");
  assertEquals(tripped.trippedBy, "device");
});

Deno.test("checkBurstLimit: rotating the device id does NOT dodge the IP limit", async () => {
  const clock: FakeClock = { now: 4_000_000 };
  const db = fakeDb(clock);
  const ip = "203.0.113.11";

  // Same IP, a fresh device id every request (the attacker's evasion attempt).
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    const r = await checkBurstLimit(db, { ip, deviceIdHash: `dev-${i}`.padEnd(64, "0") });
    assertEquals(r.allowed, true);
  }
  const tripped = await checkBurstLimit(db, {
    ip,
    deviceIdHash: `dev-final`.padEnd(64, "0"),
  });
  assertEquals(tripped.allowed, false, "the stable IP bucket must trip despite rotating device ids");
  assertEquals(tripped.trippedBy, "ip");
});

Deno.test("checkBurstLimit fails OPEN when no identity is derivable", async () => {
  const clock: FakeClock = { now: 5_000_000 };
  const db = fakeDb(clock);
  const r = await checkBurstLimit(db, { ip: null, deviceIdHash: null });
  assertEquals(r.allowed, true, "no IP + no device id must never block (free-first-scan rail)");
  assertEquals(r.trippedBy, null);
});

Deno.test("checkBurstLimit fails OPEN on a DB error", async () => {
  const clock: FakeClock = { now: 6_000_000 };
  const db = fakeDb(clock, /* failNext */ true);
  const r = await checkBurstLimit(db, { ip: "203.0.113.12", deviceIdHash: null });
  assertEquals(r.allowed, true, "a limiter DB error must fail open, never 500 the scan");
});

Deno.test("checkBurstLimit: a legitimate low-rate caller is never limited", async () => {
  const clock: FakeClock = { now: 7_000_000 };
  const db = fakeDb(clock);
  const ip = "203.0.113.20";

  // A person / CLI scanning a few repos, spread across windows: always allowed.
  for (let i = 0; i < 5; i++) {
    const r = await checkBurstLimit(db, { ip, deviceIdHash: null });
    assertEquals(r.allowed, true, "a handful of scans in a window is fine");
    clock.now += RATE_LIMIT_WINDOW_SECONDS; // next scan lands in a fresh window
  }
});

// --- rateLimitedResponseInit -------------------------------------------------

Deno.test("rateLimitedResponseInit produces a clear message + Retry-After header", () => {
  const init = rateLimitedResponseInit(42);
  assertEquals(init.headers["Retry-After"], "42");
  assertEquals(init.body.retryAfter, 42);
  assert(init.body.error.length > 0, "must carry a human-readable explanation");
});

Deno.test("rateLimitedResponseInit floors to a minimum Retry-After of 1 second", () => {
  const init = rateLimitedResponseInit(0);
  assertEquals(init.headers["Retry-After"], "1");
});
