/**
 * Caller identity for the scan API (DESIGN.md sections 4 and 8.2).
 *
 * Two bearer kinds are accepted:
 * - `cr_cli_...` login tokens issued to the CLI, the stdio MCP server and the
 *   remote MCP OAuth flow, checked by the `verify_cli_token` RPC (SHA-256 hash
 *   lookup, revoked tokens refused, last_used_at stamped);
 * - Supabase session JWTs from the web app, checked by `auth.getUser(jwt)`.
 * Anything else is no identity. Tokens are never logged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const CLI_TOKEN_PREFIX = "cr_cli_";
const CLI_TOKEN_RE = /^cr_cli_[0-9a-f]{64}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Identity = { userId: string; via: "cli_token" | "jwt" };

/** The bearer value of an Authorization header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

export async function verifyCliToken(db: Pick<SupabaseClient, "rpc">, token: string): Promise<string | null> {
  if (!CLI_TOKEN_RE.test(token)) return null;
  const { data, error } = await db.rpc("verify_cli_token", { p_token: token });
  if (error) throw new Error(`verify_cli_token failed: ${error.message}`);
  return typeof data === "string" && UUID_RE.test(data) ? data : null;
}

export async function verifyJwt(db: Pick<SupabaseClient, "auth">, token: string): Promise<string | null> {
  if (!JWT_RE.test(token) || token.length > 8192) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

/** Resolve a bearer token to a user. Null when absent or invalid. */
export async function identify(db: Pick<SupabaseClient, "rpc" | "auth">, token: string | null): Promise<Identity | null> {
  if (!token) return null;
  if (token.startsWith(CLI_TOKEN_PREFIX)) {
    const userId = await verifyCliToken(db, token);
    return userId ? { userId, via: "cli_token" } : null;
  }
  const userId = await verifyJwt(db, token);
  return userId ? { userId, via: "jwt" } : null;
}
