/**
 * PGlite round trip for the 2.0 migrations (DESIGN.md section 7.2).
 *
 * Applies every migration in supabase/migrations in order on an in-process
 * Postgres, with a prelude standing in for the Supabase-provided schemas
 * (auth.users, auth.uid, the API roles, pgcrypto in `extensions`, and
 * realtime.send recording each broadcast into a table). Then runs the 2.0 down
 * files in reverse and the up files again, and checks the behaviour the engine
 * relies on: the running-run dedup, the Realtime broadcast per event, the
 * budget floor, stale-run expiry, and the 'run' scan path.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const UP_DIR = path.join(ROOT, "supabase", "migrations");
const DOWN_DIR = path.join(ROOT, "supabase", "migrations-down");
const NEW_PREFIX = "20261016";

const PRELUDE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create extension pgcrypto schema extensions;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create schema realtime;
create table realtime.sent (payload jsonb, event text, topic text, private boolean);
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
  language sql as $$ insert into realtime.sent values (payload, event, topic, private) $$;
`;

const upFiles = readdirSync(UP_DIR).filter((f) => f.endsWith(".sql")).sort();
const newUp = upFiles.filter((f) => f.startsWith(NEW_PREFIX));
const downFor = (f: string) => path.join(DOWN_DIR, f.replace(/\.sql$/, ".down.sql"));

let db: PGlite;

// pg_stat_statements is a Supabase-installed monitoring extension PGlite does
// not ship; it creates nothing the schema references, so only that statement is skipped.
const PGLITE_UNAVAILABLE = /create extension if not exists "pg_stat_statements";/g;

async function apply(file: string): Promise<void> {
  try {
    await db.exec(readFileSync(file, "utf8").replace(PGLITE_UNAVAILABLE, ""));
  } catch (err) {
    throw new Error(`${path.basename(file)}: ${(err as Error).message}`);
  }
}

async function exists(kind: "table" | "function", name: string): Promise<boolean> {
  const sql = kind === "table" ? "select to_regclass($1) is not null as ok" : "select exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1) as ok";
  const r = await db.query<{ ok: boolean }>(sql, [kind === "table" ? `public.${name}` : name]);
  return r.rows[0]!.ok;
}

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const f of upFiles) await apply(path.join(UP_DIR, f));
});

after(async () => {
  await db.close();
});

test("the five 2.0 migrations exist, each with a down file", () => {
  assert.deepEqual(newUp, [
    "20261016000001_scan_runs_events.sql",
    "20261016000002_reports_run_path.sql",
    "20261016000003_scan_budget.sql",
    "20261016000004_drop_deep_queue.sql",
    "20261016000005_drop_dead_quota.sql",
  ]);
  for (const f of newUp) assert.ok(readFileSync(downFor(f), "utf8").length > 0, f);
});

test("up state: new objects present, deep queue and daily quota gone", async () => {
  for (const t of ["scan_runs", "scan_events", "scan_budget"]) assert.equal(await exists("table", t), true, t);
  for (const t of ["deep_scan_queue", "deep_dispatch_lock", "scan_usage"]) assert.equal(await exists("table", t), false, t);
  for (const f of ["deep_queue_enqueue", "deep_dispatch_try_claim", "check_and_increment_scan_limit"]) assert.equal(await exists("function", f), false, f);
  for (const f of ["scan_budget_charge", "expire_stale_runs", "check_scan_rate_limit", "verify_cli_token"]) assert.equal(await exists("function", f), true, f);
});

test("down in reverse restores the pre-2.0 schema, then up again succeeds", async () => {
  for (const f of [...newUp].reverse()) await apply(downFor(f));
  for (const t of ["deep_scan_queue", "deep_dispatch_lock", "scan_usage"]) assert.equal(await exists("table", t), true, t);
  for (const f of ["deep_queue_enqueue", "deep_queue_set_stage", "deep_dispatch_release", "check_and_increment_scan_limit"]) assert.equal(await exists("function", f), true, f);
  for (const t of ["scan_runs", "scan_events", "scan_budget"]) assert.equal(await exists("table", t), false, t);
  const cols = await db.query<{ n: number }>("select count(*)::int as n from information_schema.columns where table_name = 'reports' and column_name in ('run_id','score_breakdown','not_verified')");
  assert.equal(cols.rows[0]!.n, 0);
  for (const f of newUp) await apply(path.join(UP_DIR, f));
  for (const t of ["scan_runs", "scan_events", "scan_budget"]) assert.equal(await exists("table", t), true, t);
  assert.equal(await exists("table", "deep_scan_queue"), false);
});

test("reports accept scan_path 'run' with the new columns", async () => {
  await db.query(
    `insert into public.reports (owner_login, repo_name, commit_sha, score, verdict, scan_path, deep, run_id, score_breakdown, not_verified)
     values ('acme', 'lib', 'abc123', 82, 'No threats observed', 'run', true, gen_random_uuid(), '[]', '["windows behaviour"]')`,
  );
  const r = await db.query<{ scan_path: string }>("select scan_path from public.reports where owner_login = 'acme'");
  assert.equal(r.rows[0]!.scan_path, "run");
});

test("one running run per (subject, sha); events broadcast on scan:<run_id>", async () => {
  const a = await db.query<{ id: string }>("insert into public.scan_runs (target_kind, subject, commit_sha) values ('github', 'acme/lib', 'abc123') returning id");
  const runId = a.rows[0]!.id;
  await assert.rejects(db.query("insert into public.scan_runs (target_kind, subject, commit_sha) values ('github', 'acme/lib', 'abc123')"), /uq_scan_runs_running|duplicate key/);
  await db.query("insert into public.scan_events (run_id, seq, t_ms, type, data) values ($1, 0, 5, 'stage', '{\"name\":\"cache\",\"status\":\"start\"}')", [runId]);
  const sent = await db.query<{ event: string; topic: string; private: boolean; payload: { seq: number } }>("select * from realtime.sent");
  assert.equal(sent.rows.length, 1);
  assert.equal(sent.rows[0]!.topic, `scan:${runId}`);
  assert.equal(sent.rows[0]!.event, "stage");
  assert.equal(sent.rows[0]!.private, false);
  assert.equal(sent.rows[0]!.payload.seq, 0);
  await assert.rejects(db.query("insert into public.scan_events (run_id, seq, t_ms, type, data) values ($1, 1, 5, 'bogus', '{}')", [runId]));
  await db.query("update public.scan_runs set status = 'done', finished_at = now() where id = $1", [runId]);
  await db.query("insert into public.scan_runs (target_kind, subject, commit_sha) values ('github', 'acme/lib', 'abc123')");
});

test("expire_stale_runs marks runs older than five minutes", async () => {
  await db.query("insert into public.scan_runs (target_kind, subject, commit_sha, started_at) values ('npm', 'npm:old', '1.0.0+sha512-x', now() - interval '6 minutes')");
  const r = await db.query<{ n: number }>("select public.expire_stale_runs() as n");
  assert.equal(r.rows[0]!.n, 1);
  const row = await db.query<{ status: string; error_code: string }>("select status, error_code from public.scan_runs where subject = 'npm:old'");
  assert.deepEqual(row.rows[0], { status: "error", error_code: "stale" });
});

test("scan_budget_charge applies under the cap and refuses at it", async () => {
  const charge = async (s: number, t: number) => (await db.query<{ ok: boolean }>("select public.scan_budget_charge($1, $2, 100, 1000) as ok", [s, t])).rows[0]!.ok;
  assert.equal(await charge(0, 0), true);
  assert.equal(await charge(60, 500), true);
  assert.equal(await charge(50, 100), true);
  assert.equal(await charge(0, 0), false);
  const day = await db.query<{ sandbox_seconds: string; model_tokens: string }>("select sandbox_seconds, model_tokens from public.scan_budget");
  assert.equal(Number(day.rows[0]!.sandbox_seconds), 110);
  assert.equal(Number(day.rows[0]!.model_tokens), 600);
});
