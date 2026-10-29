import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const help = execFileSync(process.execPath, ["--no-warnings", "--import", "./tests/resolve-ts.mjs", "src/index.ts", "--help"], { encoding: "utf8" });

test("the help never asks anyone to sign in", () => {
  assert.doesNotMatch(help, /sign[- ]?in|signed-in|log ?in|account required/i);
  assert.match(help, /No account needed/);
});

test("scan sends no token when none is saved and never starts a sign-in", async () => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "cr-nosignin-"));
  const src = readFileSync(new URL("./commands/scan.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /ensureLoggedIn|login\(/);
  const { postScan } = await import("./lib/scan-api.ts");
  let auth: string | undefined = "unset";
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    auth = (init.headers as Record<string, string>).Authorization;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const { readToken } = await import("./lib/auth.ts");
  await postScan({ siteUrl: "https://clauderabbit.in", scanTimeoutMs: 1000 }, { ecosystem: "npm", package: "left-pad" }, readToken(), "cli", undefined, fakeFetch);
  assert.equal(auth, undefined, "no Authorization header without a saved token");
});

test("the bundled MCP server's scan tool needs no saved sign-in", () => {
  const src = readFileSync(new URL("../../mcp-server/src/tools/scan.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /signInRequiredResult|if \(!token\)/);
  assert.doesNotMatch(src, /Requires a signed-in/);
});
