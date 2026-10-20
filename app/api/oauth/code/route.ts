/**
 * POST /api/oauth/code: the authorization step of the remote MCP OAuth flow.
 * The /oauth/authorize page sends its Supabase session JWT as a bearer plus
 * the client's request; the route checks the session against the Auth server
 * and calls `v2.create_oauth_code` as cr_v2_server, which refuses any
 * client_id / redirect_uri pair that was never registered. Returns a
 * 5-minute, single-use code bound to the PKCE challenge.
 */

import { v2Executor } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";
import { createOAuthCode, sessionUser } from "@/lib/server/v2-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 8192) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const clientId = str(body.client_id, 200);
  const redirectUri = str(body.redirect_uri, 2048);
  const codeChallenge = str(body.code_challenge, 128);
  const resource = body.resource == null ? null : str(body.resource, 2048);
  if (!clientId || !redirectUri || !codeChallenge || (body.resource != null && resource === null)) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  let config;
  let db;
  try {
    config = serverConfig();
    db = v2Executor(config);
  } catch {
    return Response.json({ error: "server_not_configured" }, { status: 503, headers: NO_STORE });
  }
  const userId = await sessionUser(db, config, req.headers.get("authorization"));
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const code = await createOAuthCode(db, userId, { clientId, redirectUri, codeChallenge, resource });
    if (!code) return Response.json({ error: "invalid_client" }, { status: 400, headers: NO_STORE });
    return Response.json({ code }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
