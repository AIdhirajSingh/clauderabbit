/**
 * PGlite round trip for the 2.0 migrations (DESIGN.md section 7.2).
 *
 * 2.0 lives in the production project beside the live 1.0 stack, in its own
 * schema `v2`. This test applies every pre-2.0 migration on an in-process
 * Postgres (with a prelude standing in for the Supabase-provided schemas:
 * auth.users, auth.uid, the API roles, pgcrypto in `extensions`, and
 * realtime.send recording each broadcast into a table), snapshots the catalog
 * of public, auth and realtime, applies the 2.0 set, and proves:
 * - the 2.0 SQL creates, alters, grants and writes nothing outside schema v2;
 * - the public, auth and realtime catalogs are byte-identical after the 2.0 set
 *   and after its reverse;
 * - the server role cr_v2_server can read and write v2 and is denied on every
 *   1.0 table;
 * - the behaviour the engine relies on: running-run dedup, the Realtime
 *   broadcast per event, the budget floor, stale-run expiry, the burst limit,
 *   CLI tokens (with the read-only 1.0 fallback) and the OAuth code flow.
 * The destructive pair in supabase/migrations-post-cutover stays outside the
 * applied set and still applies and reverses on top of it.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PRELUDE } from "../support/supabase-prelude.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const UP_DIR = path.join(ROOT, "supabase", "migrations");
const DOWN_DIR = path.join(ROOT, "supabase", "migrations-down");
const POST_DIR = path.join(ROOT, "supabase", "migrations-post-cutover");
const postUp = readdirSync(POST_DIR).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
const postDown = (f: string) => path.join(POST_DIR, f.replace(/\.sql$/, ".down.sql"));
/** The first 2.0 migration's date prefix; every later file is part of the 2.0 set. */
const FIRST_2_0 = "20261016";
const ROLE = "cr_v2_server";


const upFiles = readdirSync(UP_DIR).filter((f) => f.endsWith(".sql")).sort();
const preUp = upFiles.filter((f) => f < FIRST_2_0);
const newUp = upFiles.filter((f) => f >= FIRST_2_0);
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

/** Every catalog fact of the schemas 2.0 must not touch, as one comparable string. */
async function catalogOf(schemas: string[]): Promise<string> {
  const p = [schemas];
  const parts = await Promise.all([
    db.query("select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = any($1) order by 1,2,3", p),
    db.query("select n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid) as def from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) order by 1,2,3", p),
    db.query("select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname = any($1) order by 1,2,3", p),
    db.query("select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(p.prosrc) as src, p.prosecdef, coalesce(p.proacl::text, '') as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1) order by 1,2,3", p),
    db.query("select schemaname, tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = any($1) order by 1,2,3", p),
    db.query("select n.nspname, c.relname, c.relkind, c.relrowsecurity, coalesce(c.relacl::text, '') as acl from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) order by 1,2", p),
    db.query("select n.nspname, c.relname, t.tgname, t.tgfoid::regproc::text as fn from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) order by 1,2,3", p),
    db.query("select nspname, coalesce(nspacl::text, '') as acl from pg_namespace where nspname = any($1) order by 1", p),
  ]);
  return JSON.stringify(parts.map((r) => r.rows));
}

const UNTOUCHED = ["public", "auth", "realtime", "extensions"];
let before2: string;

async function asRole<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${ROLE}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PRELUDE);
  for (const f of preUp) await apply(path.join(UP_DIR, f));
  before2 = await catalogOf(UNTOUCHED);
  for (const f of newUp) await apply(path.join(UP_DIR, f));
});

after(async () => {
  await db.close();
});

