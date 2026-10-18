/**
 * Server-side account actions on schema v2 (DESIGN.md section 8.2): issuing a
 * CLI token, the remote MCP OAuth code and its redemption, client
 * registration. The browser never reaches the database for these: the page
 * sends its Supabase session JWT, the route checks it against the Auth server
 * (publishable key), and only then calls the v2 function as cr_v2_server.
 */

import { bearerToken, identityBackend } from "@/lib/engine/auth";
import type { EngineConfig } from "@/lib/engine/config";
import type { SqlExecutor } from "@/lib/engine/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in user behind a request's `Authorization: Bearer <session JWT>`, or null. */
export async function sessionUser(db: SqlExecutor, config: Pick<EngineConfig, "supabaseUrl" | "supabasePublishableKey">, authorization: string | null): Promise<string | null> {
  const jwt = bearerToken(authorization);
  if (!jwt || jwt.startsWith("cr_cli_")) return null;
  try {
    return await identityBackend(db, config).jwtUser(jwt);
  } catch {
    return null;
  }
}

export async function issueCliToken(db: SqlExecutor, userId: string): Promise<string> {
  if (!UUID_RE.test(userId)) throw new Error("issueCliToken: user id is not a uuid");
  const rows = await db.query<{ token: string }>("select v2.issue_cli_token($1::uuid) as token", [userId]);
  const token = rows[0]?.token;
  if (typeof token !== "string" || !/^cr_cli_[0-9a-f]{64}$/.test(token)) throw new Error("issue_cli_token returned no token");
  return token;
}

export interface OAuthCodeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
}

/** Null when the client and redirect pair is not registered or the challenge is malformed. */
export async function createOAuthCode(db: SqlExecutor, userId: string, req: OAuthCodeRequest): Promise<string | null> {
  if (!UUID_RE.test(userId)) return null;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(req.codeChallenge)) return null;
  if (req.clientId.length > 200 || req.redirectUri.length > 2048 || (req.resource?.length ?? 0) > 2048) return null;
  try {
    const rows = await db.query<{ code: string }>("select code from v2.create_oauth_code($1::uuid, $2, $3, $4, $5)", [userId, req.clientId, req.redirectUri, req.codeChallenge, req.resource]);
    return rows[0]?.code ?? null;
  } catch (err) {
    if (err instanceof Error && /unknown client_id|code_challenge|unknown user/.test(err.message)) return null;
    throw err;
  }
}

export interface RedeemedCode {
  user_id: string;
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string;
  expires_at: string;
}

/** Deletes the code as it reads it (single use). Null when unknown. */
export async function redeemOAuthCode(db: SqlExecutor, code: string): Promise<RedeemedCode | null> {
  if (!/^cr_code_[0-9a-f]{48}$/.test(code)) return null;
  const rows = await db.query<RedeemedCode>(
    `select user_id::text as user_id, client_id, redirect_uri, code_challenge,
            to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at
       from v2.redeem_oauth_code($1)`,
    [code],
  );
  return rows[0] ?? null;
}

/** Null when any redirect URI is refused by the registration rules. */
export async function registerOAuthClient(db: SqlExecutor, redirectUris: string[]): Promise<string | null> {
  if (redirectUris.length === 0 || redirectUris.length > 10) return null;
  try {
    const rows = await db.query<{ client_id: string }>("select client_id from v2.register_oauth_client(array(select jsonb_array_elements_text($1::text::jsonb)))", [JSON.stringify(redirectUris)]);
    return rows[0]?.client_id ?? null;
  } catch (err) {
    if (err instanceof Error && /redirect_uri/.test(err.message)) return null;
    throw err;
  }
}
