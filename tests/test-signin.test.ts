import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEST_ACCOUNT_EMAIL,
  TEST_ACCOUNT_NAME,
  crossSiteRequest,
  signInTestAccount,
  testSignInEnabled,
  type TestAuthClient,
} from "../lib/server/test-signin.ts";

test("gate: only a Vercel Preview deployment is enabled by default", () => {
  assert.equal(testSignInEnabled({ VERCEL_ENV: "preview" }), true);
  assert.equal(testSignInEnabled({ VERCEL_ENV: "production" }), false);
  assert.equal(testSignInEnabled({ VERCEL_ENV: "production", NODE_ENV: "development", CR_TEST_SIGNIN_DEV: "1" }), false);
  assert.equal(testSignInEnabled({ VERCEL_ENV: "development" }), false);
  assert.equal(testSignInEnabled({ VERCEL_ENV: "Preview" }), false);
  assert.equal(testSignInEnabled({}), false);
  assert.equal(testSignInEnabled({ NODE_ENV: "production" }), false);
  assert.equal(testSignInEnabled({ NODE_ENV: "production", CR_TEST_SIGNIN_DEV: "1" }), false);
});

test("gate: local development needs the explicit opt-in", () => {
  assert.equal(testSignInEnabled({ NODE_ENV: "development" }), false);
  assert.equal(testSignInEnabled({ NODE_ENV: "development", CR_TEST_SIGNIN_DEV: "true" }), false);
  assert.equal(testSignInEnabled({ NODE_ENV: "development", CR_TEST_SIGNIN_DEV: "1" }), true);
});

for (const path of ["../app/api/test/sign-in/route.ts", "../app/api/test/sign-out/route.ts"]) {
  test(`route ${path.split("/").at(-2)}: 404 on production, before touching Supabase or the password`, async () => {
    const saved = { ...process.env };
    try {
      process.env.VERCEL_ENV = "production";
      process.env.CR_TEST_ACCOUNT_PASSWORD = "unused";
      delete process.env.NEXT_PUBLIC_SUPABASE_URL; // a Supabase call would throw, not 404
      const mod = (await import(path)) as { GET: (r: Request) => Promise<Response> };
      const res = await mod.GET(new Request("https://clauderabbit.in/api/test/sign-in"));
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(res.headers.get("location"), null);
    } finally {
      process.env = saved;
    }
  });
}

test("cross-site requests are refused, direct navigation is not", () => {
  assert.equal(crossSiteRequest(new Headers({ "sec-fetch-site": "cross-site" })), true);
  assert.equal(crossSiteRequest(new Headers({ "sec-fetch-site": "same-site" })), true);
  assert.equal(crossSiteRequest(new Headers({ "sec-fetch-site": "none" })), false);
  assert.equal(crossSiteRequest(new Headers({ "sec-fetch-site": "same-origin" })), false);
  assert.equal(crossSiteRequest(new Headers()), false);
});

function fakeAuth(over: Partial<TestAuthClient> & { calls?: string[] } = {}): TestAuthClient & { calls: string[] } {
  const calls = over.calls ?? [];
  return {
    calls,
    signInWithPassword: over.signInWithPassword ?? (async (c) => {
      calls.push(`signIn:${c.email}`);
      return { data: { session: {}, user: { user_metadata: { full_name: TEST_ACCOUNT_NAME } } }, error: null };
    }),
    signUp: over.signUp ?? (async (c) => {
      calls.push(`signUp:${c.email}:${String(c.options?.data?.full_name)}`);
      return { data: { session: {}, user: {} }, error: null };
    }),
    updateUser: over.updateUser ?? (async () => {
      calls.push("updateUser");
      return { error: null };
    }),
  };
}

test("existing account: one password sign-in, no sign-up", async () => {
  const auth = fakeAuth();
  assert.deepEqual(await signInTestAccount(auth, "pw"), { ok: true, created: false });
  assert.deepEqual(auth.calls, [`signIn:${TEST_ACCOUNT_EMAIL}`]);
});

test("existing account without the display name gets it set", async () => {
  const calls: string[] = [];
  const auth = fakeAuth({
    calls,
    signInWithPassword: async () => ({ data: { session: {}, user: { user_metadata: {} } }, error: null }),
  });
  assert.deepEqual(await signInTestAccount(auth, "pw"), { ok: true, created: false });
  assert.deepEqual(calls, ["updateUser"]);
});

test("missing account: invalid_credentials leads to sign-up with the name metadata", async () => {
  const calls: string[] = [];
  const auth = fakeAuth({
    calls,
    signInWithPassword: async () => ({ data: { session: null, user: null }, error: { code: "invalid_credentials", message: "Invalid login credentials" } }),
  });
  assert.deepEqual(await signInTestAccount(auth, "pw"), { ok: true, created: true });
  assert.deepEqual(calls, [`signUp:${TEST_ACCOUNT_EMAIL}:${TEST_ACCOUNT_NAME}`]);
});

test("email confirmation on: sign-up without a session is reported, not bypassed", async () => {
  const auth = fakeAuth({
    signInWithPassword: async () => ({ data: { session: null, user: null }, error: { code: "invalid_credentials", message: "x" } }),
    signUp: async () => ({ data: { session: null, user: {} }, error: null }),
  });
  const r = await signInTestAccount(auth, "pw");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "email_confirmation_required");
});

test("email_not_confirmed on sign-in is reported as confirmation required", async () => {
  const auth = fakeAuth({
    signInWithPassword: async () => ({ data: { session: null, user: null }, error: { code: "email_not_confirmed", message: "Email not confirmed" } }),
  });
  const r = await signInTestAccount(auth, "pw");
  assert.equal(!r.ok && r.reason, "email_confirmation_required");
});

test("other sign-in errors do not trigger a sign-up", async () => {
  const calls: string[] = [];
  const auth = fakeAuth({
    calls,
    signInWithPassword: async () => ({ data: { session: null, user: null }, error: { code: "over_request_rate_limit", message: "rate limited" } }),
  });
  const r = await signInTestAccount(auth, "pw");
  assert.equal(!r.ok && r.reason, "sign_in_failed");
  assert.deepEqual(calls, []);
});