test("the 2.0 set is ten v2 migrations with reverses; the destructive pair stays post-cutover", () => {
  assert.deepEqual(newUp, [
    "20261016000000_v2_schema_role.sql",
    "20261016000001_v2_scan_runs_events.sql",
    "20261016000002_v2_auth_rate_limit.sql",
    "20261016000003_v2_scan_budget.sql",
    "20261018000001_v2_scan_runs_cost.sql",
    "20261018000002_v2_token_tables_deny_policy.sql",
    "20261021000001_v2_ui_user_board.sql",
    "20261021000002_v2_exports.sql",
    "20261021000003_v2_drop_exports.sql",
    "20261022000001_v2_scan_economics.sql",
  ]);
  for (const f of newUp) assert.ok(readFileSync(downFor(f), "utf8").length > 0, f);
  assert.deepEqual(postUp, ["20261016000004_drop_deep_queue.sql", "20261016000005_drop_dead_quota.sql"]);
});

test("2.0 SQL names no object outside v2 in any DDL, grant or write", () => {
  const ddl = /\b(?:create(?:\s+or\s+replace)?|alter|drop|comment\s+on)\s+(?:unique\s+)?(?:table|function|view|index|trigger|policy|type|sequence|schema|column)\b[^;]*?\b(public|auth|storage|realtime|extensions)\.\w+/i;
  const write = /\b(?:insert\s+into|update|delete\s+from|truncate)\s+(public|auth|storage|realtime|extensions)\./i;
  const grantOut = /\b(?:grant|revoke)\b[^;]*\bon\b[^;]*\b(public|auth|storage|realtime|extensions)\.\w+/i;
  for (const f of newUp) {
    const sql = readFileSync(path.join(UP_DIR, f), "utf8").replace(/--.*$/gm, "");
    // Function bodies read 1.0 tables read-only and call realtime.send; DDL is checked outside them.
    const outsideBodies = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    assert.doesNotMatch(outsideBodies, ddl, `${f} defines an object outside v2`);
    assert.doesNotMatch(sql, write, `${f} writes outside v2`);
    assert.doesNotMatch(sql, grantOut, `${f} grants outside v2`);
    assert.doesNotMatch(sql, /\bpassword\b/i, `${f} carries a password`);
    const down = readFileSync(downFor(f), "utf8").replace(/--.*$/gm, "");
    assert.doesNotMatch(down, ddl, `${f} reverse touches an object outside v2`);
  }
});

test("public, auth, realtime and extensions catalogs are identical before and after the 2.0 set", async () => {
  assert.equal(await catalogOf(UNTOUCHED), before2);
});

