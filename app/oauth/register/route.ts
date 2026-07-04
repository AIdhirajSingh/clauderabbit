/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) for the remote MCP
 * server's login flow. Called by a brand-new MCP client with no user or
 * session yet, so this is intentionally unauthenticated — it just forwards
 * to `register_oauth_client`, an anon-callable RPC that validates the
 * redirect_uris are https (or loopback) and stores them, so the later
 * `/oauth/authorize` step can reject any redirect_uri that wasn't part of
 * this registration (closing the open-redirect hole DCR would otherwise
 * open). See supabase/migrations/20260704000002_oauth_for_remote_mcp.sql.
 */
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export async function POST(req: Request): Promise<Response> {
  let body: { redirect_uris?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("register_oauth_client", {
    p_redirect_uris: redirectUris,
  });

  if (error || !data?.[0]?.client_id) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  return Response.json({
    client_id: data[0].client_id,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}
