/**
 * Preview-only test sign-in: lets a person or an automated check reach the
 * signed-in app on a Vercel Preview deployment without typing or seeing a
 * password. Production never serves it.
 *
 * How it works: the route signs ONE fixed test account in server-side with
 * `supabase.auth.signInWithPassword`, using a password held only in the
 * Preview-scoped, sensitive Vercel env var `CR_TEST_ACCOUNT_PASSWORD`. The
 * publishable-key server client writes the session cookies (route handlers
 * have a writable cookie store), exactly as app/auth/callback/route.ts does.
 * The first call on a fresh project creates the account with `auth.signUp`
 * (no secret or service key exists or is needed). If the project requires
 * email confirmation, sign-up returns no session and the route says so; it
 * never works around that.
 *
 * The gate is `testSignInEnabled`: true only when VERCEL_ENV is "preview", or
 * in local development (no VERCEL_ENV, NODE_ENV "development") when
 * CR_TEST_SIGNIN_DEV is "1". Everything else, production included, gets 404.
 */

/** The fixed test account. Not a secret: the password is the secret. */
export const TEST_ACCOUNT_EMAIL = "test+preview@clauderabbit.in";
export const TEST_ACCOUNT_NAME = "ClaudeRabbit Test";

type Env = Record<string, string | undefined>;

/** Whether the test sign-in routes exist in this environment. */
export function testSignInEnabled(env: Env = process.env): boolean {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv === "preview") return true;
  if (vercelEnv) return false; // "production", "development" on Vercel, or anything else
  return env.NODE_ENV === "development" && env.CR_TEST_SIGNIN_DEV === "1";
}

/**
 * Login-CSRF guard: a cross-site page must not be able to sign a visitor into
 * the test account (an <img> or link from elsewhere). Direct navigation sends
 * `Sec-Fetch-Site: none`; same-origin sends `same-origin`. A missing header
 * (curl, older clients) is allowed.
 */
export function crossSiteRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

/** The slice of the Supabase auth client this module uses (injectable in tests). */
export interface TestAuthClient {
  signInWithPassword(c: { email: string; password: string }): Promise<{
    data: { session: unknown | null; user: { user_metadata?: Record<string, unknown> } | null };
    error: { code?: string; message: string } | null;
  }>;
  signUp(c: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown> };
  }): Promise<{
    data: { session: unknown | null; user: unknown | null };
    error: { code?: string; message: string } | null;
  }>;
  updateUser(a: { data: Record<string, unknown> }): Promise<{ error: { message: string } | null }>;
}

export type TestSignInResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "email_confirmation_required" | "sign_in_failed" | "sign_up_failed"; detail: string };

const METADATA = { full_name: TEST_ACCOUNT_NAME, name: TEST_ACCOUNT_NAME };

/**
 * Sign the test account in (creating it on first use). On success the client's
 * cookie adapter has received the session cookies.
 */
export async function signInTestAccount(auth: TestAuthClient, password: string): Promise<TestSignInResult> {
  const first = await auth.signInWithPassword({ email: TEST_ACCOUNT_EMAIL, password });
  if (!first.error && first.data.session) {
    const meta = first.data.user?.user_metadata ?? {};
    if (meta.full_name !== TEST_ACCOUNT_NAME) {
      const { error } = await auth.updateUser({ data: METADATA });
      if (error) console.error("test sign-in: metadata update failed:", error.message);
    }
    return { ok: true, created: false };
  }
  if (first.error?.code === "email_not_confirmed") {
    return { ok: false, reason: "email_confirmation_required", detail: first.error.message };
  }
  if (first.error && first.error.code !== "invalid_credentials") {
    return { ok: false, reason: "sign_in_failed", detail: first.error.message };
  }

  // invalid_credentials: either the account does not exist yet, or the stored
  // password was rotated. signUp creates it in the first case; in the second
  // it returns an obfuscated user with no session, reported below.
  const created = await auth.signUp({ email: TEST_ACCOUNT_EMAIL, password, options: { data: METADATA } });
  if (created.error) return { ok: false, reason: "sign_up_failed", detail: created.error.message };
  if (!created.data.session) {
    return {
      ok: false,
      reason: "email_confirmation_required",
      detail:
        "sign-up returned no session: the project requires email confirmation, or the account exists with a different password",
    };
  }
  return { ok: true, created: true };
}