test("every v2 table has RLS on and a policy only for the server role; the role is least privilege", async () => {
  const t = await db.query<{ relname: string; rls: boolean }>("select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'v2' and c.relkind = 'r' order by 1");
  assert.deepEqual(t.rows.map((r) => r.relname), ["ad_settings", "cli_tokens", "oauth_clients", "oauth_codes", "owners", "reports", "scan_budget", "scan_events", "scan_rate_limit", "scan_runs", "user_scans"]);
  for (const r of t.rows) assert.equal(r.rls, true, r.relname);
  // Permissive policies grant to the server role only; the token tables carry a
  // restrictive always-false policy instead, so no v2 table is "RLS on, no policy".
  const pol = await db.query<{ roles: string }>("select distinct roles::text as roles from pg_policies where schemaname = 'v2' and permissive = 'PERMISSIVE'");
  assert.deepEqual(pol.rows.map((r) => r.roles), [`{${ROLE}}`]);
  const deny = await db.query<{ tablename: string; roles: string; qual: string; with_check: string }>("select tablename, roles::text as roles, qual, with_check from pg_policies where schemaname = 'v2' and permissive = 'RESTRICTIVE' order by 1");
  assert.deepEqual(deny.rows.map((r) => [r.tablename, r.roles, r.qual, r.with_check]), [
    ["cli_tokens", "{public}", "false", "false"],
    ["oauth_clients", "{public}", "false", "false"],
    ["oauth_codes", "{public}", "false", "false"],
  ]);
  const bare = await db.query<{ relname: string }>("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'v2' and c.relkind = 'r' and not exists (select 1 from pg_policies p where p.schemaname = 'v2' and p.tablename = c.relname)");
  assert.deepEqual(bare.rows, [], "every v2 table has a policy");
  const role = await db.query<Record<string, boolean>>("select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication from pg_roles where rolname = $1", [ROLE]);
  assert.deepEqual(role.rows[0], { rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false, rolreplication: false });
  const pub = await db.query<{ n: number }>("select count(*)::int as n from information_schema.role_table_grants where grantee = $1 and table_schema <> 'v2'", [ROLE]);
  assert.equal(pub.rows[0]!.n, 0, "no table grant outside v2");
  const anonV2 = await db.query<{ n: number }>("select count(*)::int as n from information_schema.role_table_grants where table_schema = 'v2' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')");
  assert.equal(anonV2.rows[0]!.n, 0, "no API role can reach v2 tables");
  const fnAcl = await db.query<{ proname: string; acl: string }>("select p.proname, coalesce(p.proacl::text, '') as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'v2'");
  for (const f of fnAcl.rows) {
    assert.ok(f.acl !== "", `${f.proname} keeps the default PUBLIC execute`);
    assert.doesNotMatch(f.acl, /(^|[{,])=X/, `${f.proname} executable by PUBLIC`);
    assert.doesNotMatch(f.acl, /\b(anon|authenticated|service_role)=/, `${f.proname} granted to an API role`);
  }
});

test("the server role writes and reads v2 and is denied on 1.0 tables", async () => {
  await asRole(async () => {
    await db.query("insert into v2.reports (owner_login, repo_name, commit_sha, score, verdict, not_verified) values ('acme', 'lib', 'abc123', 82, 'No threats observed', '[\"windows behaviour\"]')");
    const r = await db.query<{ scan_path: string; deep: boolean }>("select scan_path, deep from v2.reports where owner_login = 'acme'");
    assert.deepEqual(r.rows[0], { scan_path: "run", deep: true });
    for (const t of ["reports", "owners", "scans", "cli_tokens", "oauth_codes", "oauth_clients", "scan_rate_limit", "profiles"]) {
      await assert.rejects(db.query(`select 1 from public.${t} limit 1`), /permission denied/, `select public.${t}`);
    }
    await assert.rejects(db.query("insert into public.reports (owner_login, repo_name, commit_sha, score, verdict, scan_path) values ('x','y','z',1,'Malicious','fast')"), /permission denied/);
    await assert.rejects(db.query("select id from auth.users limit 1"), /permission denied/);
    await assert.rejects(db.query("delete from v2.scan_events"), /permission denied/);
    await assert.rejects(db.query("select * from v2.cli_tokens"), /permission denied/);
    await assert.rejects(db.query("create table v2.x (a int)"), /permission denied/);
  });
  await assert.rejects(db.query("insert into v2.reports (owner_login, repo_name, commit_sha, score, verdict, scan_path) values ('a','b','c',1,'Malicious','fast')"), /check constraint/);
  await assert.rejects(db.query("insert into v2.reports (owner_login, repo_name, commit_sha, score, verdict) values ('a','b','d',90,'Safe')"), /check constraint/, "a bare Safe verdict is refused");
});

test("one running run per (subject, sha); events broadcast on scan:<run_id>", async () => {
  const runId = await asRole(async () => {
    const a = await db.query<{ id: string }>("insert into v2.scan_runs (target_kind, subject, commit_sha) values ('github', 'acme/lib', 'abc123') returning id");
    const runId = a.rows[0]!.id;
    await assert.rejects(db.query("insert into v2.scan_runs (target_kind, subject, commit_sha) values ('github', 'acme/lib', 'abc123')"), /uq_v2_scan_runs_running|duplicate key/);
    await db.query("insert into v2.scan_events (run_id, seq, t_ms, type, data) values ($1, 0, 5, 'stage', '{\"name\":\"cache\",\"status\":\"start\"}')", [runId]);
    await assert.rejects(db.query("insert into v2.scan_events (run_id, seq, t_ms, type, data) values ($1, 1, 5, 'bogus', '{}')", [runId]));
    await db.query("update v2.scan_runs set status = 'done', finished_at = now() where id = $1", [runId]);
    await db.query("insert into v2.scan_runs (target_kind, subject, commit_sha) values ('github', 'acme/lib', 'abc123')");
    return runId;
  });
  {
    const sent = await db.query<{ event: string; topic: string; private: boolean; payload: { seq: number } }>("select * from realtime.sent where topic like 'scan:%'");
    assert.equal(sent.rows.length, 1);
    assert.equal(sent.rows[0]!.topic, `scan:${runId}`);
    assert.equal(sent.rows[0]!.event, "stage");
    assert.equal(sent.rows[0]!.private, false);
    assert.equal(sent.rows[0]!.payload.seq, 0);
  }
});

test("runs carry an optional user id; user_scans is server-only; every report write broadcasts on 'board'", async () => {
  const user = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
  await db.query("delete from realtime.sent");
  await asRole(async () => {
    const guest = (await db.query<{ id: string; user_id: string | null }>("insert into v2.scan_runs (target_kind, subject, commit_sha) values ('github', 'acme/board', 'g1') returning id, user_id")).rows[0]!;
    assert.equal(guest.user_id, null, "a guest run stores no user");
    const mine = (await db.query<{ id: string }>("insert into v2.scan_runs (target_kind, subject, commit_sha, user_id) values ('github', 'acme/board', 'u1', $1::uuid) returning id", [user])).rows[0]!.id;
    await db.query("insert into v2.user_scans (user_id, run_id) values ($1::uuid, $2::uuid)", [user, mine]);
    await db.query("insert into v2.user_scans (user_id, run_id) values ($1::uuid, $2::uuid)", [user, guest.id]);
    const rows = await db.query<{ n: number }>("select count(*)::int as n from v2.user_scans where user_id = $1::uuid", [user]);
    assert.equal(rows.rows[0]!.n, 2);
    await assert.rejects(db.query("delete from v2.user_scans"), /permission denied/, "history rows are append-only for the server role");
    await assert.rejects(db.query("insert into v2.user_scans (user_id, run_id) values ($1::uuid, gen_random_uuid())", [user]), /foreign key/);

    await db.query("insert into v2.reports (owner_login, repo_name, commit_sha, score, verdict, run_id) values ('acme', 'board', 'u1', 22, 'Malicious', $1::uuid)", [mine]);
    await db.query("update v2.reports set score = 35, verdict = 'High risk' where owner_login = 'acme' and repo_name = 'board'");
  });
  const sent = await db.query<{ event: string; topic: string; private: boolean; payload: Record<string, unknown> }>("select * from realtime.sent where topic = 'board'");
  assert.equal(sent.rows.length, 2, "one broadcast per insert and per update");
  for (const r of sent.rows) {
    assert.equal(r.event, "report");
    assert.equal(r.private, false);
    assert.deepEqual(Object.keys(r.payload).sort(), ["commit_sha", "created_at", "owner_login", "repo_name", "run_id", "score", "updated_at", "verdict"]);
  }
  assert.deepEqual([sent.rows[0]!.payload.score, sent.rows[0]!.payload.verdict], [22, "Malicious"]);
  assert.deepEqual([sent.rows[1]!.payload.score, sent.rows[1]!.payload.verdict], [35, "High risk"]);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query("select 1 from v2.user_scans"), /permission denied/, role);
    } finally {
      await db.exec("reset role");
    }
  }
});

