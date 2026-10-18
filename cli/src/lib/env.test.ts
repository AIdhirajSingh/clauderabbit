/**
 * Site selection for the CLI: CLAUDE_RABBIT_SITE_URL, `--api <url>` over it,
 * and the optional Preview protection bypass read from the environment.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, normaliseSiteUrl } from "./env.js";
import { configFor } from "../commands/scan.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("loadConfig defaults to clauderabbit.in with no bypass", () => {
  withEnv({ CLAUDE_RABBIT_SITE_URL: undefined, CLAUDE_RABBIT_PROTECTION_BYPASS: undefined, CLAUDE_RABBIT_SCAN_TIMEOUT_MS: undefined }, () => {
    const c = loadConfig();
    assert.equal(c.siteUrl, "https://clauderabbit.in");
    assert.equal(c.scanTimeoutMs, 150_000);
    assert.equal("protectionBypass" in c, false);
  });
});

test("loadConfig reads the protection bypass from the environment", () => {
  withEnv({ CLAUDE_RABBIT_SITE_URL: "https://preview.example/", CLAUDE_RABBIT_PROTECTION_BYPASS: " secret-value " }, () => {
    const c = loadConfig();
    assert.equal(c.siteUrl, "https://preview.example");
    assert.equal(c.protectionBypass, "secret-value");
  });
});

test("--api overrides the site and keeps the rest; a bad --api is refused by name", () => {
  const base = { siteUrl: "https://clauderabbit.in", scanTimeoutMs: 1000, protectionBypass: "p" };
  assert.deepEqual(configFor(base, "https://clauderabbit-git-20-x.vercel.app/"), { ...base, siteUrl: "https://clauderabbit-git-20-x.vercel.app" });
  assert.equal(configFor(base), base);
  assert.throws(() => configFor(base, "ftp://x"), /--api must be an absolute http\(s\) URL/);
  assert.throws(() => normaliseSiteUrl("not a url"), /CLAUDE_RABBIT_SITE_URL must be/);
});
