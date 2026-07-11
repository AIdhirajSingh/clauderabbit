/**
 * Regression test for the remote `/mcp` npm-scanning contract.
 *
 * The remote MCP connector (the one wired into claude.ai Custom Connectors) once
 * shipped with an input schema of owner/repo/ref ONLY — no `package`/`version` —
 * so a real, live `{package: "left-pad"}` call was rejected with a Zod validation
 * error and npm packages could not be scanned from claude.ai at all, even though
 * the CLI and stdio MCP supported it. These tests lock in that the remote route's
 * target resolver accepts an npm `package` and resolves it to an npm target (the
 * exact thing that was missing), and that GitHub targets still resolve as before.
 * If the npm branch or the schema field is ever removed, the first test fails.
 */
import assert from "node:assert";
import { test } from "node:test";
import { resolveMcpScanTarget } from "./scan-target.ts";

test("a bare npm `package` resolves to an npm target — the exact gap that shipped broken", () => {
  const r = resolveMcpScanTarget({ package: "left-pad" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.target.kind, "npm");
    if (r.target.kind === "npm") {
      assert.equal(r.target.package, "left-pad");
      assert.equal(r.target.reportPath, "npm/left-pad");
      assert.equal(r.target.version, undefined);
    }
  }
});

test("an explicit `version` argument is applied to an npm package", () => {
  const r = resolveMcpScanTarget({ package: "left-pad", version: "1.3.0" });
  assert.equal(r.ok, true);
  if (r.ok && r.target.kind === "npm") assert.equal(r.target.version, "1.3.0");
});

test("a trailing @version embedded in the package string wins over the version arg", () => {
  const r = resolveMcpScanTarget({ package: "left-pad@1.2.3", version: "9.9.9" });
  assert.equal(r.ok, true);
  if (r.ok && r.target.kind === "npm") {
    assert.equal(r.target.package, "left-pad");
    assert.equal(r.target.version, "1.2.3");
  }
});

test("scoped and npm:-prefixed package forms resolve to npm", () => {
  const scoped = resolveMcpScanTarget({ package: "@scope/name" });
  assert.equal(scoped.ok && scoped.target.kind === "npm" && scoped.target.package, "@scope/name");
  const prefixed = resolveMcpScanTarget({ package: "npm:left-pad@1.0.0" });
  assert.equal(prefixed.ok && prefixed.target.kind === "npm" && prefixed.target.version, "1.0.0");
});

test("a slashed non-scoped string in `package` is rejected, not silently treated as a repo", () => {
  const r = resolveMcpScanTarget({ package: "facebook/react" });
  assert.equal(r.ok, false);
});

test("owner + repo resolves to a GitHub target with the right report path", () => {
  const r = resolveMcpScanTarget({ owner: "sindresorhus", repo: "is", ref: "main" });
  assert.equal(r.ok, true);
  if (r.ok && r.target.kind === "github") {
    assert.equal(r.target.owner, "sindresorhus");
    assert.equal(r.target.repo, "is");
    assert.equal(r.target.ref, "main");
    assert.equal(r.target.reportPath, "sindresorhus/is");
  }
});

test("no target at all is a clean error, not a crash", () => {
  assert.equal(resolveMcpScanTarget({}).ok, false);
  assert.equal(resolveMcpScanTarget({ owner: "sindresorhus" }).ok, false); // repo missing
});
