/**
 * A run whose runner died must never read as 'running' forever (live 2026-10-29: run
 * 18d04dd2 stayed 'running' after its web runner timed out without a page heartbeat).
 * expireStaleRuns ends quiet and over-age runs; loadRunReport sweeps the run it reads;
 * abandonRun ends one run its starter saw die, and never touches a finished run.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { abandonRun, expireStaleRuns, RUN_MAX_MS } from "../../lib/engine/store";
import { loadRunReport } from "../../lib/server/board-v2";
import { openV2Database, type V2Database } from "../support/pglite-v2";

let db: V2Database;
before(async () => {
  db = await openV2Database();
});
after(async () => {
  await db.close();
});

async function insertRun(status: string, startedAgoMs: number, lastEventMs?: number): Promise<string> {
  const id = randomUUID();
  await db.pg.query(
    `insert into v2.scan_runs (id, target_kind, subject, commit_sha, status, started_at)
     values ($1::uuid, 'github', $2, $3, $4, now() - make_interval(secs => $5::double precision))`,
    [id, `t/${id.slice(0, 8)}`, id.replace(/-/g, "").padEnd(40, "0").slice(0, 40), status, startedAgoMs / 1000],
  );
  if (lastEventMs !== undefined) {
    await db.pg.query(`insert into v2.scan_events (run_id, seq, t_ms, type, data) values ($1::uuid, 0, $2, 'stage', '{}'::jsonb)`, [id, lastEventMs]);
  }
  return id;
}

async function statusOf(id: string): Promise<{ status: string; error_code: string | null; finished: boolean }> {
  const r = await db.pg.query<{ status: string; error_code: string | null; finished: boolean }>(
    "select status, error_code, finished_at is not null as finished from v2.scan_runs where id = $1::uuid",
    [id],
  );
  return r.rows[0]!;
}

test("a run quiet for over five minutes ends as stale", async () => {
  const id = await insertRun("running", 6 * 60_000, 24_000);
  await expireStaleRuns(db.server);
  assert.deepEqual(await statusOf(id), { status: "error", error_code: "stale", finished: true });
});

test("a run still writing events stays running", async () => {
  const id = await insertRun("running", 6 * 60_000, 5 * 60_000);
  await expireStaleRuns(db.server);
  assert.equal((await statusOf(id)).status, "running");
});

test("a run older than RUN_MAX_MS ends as timeout even while it writes events", async () => {
  const id = await insertRun("running", RUN_MAX_MS + 60_000, RUN_MAX_MS);
  await expireStaleRuns(db.server);
  assert.deepEqual(await statusOf(id), { status: "error", error_code: "timeout", finished: true });
});

test("reading a dead run ends it; the reader never sees 'running'", async () => {
  const id = await insertRun("running", 6 * 60_000, 24_000);
  const report = await loadRunReport(db.server, id);
  assert.equal(report?.status, "error");
  assert.equal(report?.report, null);
});

test("abandonRun ends a running run and leaves a finished one alone", async () => {
  const live = await insertRun("running", 30_000, 20_000);
  await abandonRun(db.server, live, "timeout");
  assert.deepEqual(await statusOf(live), { status: "error", error_code: "timeout", finished: true });
  const done = await insertRun("done", 60_000, 30_000);
  await abandonRun(db.server, done, "timeout");
  assert.equal((await statusOf(done)).status, "done");
});
