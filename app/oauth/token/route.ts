/**
 * OAuth 2.1 token endpoint for the remote MCP login flow (RFC 6749 section
 * 4.1.3, PKCE per RFC 7636). Redeems the one-time code that `/oauth/authorize`
 * created (oauth_codes, deleted on read so it cannot be replayed), checks
 * expiry, client_id, redirect_uri (required whenever the authorization request
 * carried one) and the S256 code_verifier, then mints a `cr_cli_`
 * token stored only as its SHA-256 hash in cli_tokens: the same token kind
 * `verify_cli_token` accepts from the CLI and stdio MCP. Runs on the server
 * secret; nothing here reaches a client.
 */

import { createHash, randomBytes } from "node:crypto";
import { serviceClient } from "@/lib/engine/store";
import { codeGrantError, type StoredCode } from "@/lib/server/oauth";
import { serverConfig } from "@/lib/server/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function oauthJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache" } });
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length > 8192) throw new Error("body too large");
  if (type.includes("application/json")) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((JSON.parse(text) ?? {}) as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;
  try {
    params = await readParams(req);
  } catch {
    return oauthJson({ error: "invalid_request" }, 400);
  }
  if (params.grant_type !== "authorization_code") return oauthJson({ error: "unsupported_grant_type" }, 400);
  const code = (params.code ?? "").trim();
  const verifier = (params.code_verifier ?? "").trim();
  const redirectUri = (params.redirect_uri ?? "").trim();
  const clientId = (params.client_id ?? "").trim();
  if (!code || !verifier) return oauthJson({ error: "invalid_request" }, 400);

  let db;
  try {
    db = serviceClient(serverConfig());
  } catch {
    return oauthJson({ error: "server_error" }, 500);
  }
  const { data: rows, error } = await db
    .from("oauth_codes")
    .delete()
    .eq("code", code)
    .select("user_id, client_id, redirect_uri, code_challenge, expires_at")
    .limit(1);
  if (error) return oauthJson({ error: "server_error" }, 500);
  const row = rows?.[0] as (StoredCode & { user_id: string }) | undefined;
  if (!row) return oauthJson({ error: "invalid_grant" }, 400);
  const bad = codeGrantError(row, { clientId, redirectUri, verifier }, Date.now());
  if (bad) return oauthJson({ error: bad }, bad === "invalid_client" ? 401 : 400);

  const token = `cr_cli_${randomBytes(32).toString("hex")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const ins = await db.from("cli_tokens").insert({ user_id: row.user_id, token_hash: tokenHash });
  if (ins.error) return oauthJson({ error: "server_error" }, 500);
  return oauthJson({ access_token: token, token_type: "Bearer", scope: "clauderabbit:scan" });
}