test("expire_stale_runs marks runs older than five minutes", async () => {
  await db.query("insert into v2.scan_runs (target_kind, subject, commit_sha, started_at) values ('npm', 'npm:old', '1.0.0+sha512-x', now() - interval '6 minutes')");
  const n = await asRole(async () => (await db.query<{ n: number }>("select v2.expire_stale_runs() as n")).rows[0]!.n);
  assert.equal(n, 1);
  const row = await db.query<{ status: string; error_code: string }>("select status, error_code from v2.scan_runs where subject = 'npm:old'");
  assert.deepEqual(row.rows[0], { status: "error", error_code: "stale" });
});

test("scan_budget_charge applies under the cap and refuses at it", async () => {
  await asRole(async () => {
    const charge = async (s: number, t: number) => (await db.query<{ ok: boolean }>("select v2.scan_budget_charge($1, $2, 100, 1000) as ok", [s, t])).rows[0]!.ok;
    assert.equal(await charge(0, 0), true);
    assert.equal(await charge(60, 500), true);
    assert.equal(await charge(50, 100), true);
    assert.equal(await charge(0, 0), false);
    const day = await db.query<{ sandbox_seconds: string; model_tokens: string }>("select sandbox_seconds, model_tokens from v2.scan_budget");
    assert.equal(Number(day.rows[0]!.sandbox_seconds), 110);
    assert.equal(Number(day.rows[0]!.model_tokens), 600);
  });
});

