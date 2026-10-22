/**
 * The danger board and the sitemap list real scans only: one row per target (its
 * latest scan), most dangerous first, never a test fixture repo or an operator
 * tarball run. Against PGlite with every migration applied, read as cr_v2_server.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { listBoard } from "../../lib/server/board-v2.ts";
import { isTestFixtureRepo } from "../../lib/server/public-lists.ts";
import { fetchV2Slugs } from "../../lib/server/report-v2.ts";
import { openV2Database, type V2Database } from "../support/pglite-v2.ts";

let v2: V2Database;

async function scan(owner: string, repo: string, sha: string, score: number, verdict: string, at: string, ref: string | null = null): Promise<void> {
  const id = randomUUID();
  await v2.pg.query("insert into v2.scan_runs (id, target_kind, subject, commit_sha, status) values ($1::uuid, 'github', $2, $3, 'done')", [id, `${owner}/${repo}`, sha]);
  await v2.pg.query(
    "insert into v2.reports (owner_login, repo_name, commit_sha, score, verdict, not_verified, run_id, created_at, updated_at, ref) values ($1, $2, $3, $4, $5, '[]', $6::uuid, $7::timestamptz, $7::timestamptz, $8)",
    [owner, repo, sha, score, verdict, id, at, ref],
  );
}

before(async () => {
  v2 = await openV2Database();
  await scan("acme", "lib", "a1", 40, "High risk", "2026-10-01T00:00:00Z");
  await scan("acme", "lib", "a2", 90, "No threats observed", "2026-10-02T00:00:00Z"); // latest for acme/lib
  await scan("evil", "pkg", "e1", 10, "Malicious", "2026-10-01T00:00:00Z");
  await scan("good", "util", "g1", 95, "No threats observed", "2026-10-01T00:00:00Z");
  await scan("AIdhirajSingh", "cr-fixture-phone-home", "f1", 0, "Malicious", "2026-10-03T00:00:00Z");
  await scan("AIdhirajSingh", "cr-exfil-test-fixture", "f2", 0, "Malicious", "2026-10-03T00:00:00Z");
  await scan("tarball", "x", "t1", 5, "Malicious", "2026-10-03T00:00:00Z");
  // A backfill scans the current version first, then an older pinned commit later.
  await scan("big", "app", "head", 80, "Low risk", "2026-10-04T00:00:00Z", "latest");
  await scan("big", "app", "old", 25, "High risk", "2026-10-05T00:00:00Z");
});

after(async () => {
  await v2.close();
});

test("the board: one row per target from its latest scan, most dangerous first, no fixtures, no tarball runs", async () => {
  const { rows, next } = await listBoard(v2.server, "all", 0);
  assert.deepEqual(rows.map((r) => `${r.owner_login}/${r.repo_name}:${r.score}`), ["evil/pkg:10", "big/app:80", "acme/lib:90", "good/util:95"]);
  assert.equal(rows.find((r) => r.repo_name === "app")?.commit_sha, "head", "the current version, not an older commit scanned later");
  assert.equal(next, null);
  const danger = await listBoard(v2.server, "malicious" as never, 0).catch(() => null);
  if (danger) assert.ok(danger.rows.every((r) => !isTestFixtureRepo(r.repo_name)));
});

test("the sitemap leaves test fixtures out too", async () => {
  const slugs = await fetchV2Slugs(v2.server);
  assert.ok(slugs.length > 0);
  assert.ok(slugs.every((s) => !isTestFixtureRepo(s.repo)), JSON.stringify(slugs));
});

test("the fixture rule matches our fixture repos only", () => {
  for (const r of ["cr-fixture-phone-home", "cr-exfil-test-fixture", "cr-fixture"]) assert.ok(isTestFixtureRepo(r), r);
  for (const r of ["clauderabbit", "fixture", "my-cr-fixture", "crypto-fixtures-lib", "express"]) assert.ok(!isTestFixtureRepo(r), r);
});
