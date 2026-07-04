/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the remote MCP server.
 * Per RFC 9728's well-known URI construction, a resource identifier of
 * `<origin>/mcp` is discovered at `<origin>/.well-known/oauth-protected-resource/mcp`
 * (the well-known suffix is inserted between the host and the resource's own
 * path) — see app/mcp/route.ts's `unauthorized()`, which points clients here
 * via the `WWW-Authenticate` header on a 401.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || new URL(req.url).origin;
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
  });
}
