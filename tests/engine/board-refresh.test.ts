/**
 * The board keeps itself on the current scoring rules: targets whose shown scan is
 * under older rules are found (oldest first), never a fixture, never one already
 * being scanned, at most 5 scans running at once.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { BOARD_REFRESH_CONCURRENCY, refreshSlots, runningScans, staleBoardSubjects, targetForSubject } from "../../lib/server/board-refresh.ts";
import { openV2Database, type V2Database } from "../support/pglite-v2.ts";

let v2: V2Database;

async function scan(subject: string, owner: string, repo: string, rules: number, status = "done"): Promise<void> {
  const id = randomUUID();
  await v2.pg.query("insert into v2.scan_runs (id, target_kind, subject, commit_sha, status) values ($1::uuid, 'github', $2, $3, $4)", [id, subject, randomUUID().slice(0, 8), status]);
  if (status === "done") {
    await v2.pg.query(
      "insert into v2.reports (owner_login, repo_name, commit_sha, score, verdict, not_verified, run_id, stats_json, ref) values ($1, $2, $3, 80, 'Low risk', '[]', $4::uuid, $5::jsonb, 'latest')",
      [owner, repo, randomUUID().slice(0, 8), id, JSON.stringify({ score_rules: rules })],
    );
  }
}

before(async () => {
  v2 = await openV2Database();
  await scan("old/one", "old", "one", 16);
  await scan("old/two", "old", "two", 29);
  await scan("npm:pkg", "npm", "pkg", 29);
  await scan("cur/rent", "cur", "rent", 31);
  await scan("AIdhirajSingh/cr-fixture-phone-home", "AIdhirajSingh", "cr-fixture-phone-home", 16);
  await scan("busy/repo", "busy", "repo", 20);
  await scan("busy/repo", "busy", "repo", 0, "running");
});

after(async () => {
  await v2.close();
});

test("stale board targets: older rules only, oldest first, no fixture, none already being scanned", async () => {
  assert.deepEqual(await staleBoardSubjects(v2.server, 31, 10), ["old/one", "npm:pkg", "old/two"]);
  assert.deepEqual(await staleBoardSubjects(v2.server, 31, 2), ["old/one", "npm:pkg"]);
  assert.equal(await runningScans(v2.server), 1);
});

test("at most 5 scans at once, and subjects map to current-version targets", () => {
  assert.equal(BOARD_REFRESH_CONCURRENCY, 5);
  assert.equal(refreshSlots(0), 5);
  assert.equal(refreshSlots(3), 2);
  assert.equal(refreshSlots(9), 0);
  assert.deepEqual(targetForSubject("npm:@scope/pkg"), { kind: "npm", name: "@scope/pkg" });
  assert.deepEqual(targetForSubject("supabase/supabase"), { kind: "github", owner: "supabase", repo: "supabase" });
  assert.equal(targetForSubject("tarball:x; rm -rf /"), null);
});

test("CR_FRESH_SINCE: runs before the production launch are stale on the board and never a cache hit", async () => {
  const { freshSince } = await import("../../lib/engine/store.ts");
  const { staleBoardSubjects } = await import("../../lib/server/board-refresh.ts");
  assert.equal(freshSince({}), null);
  assert.equal(freshSince({ CR_FRESH_SINCE: "not a time" }), null);
  assert.equal(freshSince({ CR_FRESH_SINCE: "2026-10-23T12:40:00Z" }), "2026-10-23T12:40:00.000Z");
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = { query: async (sql: string, params: unknown[]) => { seen.push({ sql, params }); return [{ subject: "npm:left-pad" }]; } } as never;
  assert.deepEqual(await staleBoardSubjects(db, 36, 5, "2026-10-23T12:40:00.000Z"), ["npm:left-pad"]);
  assert.equal(seen[0]!.params[3], "2026-10-23T12:40:00.000Z");
  assert.match(seen[0]!.sql, /coalesce\(sr\.finished_at, sr\.started_at\) < \$4::timestamptz/);
});
