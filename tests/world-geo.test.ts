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
  project,
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
