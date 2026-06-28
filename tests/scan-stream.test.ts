/**
 * Unit tests for `splitNdjson` (lib/scan.ts) — the line-buffering primitive that
 * makes the streamed-scan client robust (BUG-5/6).
 *
 * The load-bearing case is the classic partial-line-across-chunks bug: a single
 * network read can end mid-JSON-object, so a naive split-and-parse throws and the
 * whole scan surfaces as a failure even though the backend succeeded. These lock
 * the buffering contract: only COMPLETE lines are returned; the trailing partial
 * is held in `rest` until its newline arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitNdjson } from "../lib/scan";

test("returns complete lines and keeps the trailing partial in rest", () => {
  // Arrange + Act
  const { lines, rest } = splitNdjson("", '{"a":1}\n{"b":2');
  // Assert
  assert.deepEqual(lines, ['{"a":1}']);
  assert.equal(rest, '{"b":2');
});

test("reassembles a JSON object split across two chunks", () => {
  const first = splitNdjson("", '{"t":"sta');
  assert.deepEqual(first.lines, []);
  assert.equal(first.rest, '{"t":"sta');

  const second = splitNdjson(first.rest, 'ge","ch":"Read"}\n');
  assert.deepEqual(second.lines, ['{"t":"stage","ch":"Read"}']);
  assert.equal(second.rest, "");
  const parsed = JSON.parse(second.lines[0] ?? "");
  assert.deepEqual(parsed, { t: "stage", ch: "Read" });
});

test("handles multiple complete lines in one chunk", () => {
  const { lines, rest } = splitNdjson("", "a\nb\nc\n");
  assert.deepEqual(lines, ["a", "b", "c"]);
  assert.equal(rest, "");
});

test("skips blank / whitespace-only lines", () => {
  const { lines } = splitNdjson("", "x\n\n   \ny\n");
  assert.deepEqual(lines, ["x", "y"]);
});

test("carries the buffer across many calls until each newline arrives", () => {
  let buffer = "";
  const all: string[] = [];
  for (const chunk of ['{"n":', "1}", "\n", '{"n":2}\n{"n":3']) {
    const r = splitNdjson(buffer, chunk);
    buffer = r.rest;
    all.push(...r.lines);
  }
  // Two complete objects emitted; the third is still buffered (no newline yet).
  assert.deepEqual(all, ['{"n":1}', '{"n":2}']);
  assert.equal(buffer, '{"n":3');
});
