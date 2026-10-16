/** PKCE (RFC 7636, S256) helpers for the OAuth token route. */

import { createHash } from "node:crypto";

export function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 section 4.1 verifier charset and length, then S256 comparison. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return base64Url(createHash("sha256").update(verifier).digest()) === challenge;
}

export interface StoredCode {
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string;
  expires_at: string;
}

/**
 * RFC 6749 section 4.1.3 checks for an authorization_code redemption:
 * redirect_uri must be present and identical whenever the authorization
 * request carried one, client_id must match the client the code was issued
 * to, the code must be unexpired, and the S256 verifier must match.
 */
export function codeGrantError(row: StoredCode, req: { clientId: string; redirectUri: string; verifier: string }, nowMs: number): "invalid_grant" | "invalid_client" | null {
  if (new Date(row.expires_at).getTime() < nowMs) return "invalid_grant";
  if (row.client_id && req.clientId !== row.client_id) return "invalid_client";
  if (row.redirect_uri && req.redirectUri !== row.redirect_uri) return "invalid_grant";
  if (!pkceMatches(req.verifier, row.code_challenge)) return "invalid_grant";
  return null;
}
