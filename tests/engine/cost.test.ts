import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngineConfig } from "../../lib/engine/config.ts";
import { cacheHitLedger, callUsd, CostMeter, DEFAULT_FX, JEV_PRICES, LUNA_PRICES, ledgerFrom, sandboxUsdPerSecond } from "../../lib/engine/cost.ts";
import { SANDBOX_CPU_COUNT, SANDBOX_MEMORY_MB } from "../../lib/engine/sandbox/resources.ts";

const u = (inputTokens: number, outputTokens: number, cachedInputTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens });

test("pinned prices match the published lists read on 2026-10-18", () => {
  assert.deepEqual(
    [JEV_PRICES["typesafe-ai/jev"]!.input_per_mtok, JEV_PRICES["typesafe-ai/jev"]!.output_per_mtok, JEV_PRICES["typesafe-ai/jev"]!.cached_input_per_mtok],
    [0.042, 0, null],
  );
  const luna = LUNA_PRICES["gpt-6-luna"]!;
  assert.deepEqual([luna.input_per_mtok, luna.cached_input_per_mtok, luna.cache_write_per_mtok, luna.output_per_mtok], [0.1, 0.01, 0.125, 0.5]);
  // E2B: $0.000014/s per vCPU and $0.0000045/s per GiB, at the template's size.
  assert.equal(sandboxUsdPerSecond(1, 2048), 0.000023);
  assert.equal(sandboxUsdPerSecond(), Math.round((SANDBOX_CPU_COUNT * 0.000014 + (SANDBOX_MEMORY_MB / 1024) * 0.0000045) * 1e9) / 1e9);
  assert.deepEqual(DEFAULT_FX, { usd_inr: 94.96, source: "https://api.frankfurter.app/latest?from=USD&to=INR (ECB reference rate)", as_of: "2026-10-16" });
});

test("call cost prices uncached input, cached input, cache writes and output apart", () => {
  const luna = LUNA_PRICES["gpt-6-luna"]!;
  // 2321 input of which 1920 cached: 401 x 0.10 + 1920 x 0.01 + 45 x 0.50, per million.
  assert.equal(callUsd(u(2321, 45, 1920), luna), Math.round(((401 * 0.1 + 1920 * 0.01 + 45 * 0.5) / 1e6) * 1e9) / 1e9);
  assert.equal(callUsd(u(1000, 10, 0, 1000), luna), Math.round(((1000 * 0.125 + 10 * 0.5) / 1e6) * 1e9) / 1e9);
  // Jev has no cache price: cached tokens are priced as input.
  assert.equal(callUsd(u(1_000_000, 0, 10), JEV_PRICES["typesafe-ai/jev"]!), 0.042);
  assert.equal(callUsd(u(5, 5), null), null);
});

test("the ledger sums Jev calls, the Luna call and sandbox seconds into USD and INR", () => {
  const m = new CostMeter({ jevModel: "typesafe-ai/jev", lunaModel: "gpt-6-luna" });
  m.recordJev("check.install", u(4000, 0));
  m.recordJev("check.docs", u(2000, 0));
  m.recordJev("check.flagged", u(3000, 0));
  m.recordLuna("report", u(2400, 300, 2048));
  const l = m.ledger(61.5);
  assert.equal(l.version, 1);
  assert.equal(l.jev.calls, 3);
  assert.equal(l.jev.input_tokens, 9000);
  assert.equal(l.jev.usd, Math.round(((9000 * 0.042) / 1e6) * 1e9) / 1e9);
  assert.equal(l.luna.calls, 1);
  assert.equal(l.luna.cached_input_tokens, 2048);
  assert.equal(l.sandbox.seconds, 61.5);
  assert.equal(l.sandbox.vcpu, SANDBOX_CPU_COUNT);
  assert.equal(l.sandbox.memory_gib, SANDBOX_MEMORY_MB / 1024);
  assert.equal(l.sandbox.usd, Math.round(61.5 * sandboxUsdPerSecond() * 1e9) / 1e9);
  const total = Math.round((l.jev.usd! + l.luna.usd! + l.sandbox.usd) * 1e9) / 1e9;
  assert.equal(l.total_usd, total);
  assert.equal(l.total_inr, Math.round(total * 94.96 * 1e6) / 1e6);
  assert.equal(l.calls.length, 4);
  assert.deepEqual(l.calls.map((c) => c.model), ["jev", "jev", "jev", "luna"]);
  assert.equal(m.totalTokens(), 9000 + 2400 + 300);
  assert.deepEqual(ledgerFrom(JSON.parse(JSON.stringify(l))), l);
  assert.equal(ledgerFrom({ version: 2 }), null);
});

test("an unpriced model keeps its tokens and makes the totals null instead of a number it cannot back", () => {
  const m = new CostMeter({ jevModel: "typesafe-ai/jev", lunaModel: "gpt-unknown" });
  m.recordLuna("report", u(100, 10));
  const l = m.ledger(1);
  assert.equal(l.luna.usd, null);
  assert.equal(l.luna.input_tokens, 100);
  assert.equal(l.total_usd, null);
  assert.equal(l.total_inr, null);
});

test("a cache hit reports a zero ledger; CR_USD_INR overrides the pinned rate", () => {
  const z = cacheHitLedger({ jevModel: "typesafe-ai/jev", lunaModel: "gpt-6-luna" });
  assert.equal(z.total_usd, 0);
  assert.equal(z.jev.calls + z.luna.calls, 0);
  assert.equal(z.sandbox.seconds, 0);
  const cfg = loadEngineConfig({ CR_USD_INR: "95.08" });
  assert.equal(cfg.fx.usd_inr, 95.08);
  assert.throws(() => loadEngineConfig({ CR_USD_INR: "-1" }), /CR_USD_INR/);
  assert.equal(loadEngineConfig({}).jevModelId, "typesafe-ai/jev");
  assert.equal(loadEngineConfig({ CR_JEV_MODEL_ID: "typesafe-ai/jev-1.14.0" }).jevModelId, "typesafe-ai/jev-1.14.0");
});
