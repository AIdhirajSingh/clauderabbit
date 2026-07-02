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

/**
 * Build a JSON Response with CORS headers applied. Optional `extraHeaders` lets a
 * caller add response headers (e.g. `Retry-After` on a 429) without losing the
 * CORS headers — they are merged on top of the CORS + content-type defaults.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/** Standard CORS preflight response. */
export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/**
 * Build a STREAMING Response (NDJSON by default) with CORS headers applied. A
 * raw `new Response(stream)` would omit the CORS headers `jsonResponse` adds, so
 * the browser would block every cross-origin streamed scan — this helper makes
 * that impossible to forget. Always HTTP 200; in-band events carry success/error.
 */
export function streamResponse(
  body: ReadableStream<Uint8Array>,
  contentType = "application/x-ndjson",
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    },
  });
}
