/**
 * Caller identity for the scan API (DESIGN.md sections 4 and 8.2).
 *
 * Two bearer kinds are accepted:
 * - `cr_cli_...` login tokens issued to the CLI, the stdio MCP server and the
 *   remote MCP OAuth flow, checked by `v2.verify_cli_token` as cr_v2_server
 *   (SHA-256 hash lookup, revoked tokens refused, v2 tokens get last_used_at;
 *   a token issued by 1.0 is read from public.cli_tokens without a write);
 * - Supabase session JWTs from the web app, checked by `auth.getUser(jwt)`
 *   against the Auth server with the publishable key.
 * Anything else is no identity. Tokens are never logged.
 */

import { createClient } from "@supabase/supabase-js";
import type { SqlExecutor } from "./db";

export const CLI_TOKEN_PREFIX = "cr_cli_";
const CLI_TOKEN_RE = /^cr_cli_[0-9a-f]{64}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Identity = { userId: string; via: "cli_token" | "jwt" };

/** The two checks identity needs; production wiring is `identityBackend`. */
export interface IdentityBackend {
  cliToken(token: string): Promise<string | null>;
  jwtUser(jwt: string): Promise<string | null>;
}

/** The bearer value of an Authorization header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

export async function verifyCliToken(db: SqlExecutor, token: string): Promise<string | null> {
  if (!CLI_TOKEN_RE.test(token)) return null;
  const rows = await db.query<{ user_id: string | null }>("select v2.verify_cli_token($1)::text as user_id", [token]);
  const id = rows[0]?.user_id;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
}

type AuthGetUser = { auth: { getUser(jwt: string): Promise<{ data: { user: { id: string } | null } | null; error: unknown }> } };

export async function verifyJwt(client: AuthGetUser, token: string): Promise<string | null> {
  if (!JWT_RE.test(token) || token.length > 8192) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return UUID_RE.test(data.user.id) ? data.user.id : null;
}

/** Auth-server client on the publishable key (no session storage, no secret). */
export function authClient(supabaseUrl: string, publishableKey: string): AuthGetUser {
  return createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) as unknown as AuthGetUser;
}

/** Production identity checks: CLI tokens on cr_v2_server, JWTs on the Auth server. */
export function identityBackend(db: SqlExecutor, auth: { supabaseUrl: string | null; supabasePublishableKey: string | null }): IdentityBackend {
  let client: AuthGetUser | null = null;
  return {
    cliToken: (token) => verifyCliToken(db, token),
    jwtUser: (jwt) => {
      if (!auth.supabaseUrl || !auth.supabasePublishableKey) return Promise.resolve(null);
      client ??= authClient(auth.supabaseUrl, auth.supabasePublishableKey);
      return verifyJwt(client, jwt);
    },
  };
}

/** Resolve a bearer token to a user. Null when absent or invalid. */
export async function identify(backend: IdentityBackend, token: string | null): Promise<Identity | null> {
  if (!token) return null;
  if (token.startsWith(CLI_TOKEN_PREFIX)) {
    if (!CLI_TOKEN_RE.test(token)) return null;
    const userId = await backend.cliToken(token);
    return userId ? { userId, via: "cli_token" } : null;
  }
  const userId = await backend.jwtUser(token);
  return userId ? { userId, via: "jwt" } : null;
}
