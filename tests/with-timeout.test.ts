/**
 * Unit tests for withTimeout — the guard that fixed a real production bug: an
 * unbounded await in the /api/deep poll loop hung the whole function until Vercel's
 * 300s hard cap. withTimeout guarantees the loop always makes progress.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../lib/with-timeout.ts";

test("resolves to the promise's value when it settles in time", async () => {
  const v = await withTimeout(Promise.resolve("real"), 1000, "fallback");
  assert.equal(v, "real");
});

test("resolves to the fallback when the promise hangs past the timeout", async () => {
  // A promise that never settles — exactly the serverless read-hang this guards.
  const hang = new Promise<string>(() => {});
  const started = Date.now();
  const v = await withTimeout(hang, 30, "fallback");
  assert.equal(v, "fallback");
  assert.ok(Date.now() - started < 500, "must resolve promptly at the timeout, not hang");
});

test("resolves to the fallback when the promise rejects (never throws)", async () => {
  const v = await withTimeout(Promise.reject(new Error("boom")), 1000, "fallback");
  assert.equal(v, "fallback");
});

test("a value arriving before the timeout wins over the fallback", async () => {
  const slow = new Promise<number>((r) => setTimeout(() => r(42), 10));
  const v = await withTimeout(slow, 1000, -1);
  assert.equal(v, 42);
});

test("does not adopt the promise's late value after the timeout already fired", async () => {
  const late = new Promise<string>((r) => setTimeout(() => r("late"), 50));
  const v = await withTimeout(late, 10, "fallback");
  assert.equal(v, "fallback");
  // Give the late promise time to settle; withTimeout must have already resolved.
  await new Promise((r) => setTimeout(r, 60));
});
