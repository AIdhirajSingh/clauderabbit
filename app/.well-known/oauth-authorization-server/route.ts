/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) — this app doubles as
 * its own authorization server for the remote MCP endpoint (app/mcp), so
 * this lives at the conventional root well-known location (no path
 * component to insert, unlike the Protected Resource Metadata document).
 *
 * `token_endpoint` points directly at the `oauth-token` Supabase Edge
 * Function rather than a Next.js route: minting a real token means writing
 * to `cli_tokens` with the service role, and CLAUDE.md's secrets rule keeps
 * that logic in an edge function, never in the Next.js app (see
 * supabase/functions/oauth-token/index.ts).
 */
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

export async function GET(req: Request): Promise<Response> {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || new URL(req.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/oauth-token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["clauderabbit:scan"],
  });
}
