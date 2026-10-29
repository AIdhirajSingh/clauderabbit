import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const run = (...args: string[]) =>
  execFileSync(process.execPath, ["--no-warnings", "--import", "./tests/resolve-ts.mjs", "src/index.ts", ...args], { encoding: "utf8" });

test("--version and -v print the version, not the help", () => {
  for (const flag of ["--version", "-v", "version"]) assert.equal(run(flag), `${version}\n`, flag);
});

test("no command and --help print the help", () => {
  assert.match(run(), /^clauderabbit — /);
  assert.match(run("--help"), /^clauderabbit — /);
});
