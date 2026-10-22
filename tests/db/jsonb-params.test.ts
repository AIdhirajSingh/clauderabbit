/**
 * Every JSON value the 2.0 server binds is a JSON.stringify'd string, and it must
 * reach Postgres as text and be cast there: `$N::text::jsonb`.
 *
 * Seen live on the key-day preview (2026-10-18): with postgres.js
 * (`prepare: false`, `sql.unsafe`) the server describes `$N::jsonb` as a jsonb
 * parameter and postgres.js serialises a jsonb parameter with JSON.stringify, so
 * the already-stringified value was encoded a second time. v2.reports.not_verified
 * and v2.scan_runs.cost were stored as jsonb strings, and every v2.scan_events
 * batch failed (`jsonb_to_recordset` on a scalar), so no event was persisted or
 * broadcast. Probe against production as cr_v2_server, same JSON string in both:
 *   select jsonb_typeof($1::jsonb), jsonb_typeof($2::text::jsonb)  ->  "string", "object"
 * PGlite binds strings as text either way, so the PGlite store tests cannot see
 * this; this test pins the cast form in the source instead.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test("no server SQL binds a parameter straight to jsonb; JSON goes in as $N::text::jsonb", () => {
  const offenders: string[] = [];
  for (const file of [...sources(path.join(ROOT, "lib")), ...sources(path.join(ROOT, "app"))]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\$\d+::jsonb\b/g)) offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test("the store binds its JSON columns through text", () => {
  const store = readFileSync(path.join(ROOT, "lib", "engine", "store.ts"), "utf8");
  assert.match(store, /jsonb_to_recordset\(\$1::text::jsonb\)/);
  assert.match(store, /timings = \$5::text::jsonb, cost = \$6::text::jsonb/);
  assert.match(store, /\$13::text::jsonb, \$14::text::jsonb,/);
});
