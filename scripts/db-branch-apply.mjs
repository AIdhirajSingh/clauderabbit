#!/usr/bin/env node
/**
 * Apply the ClaudeRabbit 2.0 migrations to a Supabase BRANCH, never production
 * (DESIGN.md section 7.2). Runs each SQL file through `supabase db query
 * --project-ref <branch> -f <file>` (Management API, the CLI's own login).
 *
 *   node scripts/db-branch-apply.mjs --ref <branch-ref> --step up
 *   node scripts/db-branch-apply.mjs --ref <branch-ref> --step down
 *   node scripts/db-branch-apply.mjs --ref <branch-ref> --step roundtrip   (up, down, up)
 *   node scripts/db-branch-apply.mjs --ref <branch-ref> --step verify
 *   node scripts/db-branch-apply.mjs --ref <branch-ref> --set post-cutover --step roundtrip
 *
 * `--set post-cutover` targets supabase/migrations-post-cutover (drop the 1.0
 * deep queue and the dead daily quota). Those run only after the owner retires
 * 1.0, because the live 1.0 deep-queue function calls the RPCs they drop.
 *
 * Refuses the production project ref (mjvlczaytkhvsolnhhkz) and any ref listed
 * in CR_PRODUCTION_REFS (comma separated). `--files <prefix>` selects which up
 * files to apply (default `2.0`: every file from 20261016 on); `--step base` applies
 * every pre-2.0 migration in order, for a branch that starts empty.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_REFS = new Set(["mjvlczaytkhvsolnhhkz"]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETS = {
  production: { up: path.join(ROOT, "supabase", "migrations"), down: path.join(ROOT, "supabase", "migrations-down") },
  "post-cutover": { up: path.join(ROOT, "supabase", "migrations-post-cutover"), down: path.join(ROOT, "supabase", "migrations-post-cutover") },
};

/**
 * @param {string | undefined} ref
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null} the refusal reason, or null when the ref is allowed
 */
export function refusedRef(ref, env = process.env) {
  if (!ref || !/^[a-z0-9]{20}$/.test(ref)) return "a 20-character project ref is required";
  const extra = (env.CR_PRODUCTION_REFS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (PRODUCTION_REFS.has(ref) || extra.includes(ref)) return `refusing ${ref}: it is a production project; migrations run on a branch only`;
  return null;
}

function arg(name, argv) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function run(ref, file) {
  const r = spawnSync("supabase", ["db", "query", "--project-ref", ref, "-f", file, "--output-format", "json"], { encoding: "utf8" });
  const label = path.relative(ROOT, file);
  if (r.status !== 0) {
    process.stderr.write(`FAIL ${label} exit ${r.status}\n${r.stderr}\n${r.stdout}\n`);
    process.exit(r.status ?? 1);
  }
  process.stdout.write(`ok   ${label} exit 0\n`);
}

/** File-name prefix of the first 2.0 migration; every later file is part of the 2.0 set. */
const FIRST_2_0 = "20261016";

function query(ref, sql) {
  const r = spawnSync("supabase", ["db", "query", "--project-ref", ref, "--output-format", "json", sql], { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(`FAIL query exit ${r.status}\n${r.stderr}\n`);
    process.exit(r.status ?? 1);
  }
  return r.stdout.trim();
}

function main(argv) {
  const ref = arg("ref", argv);
  const step = arg("step", argv) ?? "up";
  // "2.0" (default) is every migration from the first 2.0 file on; any other value is a file-name prefix.
  const prefix = arg("files", argv) ?? "2.0";
  const refusal = refusedRef(ref);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(2);
  }
  const setName = arg("set", argv) ?? "production";
  const dirs = SETS[setName];
  if (!dirs) {
    process.stderr.write(`unknown --set ${setName}\n`);
    process.exit(2);
  }
  const UP_DIR = dirs.up;
  const DOWN_DIR = dirs.down;
  const all = readdirSync(UP_DIR).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
  const ups = all.filter((f) => (prefix === "2.0" ? f >= FIRST_2_0 : f.startsWith(prefix)));
  const up = () => ups.forEach((f) => run(ref, path.join(UP_DIR, f)));
  const down = () => [...ups].reverse().forEach((f) => run(ref, path.join(DOWN_DIR, f.replace(/\.sql$/, ".down.sql"))));
  const verify = () =>
    process.stdout.write(
      query(ref, "select table_name from information_schema.tables where table_schema='public' and table_name in ('scan_runs','scan_events','scan_budget','deep_scan_queue','deep_dispatch_lock','scan_usage') order by 1") + "\n",
    );
  if (step === "base") all.filter((f) => f < (prefix === "2.0" ? FIRST_2_0 : prefix)).forEach((f) => run(ref, path.join(UP_DIR, f)));
  else if (step === "up") up();
  else if (step === "down") down();
  else if (step === "roundtrip") {
    up();
    down();
    up();
  } else if (step !== "verify") {
    process.stderr.write(`unknown --step ${step}\n`);
    process.exit(2);
  }
  verify();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
