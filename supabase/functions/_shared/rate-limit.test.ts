/**
 * Unit tests for the burst/velocity rate limiter (rate-limit.ts).
 *
 * Run: `deno test supabase/functions/_shared/rate-limit.test.ts`
 *
 * These lock in the BUG-9 security-review behavior, as CORRECTED by the real-
 * client-IP fix (see clientIpFromRequest's doc comment for the empirical evidence
 * that the original "rightmost x-forwarded-for hop" derivation was broken for
 * Supabase's Cloudflare-fronted, multi-node edge topology):
 *   - the trustworthy client IP is cf-connecting-ip (Cloudflare-set, un-forgeable)
 *     and, failing that, sb-forwarded-for or the LEFTMOST x-forwarded-for entry —
 *     the true client on this platform, constant per client, while the rightmost
 *     XFF entry is a per-request-rotating internal node and must NOT be used;
 *   - checkBurstLimit TRIPS after exactly RATE_LIMIT_MAX_REQUESTS in a window and
 *     returns a Retry-After, then ALLOWS again once the window rolls over;
 *   - the IP bucket and the device bucket each independently catch a flood;
 *   - a coarse GLOBAL ANONYMOUS circuit breaker caps aggregate anonymous (no user,
 *     no deviceId) traffic system-wide, bounding a flood spread across many real
 *     IPs that no per-source bucket can catch;
 *   - it FAILS OPEN when no bucket is derivable and when the DB errors, so it can
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
  GLOBAL_ANON_MAX_REQUESTS,
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

Deno.test("clientIpFromRequest prefers cf-connecting-ip (Cloudflare-set, un-forgeable)", () => {
  // This mirrors the REAL observed live headers: cf-connecting-ip is the constant
  // true client IP; the XFF chain has the true client on the LEFT and a rotating
  // internal Supabase node on the RIGHT. The old code took the rotating right hop;
  // the fix takes cf-connecting-ip.
  const req = new Request("https://x/functions/v1/scan", {
    method: "POST",
    headers: {
      "cf-connecting-ip": "49.36.136.144",
      "sb-forwarded-for": "49.36.136.144",
      "x-forwarded-for": "49.36.136.144, 49.36.136.144, 99.82.160.73",
    },
  });
  assertEquals(
    clientIpFromRequest(req),
    "49.36.136.144",
    "must use the constant true client IP (cf-connecting-ip), NOT the rotating rightmost XFF hop",
  );
});

Deno.test("clientIpFromRequest: the ROTATING rightmost XFF hop is never chosen (the bug's root cause)", () => {
  // Two requests from the SAME client: cf-connecting-ip constant, rightmost XFF
  // churns (99.82.160.73 → .78). The derived IP MUST be identical both times, so
  // the bucket key is stable and a repeat offender actually accumulates a count.
  const mk = (rightHop: string) =>
    new Request("https://x", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "49.36.136.144",
        "x-forwarded-for": `49.36.136.144, 49.36.136.144, ${rightHop}`,
      },
    });
  const a = clientIpFromRequest(mk("99.82.160.73"));
  const b = clientIpFromRequest(mk("99.82.160.78"));
  assertEquals(a, b, "same client → same key even as the internal edge node rotates");
  assertEquals(a, "49.36.136.144");
});

Deno.test("clientIpFromRequest falls back to sb-forwarded-for then the LEFTMOST XFF entry", () => {
  // No cf-connecting-ip → sb-forwarded-for carries the true client IP.
  const sb = new Request("https://x", {
    method: "POST",
    headers: { "sb-forwarded-for": "198.51.100.7" },
  });
  assertEquals(clientIpFromRequest(sb), "198.51.100.7");

  // No cf/sb header → the LEFTMOST plausible XFF entry is the true client here
  // (Cloudflare rebuilds the chain from the real client and appends Supabase's
  // rotating internal nodes on the right, so leftmost = the CF-observed client;
  // a client-supplied prepend is discarded by CF, verified live).
  const xff = new Request("https://x", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.9, 99.82.160.50" },
  });
  assertEquals(
    clientIpFromRequest(xff),
    "203.0.113.9",
    "leftmost XFF is the true client on this edge, not the rotating rightmost node",
  );
});

Deno.test("clientIpFromRequest uses x-real-ip only as a last resort", () => {
  const realIp = new Request("https://x", {
    method: "POST",
    headers: { "x-real-ip": "198.51.100.42" },
  });
  assertEquals(clientIpFromRequest(realIp), "198.51.100.42");
});

Deno.test("clientIpFromRequest skips a malformed leftmost entry and finds the nearest plausible IP", () => {
  const req = new Request("https://x", {
    method: "POST",
    headers: { "x-forwarded-for": "garbage, 203.0.113.9" },
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

// --- global anonymous circuit breaker ----------------------------------------

Deno.test("checkBurstLimit: the GLOBAL ANONYMOUS breaker caps aggregate anonymous traffic across many IPs", async () => {
  const clock: FakeClock = { now: 8_000_000 };
  const db = fakeDb(clock);

  // The flood the per-source buckets CANNOT catch: a distinct real IP each
  // request (well under the per-IP cap of 20 apiece) and NO device id. The old
  // code left this completely un-throttled. The global-anon bucket now bounds it.
  for (let i = 0; i < GLOBAL_ANON_MAX_REQUESTS; i++) {
    const r = await checkBurstLimit(db, {
      ip: `203.0.${Math.floor(i / 254)}.${(i % 254) + 1}`,
      deviceIdHash: null,
      isAnonymous: true,
    });
    assertEquals(r.allowed, true, `anonymous request #${i + 1} (fresh IP) should be allowed`);
  }
  // One more anonymous request (any IP) — the system-wide anonymous window is full.
  const tripped = await checkBurstLimit(db, {
    ip: "198.51.100.200",
    deviceIdHash: null,
    isAnonymous: true,
  });
  assertEquals(tripped.allowed, false, "aggregate anonymous flood must trip the global breaker");
  assertEquals(tripped.trippedBy, "global-anon");
  assert(tripped.retryAfter >= 1, "the global breaker must report a positive Retry-After");
});

Deno.test("checkBurstLimit: the global anonymous breaker does NOT apply to identified (non-anonymous) traffic", async () => {
  const clock: FakeClock = { now: 9_000_000 };
  const db = fakeDb(clock);

  // Requests that carry a device id are NOT anonymous, so the global-anon bucket
  // never counts them — a legitimate device-identified population is never
  // collectively throttled by other users' anonymous floods. Each still gets its
  // own per-device cap; here every request uses a DISTINCT device id and a
  // distinct IP, so no per-source bucket trips either. Far more than the global
  // anonymous cap of requests all succeed.
  for (let i = 0; i < GLOBAL_ANON_MAX_REQUESTS + 50; i++) {
    const r = await checkBurstLimit(db, {
      ip: `203.0.${Math.floor(i / 254)}.${(i % 254) + 1}`,
      deviceIdHash: `dev-${i}`.padEnd(64, "0"),
      isAnonymous: false,
    });
    assertEquals(r.allowed, true, `identified request #${i + 1} must not hit the anonymous breaker`);
  }
});

Deno.test("checkBurstLimit: anonymous request with NO derivable IP is still bounded by the global breaker", async () => {
  const clock: FakeClock = { now: 10_000_000 };
  const db = fakeDb(clock);

  // No IP and no device id, but flagged anonymous: previously this failed fully
  // open. Now the global-anon bucket alone caps it, so even the worst case (no
  // per-source signal at all) is no longer zero-protection.
  for (let i = 0; i < GLOBAL_ANON_MAX_REQUESTS; i++) {
    const r = await checkBurstLimit(db, { ip: null, deviceIdHash: null, isAnonymous: true });
    assertEquals(r.allowed, true);
  }
  const tripped = await checkBurstLimit(db, { ip: null, deviceIdHash: null, isAnonymous: true });
  assertEquals(tripped.allowed, false, "anonymous no-IP flood must still be bounded system-wide");
  assertEquals(tripped.trippedBy, "global-anon");
});

Deno.test("checkBurstLimit fails OPEN when no bucket is derivable (no IP, no device, not anonymous-flagged)", async () => {
  const clock: FakeClock = { now: 5_000_000 };
  const db = fakeDb(clock);
  const r = await checkBurstLimit(db, { ip: null, deviceIdHash: null });
  assertEquals(r.allowed, true, "no IP + no device id + not anonymous must never block (free-first-scan rail)");
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
