import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEngineConfig } from "../../lib/engine/config.ts";
import { detonationBudget } from "../../lib/engine/orchestrator.ts";
import { RUNNER_ENV_NAMES } from "../../lib/server/runner.ts";

test("without Yes the limits are unchanged; on a runner a Yes may build until it completes", () => {
  const cfg = loadEngineConfig({});
  for (const size of ["small", "large"] as const) {
    const inRequest = detonationBudget(cfg, size);
    const onRunner = detonationBudget({ ...cfg, runner: true }, size);
    // The card appears at the same install limit either way.
    assert.equal(onRunner.installTimeoutMs, inRequest.installTimeoutMs);
    // Inside a Vercel request a Yes is bounded by the request; on a runner it is not.
    assert.ok(inRequest.installMaxMs <= 170_000, String(inRequest.installMaxMs));
    assert.ok(onRunner.installMaxMs >= 20 * 60_000, String(onRunner.installMaxMs));
    // The detonation command and the VM cover the longest build a Yes allows.
    assert.ok(onRunner.totalTimeoutMs > onRunner.installMaxMs);
    assert.ok(onRunner.sandboxTimeoutMs > onRunner.totalTimeoutMs);
  }
});

test("the runner gets only the keys a scan needs, as process environment, never on disk", () => {
  assert.ok(!(RUNNER_ENV_NAMES as readonly string[]).includes("CR_OPERATOR_KEY"));
  for (const k of ["OPENAI_API_KEY", "E2B_API_KEY", "CR_V2_DATABASE_URL"]) assert.ok((RUNNER_ENV_NAMES as readonly string[]).includes(k), k);
  const src = readFileSync(new URL("../../lib/server/runner.ts", import.meta.url), "utf8");
  // The request file holds no key: only the run, the target, the caller and flags.
  assert.match(src, /files\.write\(`\$\{RUNNER_DIR\}\/request\.json`, JSON\.stringify\(\{ runId, sandboxId: sbx\.sandboxId, createdAt, target: s\.target, caller: s\.caller, full: s\.full, \.\.\.\(s\.fresh \? \{ fresh: true \} : \{\}\), heartbeat,/);
  assert.match(src, /commands\.run\(`cd \$\{RUNNER_DIR\} && exec \$\{NODE\} runner\.mjs request\.json`, \{ background: true, envs,/);
  // Web scans are heartbeat-kept: a closed tab stops the runner within HEARTBEAT_GRACE_MS.
  assert.match(src, /timeoutMs: heartbeat \? HEARTBEAT_GRACE_MS : RUNNER_UNATTENDED_MS/);
});

test("the runner gets the cache cutoff, since findCached runs there", async () => {
  const { RUNNER_ENV_NAMES } = await import("../../lib/server/runner.ts");
  assert.ok((RUNNER_ENV_NAMES as readonly string[]).includes("CR_FRESH_SINCE"));
});
