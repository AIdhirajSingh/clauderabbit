/**
 * A heartbeat extends every running sandbox of the run, and one that ended between the
 * list and its setTimeout does not fail it (live 2026-10-29: a heartbeat returned 503
 * mid-scan; the loop threw on the first ended VM and extended nothing after it, so the
 * runner could time out mid-scan).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError } from "e2b";
import { extendRunSandboxes } from "../../lib/engine/sandbox/e2b.ts";

function fakeSdk(ids: string[], fail: Record<string, Error>) {
  const extended: string[] = [];
  let query: unknown = null;
  const sdk = {
    list(opts: { query: unknown }) {
      query = opts.query;
      let done = false;
      return { get hasNext() { return !done; }, async nextItems() { done = true; return ids.map((sandboxId) => ({ sandboxId })); } };
    },
    async setTimeout(id: string) {
      if (fail[id]) throw fail[id];
      extended.push(id);
    },
  };
  return { sdk: sdk as never, extended, query: () => query };
}

test("an ended VM does not stop the runner and the other VMs from being extended", async () => {
  const f = fakeSdk(["vm-ended", "runner", "vm-2"], { "vm-ended": new NotFoundError("sandbox not found") });
  const n = await extendRunSandboxes("k", "run-1", 30_000, f.sdk);
  assert.equal(n, 2);
  assert.deepEqual(f.extended.sort(), ["runner", "vm-2"]);
  assert.deepEqual(f.query(), { metadata: { runId: "run-1", heartbeat: "1" }, state: ["running"] });
});

test("a real E2B failure still fails the heartbeat, after extending the rest", async () => {
  const f = fakeSdk(["runner", "vm-1"], { "vm-1": new Error("E2B unavailable") });
  await assert.rejects(() => extendRunSandboxes("k", "run-1", 30_000, f.sdk), /E2B unavailable/);
  assert.deepEqual(f.extended, ["runner"]);
});
