/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) for the remote MCP
 * server's login flow. Called by a brand-new MCP client with no user or
 * session yet, so this is intentionally unauthenticated. It calls
 * `v2.register_oauth_client` as cr_v2_server, which validates that every
 * redirect_uri is https (or loopback) and stores them, so the later
 * `/oauth/authorize` step can reject any redirect_uri that was not part of
 * this registration. See supabase/migrations/20261016000002_v2_auth_rate_limit.sql.
 */

import { v2Executor } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";
import { registerOAuthClient } from "@/lib/server/v2-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: { redirect_uris?: unknown };
  try {
    const text = await req.text();
    if (text.length > 16_384) return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
    body = JSON.parse(text) as { redirect_uris?: unknown };
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }

  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (redirectUris.length === 0) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  let clientId: string | null;
  try {
    clientId = await registerOAuthClient(v2Executor(serverConfig()), redirectUris);
  } catch {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  if (!clientId) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  return Response.json({
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}
