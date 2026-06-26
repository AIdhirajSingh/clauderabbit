/**
 * Unit tests for `lib/board-data.ts` — the pure reshapers that turn DB view rows
 * into the typed shapes the danger board renders.
 *
 * The honesty rails are the point of these tests: a board dot is produced ONLY
 * when a real country resolves to a centroid (no fabricated locations); the band
 * color follows the fixed score logic; the ranked-row reason leads with the
 * caught behavior; and the count reshapers coerce bigint/string safely without
 * inventing numbers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boardRowToEntry,
  distributionFromRow,
  dotFromGeoRow,
  statsFromRow,
  type BoardDotRow,
  type LeaderboardFullRow,
} from "../lib/board-data.ts";

/** A minimal leaderboard-full row with no forensics. */
function makeRow(over: Partial<LeaderboardFullRow> = {}): LeaderboardFullRow {
  return {
    owner_login: "acme",
    repo_name: "totally-safe",
    score: 12,
    verdict: "High risk",
    deep: true,
    commit_sha: "deadbeef",
    created_at: "2026-06-27T00:00:00Z",
    forensics_json: null,
    ...over,
  };
}

test("boardRowToEntry maps identity, score, and report id", () => {
  const e = boardRowToEntry(makeRow());
  assert.equal(e.owner, "acme");
  assert.equal(e.name, "totally-safe");
  assert.equal(e.score, 12);
  assert.equal(e.id, "acme/totally-safe");
  assert.equal(e.commitSha, "deadbeef");
});

test("boardRowToEntry falls back to an honest verdict-based reason when no forensics", () => {
  const e = boardRowToEntry(makeRow({ verdict: "Malicious" }));
  assert.match(e.reason, /dangerous band/i);
  assert.equal(e.forensics, undefined);
});

test("boardRowToEntry surfaces the forensic headline as the reason and carries forensics", () => {
  const forensics = {
    schema: "claude-rabbit/forensic-record@1",
    verdict: {
      dynamic_score: 8,
      headline: "Caught exfiltrating credentials to a foreign host",
      one_word: "Malicious",
      captured_network_intent: ["exfil.evil.example"],
    },
    network_intent: { attempts: [], geolocations: [] },
    in_vm_behavior: {},
    containment: {},
  };
  const e = boardRowToEntry(makeRow({ forensics_json: forensics }));
  assert.equal(e.reason, "Caught exfiltrating credentials to a foreign host");
  assert.ok(e.forensics, "forensics should be normalized onto the entry");
});

function makeDotRow(over: Partial<BoardDotRow> = {}): BoardDotRow {
  return {
    owner_login: "acme",
    repo_name: "totally-safe",
    score: 12,
    country: "Russia",
    region: null,
    city: null,
    org: null,
    host: "exfil.evil.example",
    ...over,
  };
}

test("dotFromGeoRow places a dot for a known country, colored by band", () => {
  const dot = dotFromGeoRow(makeDotRow());
  assert.ok(dot);
  assert.equal(dot.band, "red"); // score 12 < 60 → dangerous
  assert.equal(dot.country, "Russia");
  assert.equal(dot.host, "exfil.evil.example");
  assert.ok(Number.isFinite(dot.point.x) && Number.isFinite(dot.point.y));
});

test("dotFromGeoRow band follows the fixed score logic", () => {
  assert.equal(dotFromGeoRow(makeDotRow({ score: 95 }))?.band, "green");
  assert.equal(dotFromGeoRow(makeDotRow({ score: 84 }))?.band, "blue");
  assert.equal(dotFromGeoRow(makeDotRow({ score: 70 }))?.band, "yellow");
  assert.equal(dotFromGeoRow(makeDotRow({ score: 30 }))?.band, "red");
});

test("dotFromGeoRow builds a place label from the finest geo available", () => {
  const dot = dotFromGeoRow(makeDotRow({ city: "Moscow", region: "Moscow Oblast" }));
  assert.equal(dot?.place, "Moscow, Moscow Oblast, Russia");
});

test("dotFromGeoRow returns null when the country is unknown or missing (no fake dot)", () => {
  assert.equal(dotFromGeoRow(makeDotRow({ country: "Atlantis" })), null);
  assert.equal(dotFromGeoRow(makeDotRow({ country: null })), null);
  assert.equal(dotFromGeoRow(makeDotRow({ country: "   " })), null);
});

test("statsFromRow coerces bigint/string counts and never invents", () => {
  assert.equal(statsFromRow(null), null);
  const s = statsFromRow({
    distinct_repos: "42" as unknown as number,
    distinct_owners: 7,
    dangerous_repos: 3,
    deep_repos: 1,
    report_snapshots: 50,
  });
  assert.ok(s);
  assert.equal(s.distinctRepos, 42);
  assert.equal(s.distinctOwners, 7);
  assert.equal(s.dangerousRepos, 3);
});

test("statsFromRow clamps a negative/garbage count to 0", () => {
  const s = statsFromRow({
    distinct_repos: -5,
    distinct_owners: NaN as unknown as number,
    dangerous_repos: 2,
    deep_repos: 0,
    report_snapshots: 2,
  });
  assert.equal(s?.distinctRepos, 0);
  assert.equal(s?.distinctOwners, 0);
});

test("distributionFromRow returns all-zero for a null row and maps counts otherwise", () => {
  assert.deepEqual(distributionFromRow(null), { red: 0, amber: 0, blue: 0, green: 0 });
  const d = distributionFromRow({ red_count: 4, amber_count: 1, blue_count: 0, green_count: 9 });
  assert.deepEqual(d, { red: 4, amber: 1, blue: 0, green: 9 });
});
