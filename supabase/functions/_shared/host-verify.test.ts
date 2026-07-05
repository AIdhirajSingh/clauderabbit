/**
 * Unit tests for verifyUnrecognizedHost/verifyUnrecognizedHosts — the real
 * host-verification fix for the false-positive scoring bug (a static
 * allowlist necessarily misses real, legitimate hosts like storage.
 * googleapis.com or opencode.ai). `fetch` is mocked here so these tests are
 * fast and deterministic; the real behavior is additionally verified live
 * against real hosts (see the session's run notes), not just mocked.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { verifyUnrecognizedHost, verifyUnrecognizedHosts } from "./host-verify.ts";

function withMockedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

Deno.test("a host that responds to HEAD is verified legitimate", async () => {
  const result = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch,
    () => verifyUnrecognizedHost("get.docker.com"),
  );
  assertEquals(result.legitimate, true);
  assert(/responded 200/.test(result.signal));
});

Deno.test("a host that returns a non-2xx status is STILL legitimate (a real server responded)", async () => {
  // A 403/404 still proves it's a real, live web host — just maybe blocking
  // bots or the exact path. Only a genuine connection failure is "not legitimate".
  const result = await withMockedFetch(
    (() => Promise.resolve(new Response(null, { status: 403 }))) as typeof fetch,
    () => verifyUnrecognizedHost("some-real-host.example"),
  );
  assertEquals(result.legitimate, true);
});

Deno.test("a host whose HEAD request throws falls back to a real GET before failing", async () => {
  let calls: string[] = [];
  const result = await withMockedFetch(
    ((_url: string, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (init?.method === "HEAD") return Promise.reject(new Error("HEAD not supported"));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch,
    () => verifyUnrecognizedHost("head-rejecting-host.example"),
  );
  assertEquals(calls, ["HEAD", "GET"], "must fall back to GET, not give up after HEAD fails");
  assertEquals(result.legitimate, true);
});

Deno.test("a host with no real response (both HEAD and GET fail) is honestly NOT legitimate", async () => {
  const result = await withMockedFetch(
    (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as typeof fetch,
    () => verifyUnrecognizedHost("definitely-does-not-exist.invalid"),
  );
  assertEquals(result.legitimate, false);
  assert(/no real HTTP response/.test(result.signal));
});

Deno.test("verifyUnrecognizedHosts verifies multiple hosts concurrently and maps results by host", async () => {
  const result = await withMockedFetch(
    ((url: string) => {
      const host = new URL(url).hostname;
      if (host === "good.example") return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.reject(new Error("unreachable"));
    }) as typeof fetch,
    () => verifyUnrecognizedHosts(["good.example", "bad.example"]),
  );
  assertEquals(result.get("good.example")?.legitimate, true);
  assertEquals(result.get("bad.example")?.legitimate, false);
});
