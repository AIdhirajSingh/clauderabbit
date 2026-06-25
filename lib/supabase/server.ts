/**
 * Server-side Supabase client for Server Components and route handlers.
 *
 * Uses the publishable (anon) key + the request cookie store via `@supabase/ssr`
 * `createServerClient`. Public report reads only need the anon role — RLS
 * exposes `reports` / `owners` / the public views to anon (see the initial
 * schema migration). No service or secret key is ever read here (CLAUDE.md:
 * secrets stay in edge-function secrets, never in the Next.js server bundle).
 *
 * `cookies()` is awaited (Next 15+/16 makes it async). In a Server Component the
 * cookie store is read-only, so `setAll` is wrapped in a try/catch — the public
 * report page never mutates a session, so a no-op there is correct.
 */

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** Create a server Supabase client bound to the publishable (anon) key. */
export async function createClient() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "Supabase env missing: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  }
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component (read-only cookie store). The public
          // report page does not write a session, so ignoring this is correct.
        }
      },
    },
  });
}
