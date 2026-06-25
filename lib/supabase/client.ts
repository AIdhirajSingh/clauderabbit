/**
 * Browser-side Supabase client.
 *
 * Holds ONLY the public Supabase URL + publishable key (CLAUDE.md: the client
 * never sees any other secret). Used from Client Components for public reads
 * (reports / leaderboard / activity), all of which RLS exposes to the anon
 * role. Never use this for writes — scanning + persistence happen in the edge
 * function where the service key lives.
 */

import { createBrowserClient } from "@supabase/ssr";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function assertEnv(): { url: string; key: string } {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "Supabase env missing: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  }
  return { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY };
}

/** Create a browser Supabase client bound to the publishable (anon) key. */
export function createClient() {
  const { url, key } = assertEnv();
  return createBrowserClient(url, key);
}
