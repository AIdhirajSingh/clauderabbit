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
