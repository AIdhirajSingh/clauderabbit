/**
 * Unit tests for `lib/format.ts` — the human-count formatter and the defensive
 * `loc` display normalizer.
 *
 * These guard the one failure mode described in the report UI investigation:
 * a raw, unformatted integer (e.g. a model forgetting to format `stats.loc`)
 * must never reach a human as a giant bare number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCount, normalizeLocDisplay } from "../lib/format.ts";

test("formatCount renders numbers under 1000 as plain integers", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(1), "1");
  assert.equal(formatCount(42), "42");
  assert.equal(formatCount(999), "999");
});

test("formatCount abbreviates thousands with one decimal below 100K-scale", () => {
  assert.equal(formatCount(1000), "1K");
  assert.equal(formatCount(1234), "1.2K");
  assert.equal(formatCount(1500), "1.5K");
  assert.equal(formatCount(9999), "10K");
});

test("formatCount drops the decimal once the scaled value reaches 100+ (3 sig figs)", () => {
  assert.equal(formatCount(302545), "303K");
  assert.equal(formatCount(100_000), "100K");
  assert.equal(formatCount(999_499), "999K");
});

test("formatCount abbreviates millions", () => {
  assert.equal(formatCount(3_200_000), "3.2M");
  assert.equal(formatCount(1_000_000), "1M");
  assert.equal(formatCount(12_340_000), "12.3M");
});

test("formatCount carries a rounding-boundary value over into the next unit", () => {
  // 999,500 / 1000 = 999.5K -> rounds to 1000K, must carry to "1M", not "1000K".
  assert.equal(formatCount(999_500), "1M");
  // 999,500,000 -> the same carry one tier up, into billions.
  assert.equal(formatCount(999_500_000), "1B");
});

test("formatCount handles negative numbers by formatting the magnitude with a leading '-'", () => {
  assert.equal(formatCount(-1234), "-1.2K");
  assert.equal(formatCount(-42), "-42");
  assert.equal(formatCount(-302545), "-303K");
});

test("formatCount is safe against non-finite / non-numeric input", () => {
  assert.equal(formatCount(NaN), "0");
  assert.equal(formatCount(Infinity), "0");
  assert.equal(formatCount(-Infinity), "0");
  // @ts-expect-error deliberately passing a non-number to prove the guard holds at runtime
  assert.equal(formatCount(undefined), "0");
  // @ts-expect-error deliberately passing a non-number to prove the guard holds at runtime
  assert.equal(formatCount(null), "0");
});

test("formatCount treats zero as zero, not a falsy no-op", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(-0), "0");
});

// ───────────────────────── normalizeLocDisplay ─────────────────────────

test("normalizeLocDisplay re-formats a raw unformatted digit string", () => {
  assert.equal(normalizeLocDisplay("302545"), "303K");
  assert.equal(normalizeLocDisplay("1234"), "1.2K");
  assert.equal(normalizeLocDisplay("42"), "42");
});

test("normalizeLocDisplay passes already-formatted strings through unchanged", () => {
  assert.equal(normalizeLocDisplay("9880 KB"), "9880 KB");
  assert.equal(normalizeLocDisplay("7.2k"), "7.2k");
  assert.equal(normalizeLocDisplay("1,000"), "1,000");
  assert.equal(normalizeLocDisplay("75 KB"), "75 KB");
});

test("normalizeLocDisplay passes placeholders and empty/blank strings through unchanged", () => {
  assert.equal(normalizeLocDisplay("—"), "—");
  assert.equal(normalizeLocDisplay("unknown"), "unknown");
  assert.equal(normalizeLocDisplay(""), "");
  assert.equal(normalizeLocDisplay("   "), "   ");
});

test("normalizeLocDisplay tolerates surrounding whitespace on a raw digit string", () => {
  assert.equal(normalizeLocDisplay("  302545  "), "303K");
});
