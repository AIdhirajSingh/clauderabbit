/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) for the remote MCP login.
 * Authorization at `/oauth/authorize`, dynamic client registration at
 * `/oauth/register`, token exchange at `/oauth/token` (a Vercel function on
 * the server secret; PKCE S256 only, public clients only).
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || new URL(req.url).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["clauderabbit:scan"],
  });
}
