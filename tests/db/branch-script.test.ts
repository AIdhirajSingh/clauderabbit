/** scripts/db-branch-apply.mjs refuses production refs before doing anything. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { refusedRef } from "../../scripts/db-branch-apply.mjs";

test("refusedRef blocks the production project and CR_PRODUCTION_REFS", () => {
  assert.match(String(refusedRef("mjvlczaytkhvsolnhhkz", {})), /production project/);
  assert.match(String(refusedRef("abcdefghijklmnopqrst", { CR_PRODUCTION_REFS: "x, abcdefghijklmnopqrst" })), /production project/);
  assert.equal(refusedRef("abcdefghijklmnopqrst", {}), null);
  assert.match(String(refusedRef(undefined, {})), /required/);
});

test("the script exits 2 on the production ref without calling the CLI", () => {
  const script = path.resolve(import.meta.dirname, "..", "..", "scripts", "db-branch-apply.mjs");
  const r = spawnSync(process.execPath, [script, "--ref", "mjvlczaytkhvsolnhhkz", "--step", "roundtrip"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing mjvlczaytkhvsolnhhkz/);
});
