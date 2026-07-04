/**
 * Unit tests for `runDeepScan`'s (lib/scan.ts) handling of a /api/deep
 * rejection — specifically the distinction between:
 *
 *  1. The route being structurally unavailable for this deployment (the fail-
 *     closed local gate — CR_ALLOW_LOCAL_DEEP unset, as on the real production
 *     Vercel deploy; see docs/DEPLOY.md). This is EXPECTED, not an error, so
 *     the message shown to a real end user must not be the gate's own
 *     operator-facing text ("set CR_ALLOW_LOCAL_DEEP=1 on the sandbox
 *     controller" means nothing to a real visitor and was, before this fix,
 *     surfaced to them verbatim via a toast on every escalated scan).
 *  2. A genuine failure from a controller that WAS available (e.g. a real
 *     Cloud Run execution error) — this real, specific detail must still
 *     reach the user unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDeepScan } from "../lib/scan.ts";

test("runDeepScan: a gate rejection (reason: unavailable) yields a real-user-appropriate message, not the operator-facing gate text", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      body: null,
      json: async () => ({
        error: "deep path disabled (set CR_ALLOW_LOCAL_DEEP=1 on the sandbox controller)",
        reason: "unavailable",
      }),
    })) as unknown as typeof fetch;
  try {
    const result = await runDeepScan({ owner: "a", repo: "b", sha: "deadbeef" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.doesNotMatch(result.error, /CR_ALLOW_LOCAL_DEEP/, "must not leak the operator-facing env var name to a real user");
      assert.match(result.error, /static read only/i, "must plainly say this reflects the static read only");
    }
  } finally {
    globalThis.fetch = orig;
  }
});

test("runDeepScan: a genuine failure (no reason field) surfaces the real, specific error unchanged", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      body: null,
      json: async () => ({ error: "Cloud Run execution failed (exit 1): out of memory" }),
    })) as unknown as typeof fetch;
  try {
    const result = await runDeepScan({ owner: "a", repo: "b", sha: "deadbeef" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "Cloud Run execution failed (exit 1): out of memory");
    }
  } finally {
    globalThis.fetch = orig;
  }
});
