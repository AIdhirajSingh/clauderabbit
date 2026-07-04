/**
 * oauth-token — the OAuth 2.1 token endpoint for the remote (Streamable HTTP)
 * MCP server's login flow (RFC 6749 §4.1.3 "Access Token Request").
 *
 * Machine-to-machine: called by the MCP client's own backend (e.g. claude.ai)
 * after a user completed sign-in at `/oauth/authorize` (a Next.js page using
 * the SAME Google/email auth as the rest of the app) and was redirected back
 * with a short-lived authorization code. This function redeems that code —
 * verifying PKCE (RFC 7636) so only the party that started the flow can
 * finish it — and mints a real `cli_tokens` bearer token: the exact same
 * token type `supabase/functions/scan`'s `verify_cli_token` already accepts
 * from the CLI and stdio MCP server (20260704000001_cli_tokens.sql), so no
 * changes were needed there for the remote server to reuse it.
 *
 * Runs with the service role (this is the one step in the whole OAuth flow
 * that isn't driven by a signed-in browser session) to read/delete the
 * one-time code and insert the new token row — CLAUDE.md's secrets rule
 * (service-role logic lives in edge functions, never in the Next.js app)
 * is why this is a Supabase function and not a Next.js API route.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function oauthError(error: string, status: number): Response {
  // RFC 6749 §5.2 error response shape.
  return jsonResponse({ error }, status);
}

/** Resolve the service key from either the legacy or new Supabase key system. */
function resolveServiceKey(): string {
  const roleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (roleKey) return roleKey;
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object" && typeof entry.key === "string") return entry.key;
        }
      }
    } catch {
      return secretKeys;
    }
  }
  throw new Error("No service key available (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS)");
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return createClient(url, resolveServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** base64url (no padding) — RFC 7636's encoding for the PKCE code_challenge. */
function base64Url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest) === challenge;
}

async function parseBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await req.json();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  // Default: application/x-www-form-urlencoded (RFC 6749's standard shape).
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

const CODE_TTL_GRACE_MS = 0; // expires_at is already the real cutoff

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return oauthError("invalid_request", 405);
  }

  let params: Record<string, string>;
  try {
    params = await parseBody(req);
  } catch {
    return oauthError("invalid_request", 400);
  }

  if (params.grant_type !== "authorization_code") {
    return oauthError("unsupported_grant_type", 400);
  }
  const code = (params.code ?? "").trim();
  const codeVerifier = (params.code_verifier ?? "").trim();
  const redirectUri = (params.redirect_uri ?? "").trim();
  if (!code || !codeVerifier) {
    return oauthError("invalid_request", 400);
  }

  let db: SupabaseClient;
  try {
    db = serviceClient();
  } catch (e) {
    console.error("oauth-token config error:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "server_error" }, 500);
  }

  // Atomically fetch-and-burn the code: a single DELETE ... RETURNING means a
  // retried/duplicated exchange for the same code can succeed AT MOST once,
  // even under concurrent requests.
  const { data: rows, error: deleteError } = await db
    .from("oauth_codes")
    .delete()
    .eq("code", code)
    .select("user_id, client_id, redirect_uri, code_challenge, expires_at")
    .limit(1);

  if (deleteError) {
    console.error("oauth-token lookup failed:", deleteError.message);
    return jsonResponse({ error: "server_error" }, 500);
  }
  const row = rows?.[0];
  if (!row) {
    return oauthError("invalid_grant", 400);
  }
  if (new Date(row.expires_at).getTime() + CODE_TTL_GRACE_MS < Date.now()) {
    return oauthError("invalid_grant", 400);
  }
  if (redirectUri && redirectUri !== row.redirect_uri) {
    return oauthError("invalid_grant", 400);
  }
  if (!(await pkceMatches(codeVerifier, row.code_challenge))) {
    return oauthError("invalid_grant", 400);
  }

  const token = `cr_cli_${Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  const tokenHashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(tokenHashBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { error: insertError } = await db
    .from("cli_tokens")
    .insert({ user_id: row.user_id, token_hash: tokenHash });

  if (insertError) {
    console.error("oauth-token issuance failed:", insertError.message);
    return jsonResponse({ error: "server_error" }, 500);
  }

  return jsonResponse({
    access_token: token,
    token_type: "Bearer",
  });
});
