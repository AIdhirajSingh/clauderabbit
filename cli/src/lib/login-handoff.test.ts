import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Credentials go to $HOME/.clauderabbit; point HOME at a throwaway dir before auth.ts loads.
process.env.HOME = mkdtempSync(join(tmpdir(), "cr-login-"));
const { login } = await import("./auth.ts");

const TOKEN = `cr_cli_${"ab".repeat(32)}`;
const config = { siteUrl: "https://clauderabbit.in", scanTimeoutMs: 1000 };

function start(): Promise<{ done: Promise<string>; url: URL }> {
  return new Promise((resolve) => {
    const done = login(config as never, 10_000, (u) => resolve({ done, url: new URL(u) }));
    done.catch(() => {});
  });
}

const post = (port: string, body: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });

test("the sign-in URL carries a port and a random state, never a token", async () => {
  const { url, done } = await start();
  assert.equal(url.pathname, "/cli-auth");
  assert.match(url.searchParams.get("state") ?? "", /^[0-9a-f]{48}$/);
  assert.equal(url.searchParams.get("token"), null);
  await post(url.searchParams.get("port")!, { token: TOKEN, state: url.searchParams.get("state")! });
  await done;
});

test("a token in the query string is refused; only a POST body with the right state is accepted", async () => {
  const { url, done } = await start();
  const port = url.searchParams.get("port")!;
  const state = url.searchParams.get("state")!;
  const viaGet = await fetch(`http://127.0.0.1:${port}/callback?token=${TOKEN}&state=${state}`, { redirect: "manual" });
  assert.equal(viaGet.status, 405);
  const wrongState = await post(port, { token: TOKEN, state: "0".repeat(48) });
  assert.equal(wrongState.status, 403);
  const ok = await post(port, { token: TOKEN, state });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/done");
  assert.equal(await done, TOKEN);
  const saved = JSON.parse(readFileSync(join(process.env.HOME!, ".clauderabbit", "credentials.json"), "utf8"));
  assert.equal(saved.token, TOKEN);
  const page = await fetch(`http://127.0.0.1:${port}/done`);
  assert.match(await page.text(), /<h1>Connected<\/h1>/);
});

test("a malformed token with the right state fails the login", async () => {
  const { url, done } = await start();
  const res = await post(url.searchParams.get("port")!, { token: "cr_cli_short", state: url.searchParams.get("state")! });
  assert.equal(res.status, 303);
  await assert.rejects(done, /valid token/);
});
