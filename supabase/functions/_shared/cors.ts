/**
 * Shared CORS + JSON-response helpers for Claude Rabbit edge functions.
 *
 * The scan endpoint is a public, no-login surface (the first scan is free with
 * no auth — see CLAUDE.md V1 scope), so we allow any origin for now. Auth and
 * per-origin tightening land in a later unit.
 */

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Hygiene for when per-origin tightening replaces the wildcard later.
  "Vary": "Origin",
};

/** Build a JSON Response with CORS headers applied. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

/** Standard CORS preflight response. */
export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