test("check_scan_rate_limit counts per bucket and refuses past the limit", async () => {
  await asRole(async () => {
    const hit = async () => (await db.query<{ allowed: boolean; current_count: number; retry_after: number }>("select * from v2.check_scan_rate_limit('ip:1.2.3.4', 2, 3600)")).rows[0]!;
    assert.equal((await hit()).allowed, true);
    assert.equal((await hit()).allowed, true);
    const third = await hit();
    assert.equal(third.allowed, false);
    assert.equal(third.current_count, 3);
    assert.ok(third.retry_after >= 1);
  });
  const legacy = await db.query<{ n: number }>("select count(*)::int as n from public.scan_rate_limit");
  assert.equal(legacy.rows[0]!.n, 0, "the 1.0 limiter table is never written");
});

test("CLI tokens: issued into v2, verified, revoked; a 1.0 token is read without a write", async () => {
  const u = (await db.query<{ id: string }>("insert into auth.users (email) values ('dev@example.test') returning id")).rows[0]!.id;
  const token = await asRole(async () => (await db.query<{ t: string }>("select v2.issue_cli_token($1::uuid) as t", [u])).rows[0]!.t);
  assert.match(token, /^cr_cli_[0-9a-f]{64}$/);
  const verify = (t: string) => asRole(async () => (await db.query<{ u: string | null }>("select v2.verify_cli_token($1) as u", [t])).rows[0]!.u);
  assert.equal(await verify(token), u);
  assert.equal(await verify("cr_cli_" + "0".repeat(64)), null);
  assert.equal(await verify("not-a-token"), null);
  await asRole(() => assert.rejects(db.query("select v2.issue_cli_token(gen_random_uuid())"), /unknown user/));

  const legacy = `cr_cli_${"ab".repeat(32)}`;
  await db.query("insert into public.cli_tokens (user_id, token_hash) values ($1, $2)", [u, createHash("sha256").update(legacy).digest("hex")]);
  assert.equal(await verify(legacy), u);
  const stamped = await db.query<{ last_used_at: string | null }>("select last_used_at from public.cli_tokens where user_id = $1", [u]);
  assert.equal(stamped.rows[0]!.last_used_at, null, "the 1.0 token row is not written");

  await db.query("update v2.cli_tokens set revoked_at = now() where user_id = $1", [u]);
  assert.equal(await verify(token), null);
});

