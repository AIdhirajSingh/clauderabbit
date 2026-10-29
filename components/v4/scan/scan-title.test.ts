import { test } from "node:test";
import assert from "node:assert/strict";
import { isStored, scanTitle } from "./scan-title.ts";

test("a stored run played back is labelled, never 'Scanning'", () => {
  assert.equal(scanTitle({ done: false, failed: false, stored: true }), "Playing a stored scan");
  assert.equal(scanTitle({ done: true, failed: false, stored: true }), "Stored scan");
  assert.equal(scanTitle({ done: false, failed: false, stored: false }), "Scanning");
  assert.equal(scanTitle({ done: true, failed: false, stored: false }), "Scan complete");
  assert.equal(scanTitle({ done: false, failed: true, stored: false }), "Scan stopped");
});

test("stored means ?replay=1 or every streamed event is a replay", () => {
  assert.equal(isStored(true, []), true);
  assert.equal(isStored(false, [{ replayed: true }, { replayed: true }]), true);
  assert.equal(isStored(false, [{ replayed: true }, {}]), false);
  assert.equal(isStored(false, []), false);
});
