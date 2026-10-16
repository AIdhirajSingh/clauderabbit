/**
 * POST /api/scan pre-stream contract (DESIGN.md section 8.1): every error
 * response carries an ad; CLI and stdio MCP callers without a sign-in get 401
 * with signInUrl; a server without its keys answers 503 naming the env vars
 * (names only). The values set here are placeholders for this process only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { POST, maxDuration, runtime } from "../../app/api/scan/route.ts";
import { DEFAULT_DEADLINES } from "../../lib/engine/config.ts";

const BASE_ENV = {
  NEXT_PUBLIC_SITE_URL: "https://clauderabbit.in",
  NEXT_PUBLIC_SUPABASE_URL: "https://branch.supabase.test",
  SUPABASE_SECRET_KEY: "placeholder-not-a-key",
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

const req = (body: unknown, headers: Record<string, string> = {}) => new Request("https://clauderabbit.in/api/scan", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("route config: node runtime, maxDuration 180 covers the scan deadline", () => {
  assert.equal(runtime, "nodejs");
  assert.equal(maxDuration, 180);
  assert.ok(maxDuration * 1000 > DEFAULT_DEADLINES.scanMs + 15_000);
});

test("invalid target: 400 with an ad", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = await POST(req({ target: "???" }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; ad: { kind: string } };
    assert.equal(body.code, "invalid_target");
    assert.equal(body.ad.kind, "house");
  });
});

test("missing server keys: 503 naming the env vars, with an ad", async () => {
  await withEnv({ ...BASE_ENV, OPENAI_API_KEY: undefined, E2B_API_KEY: undefined }, async () => {
    const res = await POST(req({ target: "acme/lib" }));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { message: string; ad: { kind: string; url: string } };
    assert.match(body.message, /OPENAI_API_KEY, E2B_API_KEY/);
    assert.equal(body.ad.url, "https://clauderabbit.in/badge/acme/lib");
  });
});

test("CLI without a sign-in: 401 with signInUrl and the house ad", async () => {
  await withEnv(BASE_ENV, async () => {
    const res = await POST(req({ target: "npm:left-pad" }, { "x-clauderabbit-client": "cli" }));
    assert.equal(res.status, 401);
    const body = (await res.json()) as { signInUrl: string; ad: { kind: string; url: string } };
    assert.equal(body.signInUrl, "https://clauderabbit.in/cli-auth");
    assert.equal(body.ad.kind, "house");
    assert.equal(body.ad.url, "https://clauderabbit.in/badge/npm/left-pad");
  });
});

test("web surface gets the AdSense payload with adtest on when the IDs are set", async () => {
  await withEnv({ ...BASE_ENV, NEXT_PUBLIC_ADSENSE_CLIENT_ID: "ca-pub-1234567890123456", NEXT_PUBLIC_ADSENSE_SLOT_ID: "1234567890" }, async () => {
    const res = await POST(req({ target: "???" }));
    const body = (await res.json()) as { ad: Record<string, string> };
    assert.deepEqual(body.ad, { kind: "adsense", placement: "scan_result", client: "ca-pub-1234567890123456", slot: "1234567890", format: "auto", adtest: "on" });
  });
});

test("every response carries an ad: config error, replay by target, replay by run id", async () => {
  await withEnv({ ...BASE_ENV, NEXT_PUBLIC_SITE_URL: "not a url" }, async () => {
    const res = await POST(req({ target: "npm:left-pad" }));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { ad: { kind: string; url?: string } | null };
    assert.ok(body.ad, "config error path carries an ad");
    assert.equal(body.ad!.kind, "house");
  });
  const { GET: replay } = await import("../../app/api/scan/replay/route.ts");
  const r1 = await replay(new Request("https://clauderabbit.in/api/scan/replay?target=&sha="));
  assert.equal(r1.status, 400);
  assert.ok(((await r1.json()) as { ad?: unknown }).ad);
  const { GET: events } = await import("../../app/api/runs/[runId]/events/route.ts");
  const r2 = await events(new Request("https://clauderabbit.in/api/runs/x/events", { headers: { "x-clauderabbit-client": "cli" } }), { params: Promise.resolve({ runId: "not-a-uuid" }) });
  assert.equal(r2.status, 400);
  assert.equal(((await r2.json()) as { ad?: { kind: string } }).ad?.kind, "house");
});
