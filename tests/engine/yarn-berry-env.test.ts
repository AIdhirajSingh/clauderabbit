import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Step 6a of the harness, run on its own: Yarn 2+ refuses the Yarn 1 setting YARN_NETWORK_TIMEOUT.
const script = readFileSync(path.join(import.meta.dirname, "../../sandbox/e2b/guest/cr-detonate.sh"), "utf8");
const block = script.slice(script.indexOf("# ---- 6a."), script.indexOf("# ---- 6b."));

function envFor(pkg: object, lock: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cr-yarn-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  if (lock !== null) writeFileSync(path.join(dir, "yarn.lock"), lock);
  return execFileSync("bash", ["-c", `BASE_ENV=(A=1 YARN_NETWORK_TIMEOUT=5 YARN_HTTP_TIMEOUT=5)\n${block}\necho "\${BASE_ENV[*]}"`], {
    env: { ...process.env, ECO: "npm", PM: "yarn", WORKDIR: dir },
    encoding: "utf8",
  }).trim();
}

test("a Yarn 2+ repo installs without YARN_NETWORK_TIMEOUT; Yarn 1 keeps it", () => {
  assert.ok(block.length > 0, "step 6a is in the harness");
  assert.equal(envFor({ packageManager: "yarn@4.18.1+sha512.abc" }, null), "A=1 YARN_HTTP_TIMEOUT=5");
  assert.equal(envFor({}, "__metadata:\n  version: 8\n"), "A=1 YARN_HTTP_TIMEOUT=5");
  assert.equal(envFor({ packageManager: "yarn@1.22.22" }, null), "A=1 YARN_NETWORK_TIMEOUT=5 YARN_HTTP_TIMEOUT=5");
  assert.equal(envFor({}, "# yarn lockfile v1\n"), "A=1 YARN_NETWORK_TIMEOUT=5 YARN_HTTP_TIMEOUT=5");
});
