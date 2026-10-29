import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { HEAD, POST } from "../../app/mcp/route.ts";

const BASE_ENV = {
  NEXT_PUBLIC_SITE_URL: "https://clauderabbit.in",
  NEXT_PUBLIC_SUPABASE_URL: "https://branch.supabase.test",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
  // Placeholder: no listener on port 1; the paths under test never open a connection.
  CR_V2_DATABASE_URL: "postgres://cr_v2_server.abcdefghijklmnopqrst:placeholder@127.0.0.1:1/postgres",
  OPENAI_API_KEY: "placeholder-not-a-key",
  E2B_API_KEY: "placeholder-not-a-key",
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of [...Object.keys(BASE_ENV), "NEXT_PUBLIC_ADSENSE_CLIENT_ID", "NEXT_PUBLIC_ADSENSE_SLOT_ID"]) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const root = path.join(import.meta.dirname, "../..");

test("/mcp needs no sign-in: tools/list with no token answers 200, never a 401 or an OAuth challenge", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = await POST(new Request("https://clauderabbit.in/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("www-authenticate"), null);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(body.result.tools.map((t) => t.name), ["scan"]);
    const head = await HEAD();
    assert.equal(head.status, 200);
  });
});

test("no OAuth discovery is published, so a connector offers no sign-in", () => {
  for (const p of ["app/.well-known/oauth-authorization-server", "app/.well-known/oauth-protected-resource"]) {
    assert.equal(existsSync(path.join(root, p)), false, p);
  }
});
