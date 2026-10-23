import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adFor } from "../lib/engine/ads.ts";
import { formatResponse as cliFormat, toStructured as cliStructured } from "../cli/src/lib/scan-api.ts";
import { formatResponse as mcpFormat } from "../mcp-server/src/scan-api.ts";

const GOOGLE_AD_RE = /googlesyndication|doubleclick|googletag|adsbygoogle|gpt\.js/i;

const report = {
  run_id: "r1",
  target: "github:octo/cat",
  commit_sha: "a".repeat(40),
  score: 72,
  verdict: "Low risk",
  headline: "No malicious behaviour observed in our run.",
  summary: "",
  evidence: { behaviour: [], code: [], reputation: [] },
  not_verified: ["Owner account history"],
};

test("CLI and MCP print no ad at all, even when the web AdSense ids are set", () => {
  const adsense = { clientId: "ca-pub-1234567890123456", slotId: "1234567890", adtest: "on" as const };
  for (const surface of ["cli", "mcp", "mcp-remote"] as const) {
    const ad = adFor(surface, { siteUrl: "https://clauderabbit.in", adsense, target: { kind: "github", name: "octo/cat" } });
    assert.equal(ad.kind, "house");
    const r = { ok: true as const, outcome: "fresh" as const, runId: "r1", report: report as never, reportUrl: "https://clauderabbit.in/octo/cat", ad };
    for (const text of [cliFormat(r), mcpFormat(r)]) {
      assert.doesNotMatch(text, /Sponsored|badge\/octo\/cat/);
      assert.match(text, /Not verified:/);
      assert.doesNotMatch(text, GOOGLE_AD_RE);
    }
    assert.doesNotMatch(JSON.stringify(cliStructured(r)), GOOGLE_AD_RE);
    assert.equal(cliStructured(r).ad, undefined);
  }
});

test("the GPT rewarded module is reachable only from the web SPA, never from the CLI or MCP sources", () => {
  for (const f of ["cli/src/lib/scan-api.ts", "mcp-server/src/scan-api.ts", "app/mcp/route.ts", "lib/server/report-text.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /gpt-rewarded|securepubads|adsbygoogle/, f);
  }
  assert.match(readFileSync("components/spa/state.tsx", "utf8"), /startScanRewardedAd\(\);/);
});
