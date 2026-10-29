/**
 * Every /.well-known/* path answers 404. ClaudeRabbit publishes no OAuth or OpenID discovery: /mcp needs no
 * sign-in, so a connector that probes these paths finds nothing and adds the server without sign-in. Without this
 * route the paths fell through to /[owner]/[repo] and redirected to a scan page.
 */

export const dynamic = "force-static";

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
}

export function GET(): Response {
  return notFound();
}

export function HEAD(): Response {
  return new Response(null, { status: 404 });
}