test("OAuth: register, code for a signed-in user, single-use redeem; a 1.0 client is accepted read-only", async () => {
  const u = (await db.query<{ id: string }>("insert into auth.users (email) values ('mcp@example.test') returning id")).rows[0]!.id;
  const challenge = "x".repeat(43);
  await asRole(async () => {
    await assert.rejects(db.query("select * from v2.register_oauth_client(array['http://evil.example/cb'])"), /https/);
    await assert.rejects(db.query("select * from v2.register_oauth_client(array['http://localhost.evil.example/cb'])"), /https/);
    const client = (await db.query<{ client_id: string }>("select * from v2.register_oauth_client(array['https://claude.ai/api/mcp/auth_callback'])")).rows[0]!.client_id;
    await assert.rejects(db.query("select * from v2.create_oauth_code($1::uuid, $2, 'https://other.example/cb', $3, null)", [u, client, challenge]), /unknown client_id/);
    const code = (await db.query<{ code: string }>("select * from v2.create_oauth_code($1::uuid, $2, 'https://claude.ai/api/mcp/auth_callback', $3, null)", [u, client, challenge])).rows[0]!.code;
    const first = await db.query<{ user_id: string; client_id: string }>("select * from v2.redeem_oauth_code($1)", [code]);
    assert.equal(first.rows[0]!.user_id, u);
    assert.equal(first.rows[0]!.client_id, client);
    assert.equal((await db.query("select * from v2.redeem_oauth_code($1)", [code])).rows.length, 0, "single use");
  });
  await db.query("insert into public.oauth_clients (client_id, redirect_uris) values ('cr_client_legacy', array['https://claude.ai/api/mcp/auth_callback'])");
  const before = await db.query("select * from public.oauth_clients where client_id = 'cr_client_legacy'");
  const code = await asRole(async () => (await db.query<{ code: string }>("select * from v2.create_oauth_code($1::uuid, 'cr_client_legacy', 'https://claude.ai/api/mcp/auth_callback', $2, null)", [u, challenge])).rows[0]!.code);
  assert.match(code, /^cr_code_[0-9a-f]{48}$/);
  assert.deepEqual((await db.query("select * from public.oauth_clients where client_id = 'cr_client_legacy'")).rows, before.rows, "the 1.0 client row is not written");
  assert.equal((await db.query<{ n: number }>("select count(*)::int as n from public.oauth_codes")).rows[0]!.n, 0, "no code lands in 1.0");
});

test("post-cutover pair applies on top of the 2.0 set and reverses cleanly", async () => {
  const has = async (t: string) => (await db.query<{ ok: boolean }>("select to_regclass($1) is not null as ok", [t])).rows[0]!.ok;
  for (const f of postUp) await apply(path.join(POST_DIR, f));
  for (const t of ["public.deep_scan_queue", "public.deep_dispatch_lock", "public.scan_usage"]) assert.equal(await has(t), false, t);
  for (const t of ["v2.scan_runs", "v2.reports", "v2.scan_budget"]) assert.equal(await has(t), true, t);
  for (const f of [...postUp].reverse()) await apply(postDown(f));
  for (const t of ["public.deep_scan_queue", "public.deep_dispatch_lock", "public.scan_usage"]) assert.equal(await has(t), true, t);
});

test("down in reverse removes v2 and the role and leaves 1.0 identical; up again succeeds", async () => {
  // The post-cutover round trip re-created 1.0 objects, so the reference snapshot is taken here.
  const pre = await catalogOf(UNTOUCHED);
  for (const f of [...newUp].reverse()) await apply(downFor(f));
  const v2 = await db.query<{ n: number }>("select count(*)::int as n from pg_namespace where nspname = 'v2'");
  assert.equal(v2.rows[0]!.n, 0);
  const role = await db.query<{ n: number }>("select count(*)::int as n from pg_roles where rolname = $1", [ROLE]);
  assert.equal(role.rows[0]!.n, 0);
  assert.equal(await catalogOf(UNTOUCHED), pre);
  for (const f of newUp) await apply(path.join(UP_DIR, f));
  const again = await db.query<{ n: number }>("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'v2' and c.relkind = 'r'");
  assert.equal(again.rows[0]!.n, 11);
});
