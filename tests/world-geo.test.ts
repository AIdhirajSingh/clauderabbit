/**
 * Unit tests for `lib/world-geo.ts` — the pure equirectangular projection and
 * the country-centroid lookup that place real C2 destinations on the board map.
 *
 * These guard the two classic traps in a hand-rolled map: a sign/inversion error
 * in the projection (a dot landing in the wrong hemisphere), and a centroid
 * lookup that silently invents a location for an unknown country (it must return
 * null so the caller draws no dot).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAP_H,
  MAP_W,
  centroidForCountry,
  clusterOffsets,
  project,
  resolveLocation,
} from "../lib/world-geo.ts";

test("project maps (0,0) to the map center", () => {
  const p = project(0, 0);
  assert.equal(p.x, MAP_W / 2);
  assert.equal(p.y, MAP_H / 2);
});

test("project puts the prime-meridian north pole at top-center, south pole at bottom-center", () => {
  const north = project(90, 0);
  const south = project(-90, 0);
  assert.equal(north.x, MAP_W / 2);
  assert.equal(north.y, 0); // north is up (y = 0)
  assert.equal(south.x, MAP_W / 2);
  assert.equal(south.y, MAP_H); // south is down
});

test("project maps the antimeridian extremes to the left/right edges", () => {
  assert.equal(project(0, -180).x, 0);
  assert.equal(project(0, 180).x, MAP_W);
});

test("project keeps northern-hemisphere points in the top half and eastern in the right half", () => {
  // Berlin ~ (52.5, 13.4): north of equator → top half; east of meridian → right half.
  const berlin = project(52.5, 13.4);
  assert.ok(berlin.y < MAP_H / 2, "northern latitude should be in the top half");
  assert.ok(berlin.x > MAP_W / 2, "eastern longitude should be in the right half");

  // Buenos Aires ~ (-34.6, -58.4): south → bottom half; west → left half.
  const ba = project(-34.6, -58.4);
  assert.ok(ba.y > MAP_H / 2, "southern latitude should be in the bottom half");
  assert.ok(ba.x < MAP_W / 2, "western longitude should be in the left half");
});

test("project clamps out-of-range coordinates onto the canvas", () => {
  const p = project(1000, 1000);
  assert.ok(p.x >= 0 && p.x <= MAP_W);
  assert.ok(p.y >= 0 && p.y <= MAP_H);
  assert.equal(p.x, MAP_W); // lng clamped to +180 → right edge
  assert.equal(p.y, 0); // lat clamped to +90 → top edge
});

test("centroidForCountry resolves by full name, ISO2, and ISO3 (case-insensitive)", () => {
  const byName = centroidForCountry("Germany");
  const byIso2 = centroidForCountry("de");
  const byIso3 = centroidForCountry("DEU");
  assert.ok(byName);
  assert.deepEqual(byName, byIso2);
  assert.deepEqual(byName, byIso3);
});

test("centroidForCountry resolves common aliases", () => {
  assert.ok(centroidForCountry("USA"));
  assert.deepEqual(centroidForCountry("USA"), centroidForCountry("United States"));
  assert.deepEqual(centroidForCountry("UK"), centroidForCountry("United Kingdom"));
  assert.deepEqual(centroidForCountry("Russian Federation"), centroidForCountry("Russia"));
});

test("centroidForCountry returns null for unknown/empty countries (no invented location)", () => {
  assert.equal(centroidForCountry("Atlantis"), null);
  assert.equal(centroidForCountry(""), null);
  assert.equal(centroidForCountry("   "), null);
  assert.equal(centroidForCountry(null), null);
  assert.equal(centroidForCountry(undefined), null);
});

// U4: resolve a GitHub owner's free-text location to coordinates for the origin dot.

test("resolveLocation places a known city (case + whitespace tolerant)", () => {
  const sf = resolveLocation("San Francisco, CA");
  assert.ok(sf, "San Francisco should resolve");
  assert.ok(Math.abs(sf!.lat - 37.77) < 0.5 && Math.abs(sf!.lng + 122.42) < 0.5, "near SF");
  assert.ok(resolveLocation("  bengaluru  "), "Bengaluru resolves");
  assert.ok(resolveLocation("Berlin, Germany"), "Berlin resolves (city wins over country)");
});

test("resolveLocation resolves 'City, State' (US state) to the US even without a country", () => {
  const us = centroidForCountry("united states");
  // Cities NOT in the major-city table fall through to the US-state recognizer.
  assert.deepEqual(resolveLocation("Sunnyvale, California"), us, "California -> US");
  assert.deepEqual(resolveLocation("San Diego, CA"), us, "CA -> US");
  assert.deepEqual(resolveLocation("Salt Lake City, Utah, USA"), us, "Utah/USA -> US");
});

test("resolveLocation falls back to the country for a 'City, Country' part", () => {
  assert.deepEqual(resolveLocation("Lyon, France"), centroidForCountry("France"));
  assert.deepEqual(resolveLocation("Kyoto, Japan"), centroidForCountry("Japan"));
});

test("resolveLocation invents NOTHING for an unresolvable location", () => {
  assert.equal(resolveLocation("Earth"), null);
  assert.equal(resolveLocation("https://opencollective.com/pmndrs"), null);
  assert.equal(resolveLocation("remote"), null);
  assert.equal(resolveLocation(""), null);
  assert.equal(resolveLocation(null), null);
  assert.equal(resolveLocation(undefined), null);
});

test("resolveLocation prefers a major non-US city over an ambiguous 2-letter code", () => {
  // "Toronto, CA" — CA is both California's code and Canada's ISO2; the city wins.
  const toronto = resolveLocation("Toronto, CA");
  assert.ok(toronto && Math.abs(toronto.lat - 43.65) < 0.5, "Toronto resolves to Toronto, not the US/Canada centroid");
});

// clusterOffsets: fan co-located dots so the same city never becomes one blob.

test("clusterOffsets leaves a lone dot unmoved", () => {
  const slots = clusterOffsets([{ x: 100, y: 50 }]);
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0], { indexInCluster: 0, clusterSize: 1, dx: 0, dy: 0 });
});

test("clusterOffsets fans every co-located dot off-center, each a distinct offset", () => {
  // Five repos at the SAME San Francisco centroid (the classic blob case).
  const sf = { x: 37.77 + 180, y: 90 - 37.77 };
  const slots = clusterOffsets([sf, sf, sf, sf, sf]);
  assert.equal(slots.length, 5);
  for (const s of slots) {
    assert.equal(s.clusterSize, 5);
    // Each is moved off the shared center (no two dots overlap exactly).
    assert.ok(Math.hypot(s.dx, s.dy) > 0.1, "fanned dot must be offset from center");
  }
  // Offsets are pairwise distinct (no two dots land on the same point).
  const seen = new Set(slots.map((s) => `${s.dx.toFixed(3)},${s.dy.toFixed(3)}`));
  assert.equal(seen.size, 5, "every fanned dot has a unique offset");
});

test("clusterOffsets groups by location, not globally — far-apart dots stay put", () => {
  const sf = { x: 57.6, y: 52.2 };
  const tokyo = { x: 319.7, y: 54.3 };
  const slots = clusterOffsets([sf, tokyo]);
  // Two different cities → each is a cluster of one → unmoved.
  assert.deepEqual(slots[0], { indexInCluster: 0, clusterSize: 1, dx: 0, dy: 0 });
  assert.deepEqual(slots[1], { indexInCluster: 0, clusterSize: 1, dx: 0, dy: 0 });
});

test("clusterOffsets is index-aligned with its input", () => {
  const a = { x: 10, y: 10 };
  const b = { x: 200, y: 80 };
  const slots = clusterOffsets([a, b, a]); // a, b, a
  assert.equal(slots[0]!.clusterSize, 2, "first 'a' shares a cluster");
  assert.equal(slots[1]!.clusterSize, 1, "'b' is alone");
  assert.equal(slots[2]!.clusterSize, 2, "second 'a' shares a cluster");
});
