/**
 * Vertex AI Gemini model seam (server-side only).
 *
 * This is THE swap seam for Claude Rabbit's model layer. Today it calls Gemini
 * via the Vertex backend (the $300 GCP credit pays for Vertex, not AI Studio —
 * see docs/INFRASTRUCTURE.md §6). The real models (DeepSeek fast-path, Kimi K2.7
 * in the sandbox) drop in behind the same `generate()` interface later without
 * touching orchestration.
 *
 * Auth: we mint a Google OAuth access token from the service-account JSON using
 * the SA JWT-bearer flow, signed with Deno Web Crypto (RS256). This is robust in
 * Deno and avoids depending on google-auth-library / filesystem access.
 *
 * SECURITY: the service-account JSON, the private key, and the minted token never
 * leave this module and are never logged or returned to a caller.
 *
 * PROMPT CACHING (the cost lever) — IMPLICIT, AUTOMATIC, NO EXPLICIT CACHE.
 * Every scan re-sends the same large analyst methodology (the system prompt /
 * report-design spec) and only the per-repo facts change. Vertex serves all
 * supported Gemini 2.5+ / 3.x models with IMPLICIT context caching enabled by
 * default: its infrastructure caches the KV state of a request's leading tokens
 * and, on a prefix match within the cache window, bills the matched tokens at
 * 10% of the normal input price — automatically, with NO code change and NO
 * `cachedContent` object to manage. Explicit `CachedContent` is deliberately NOT
 * used here: it is mutually exclusive with `systemInstruction` in the same
 * `generateContent` call (the instruction would have to be baked into the cache),
 * which would complicate the clean `generate()` seam for no gain over implicit
 * caching at this prompt size.
 *
 * What we MUST do for implicit hits — and do — is keep the repeating content as a
 * STABLE PREFIX and let only the variable content follow it (Google's stated best
 * practice: "keep the content at the beginning of the request the same and add
 * things like a user's question ... at the end"). Here the caller's `system`
 * (the byte-stable methodology) is sent as `systemInstruction`, which the model
 * processes before `contents`, so it is the leading prefix; the per-repo `prompt`
 * (metadata + flagged regions) is the trailing variable part inside `contents`.
 * `generationConfig` is request config, not content, so it does not perturb the
 * cacheable prefix. Callers therefore get implicit caching for free as long as
 * they pass a constant `system` string (see scan/index.ts `buildSystemPrompt`,
 * which is a static template literal with no interpolation).
 *
 * Observability: `usage.cachedContentTokenCount` (surfaced below from Vertex's
 * `usageMetadata`) is non-zero when a cache hit occurred, so cache effectiveness
 * is measurable without changing the response shape any consumer reads.
 *
 * THRESHOLD CAVEAT (honest): implicit caching only fires above a minimum prefix
 * size (~1k tokens). The fast-tier read prompt (`buildSystemPrompt`, ~430 tokens)
 * is BELOW that, so implicit caching mostly benefits the DEEP/agent tier, whose
 * system prefix carries the full 2026 malware-analysis methodology (well over the
 * threshold). The fast path is already cheap (one short call); we do not pad it
 * just to cross the threshold, so `cachedContentTokenCount` will read 0 there.
 *
 * NOTE for the sandbox/agent tier (sandbox/agent/vertex_client.py, off-limits to
 * this module): the same implicit caching applies to its repeating agent system
 * prompt for free, PROVIDED that client also sends its system instruction as a
 * stable leading prefix. That client is owned by the sandbox lead — flagged here
 * so the same prefix-stability guarantee is verified there.
 */

/** Model tier → which secret holds the model id. */
export type ModelTier = "fast" | "deep";

export interface GenerateOptions {
  tier: ModelTier;
  /** Optional system instruction. */
  system?: string;
  /** The user prompt (the analysis request). */
  prompt: string;
  /** When true, request structured JSON output. */
  json?: boolean;
  /** A Vertex responseSchema (OpenAPI-3.0 subset) for structured output. */
  responseSchema?: unknown;
  /** Output token budget. Defaults high enough for a full structured report. */
  maxOutputTokens?: number;
  /**
   * Thinking budget in tokens. Gemini 2.5 models are thinking models and
   * thinking tokens consume the output budget; default 0 keeps the full budget
   * for the answer so structured JSON is never truncated. The deep tier may
   * pass a positive budget for harder adjudication.
   */
  thinking?: number;
}

export interface GenerateResult {
  /** Concatenated text from the model. */
  text: string;
  /** Parsed JSON when `json` was requested and parsing succeeded. */
  json?: unknown;
  /** Token usage metadata, if returned. */
  usage?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    /**
     * Tokens served from the implicit context cache (billed at 10%). Non-zero
     * means the stable system-prompt prefix hit the cache this call. Surfaced
     * for cost observability; additive, so it never changes an existing shape.
     */
    cachedContentTokenCount?: number;
  };
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

/** Module-scoped token cache (isolates are reused on Supabase edge runtime). */
let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedKey: CryptoKey | null = null;
let cachedServiceAccount: ServiceAccount | null = null;

function getServiceAccount(): ServiceAccount {
  if (cachedServiceAccount) return cachedServiceAccount;
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
  }
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key",
    );
  }
  cachedServiceAccount = parsed;
  return parsed;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

/** Encode a string to a concrete ArrayBuffer (a BufferSource for Web Crypto). */
function toBuffer(str: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(str);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** Convert a PKCS8 PEM private key into the DER bytes Web Crypto expects.
 * Returns a concrete ArrayBuffer (a BufferSource) to satisfy importKey. */
function pemToDer(pem: string): ArrayBuffer {
  // Strip the PEM banner lines (BEGIN/END ...) and ALL whitespace so atob
  // never sees a stray newline/CR/space (which would throw InvalidCharacterError).
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const sa = getServiceAccount();
  let der: ArrayBuffer;
  try {
    der = pemToDer(sa.private_key);
  } catch {
    throw new Error("service-account private_key is not valid PEM/base64");
  }
  try {
    cachedKey = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error(
      "failed to import service-account private key (expected RSA PKCS8)",
    );
  }
  return cachedKey;
}

async function mintAccessToken(): Promise<string> {
  const sa = getServiceAccount();
  const key = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: sa.token_uri || OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${
    base64UrlEncodeString(JSON.stringify(claims))
  }`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    toBuffer(signingInput),
  );
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;

  const res = await fetch(sa.token_uri || OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    // Do not surface the raw OAuth body (may echo request details); log status only.
    await res.body?.cancel();
    // The key may have been rotated out from under a long-lived isolate. Drop
    // the cached key + parsed SA so the next attempt re-reads the env secret.
    cachedKey = null;
    cachedServiceAccount = null;
    cachedToken = null;
    throw new Error(`OAuth token exchange failed (status ${res.status})`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
  };
  return data.access_token;
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (
    !forceRefresh &&
    cachedToken &&
    cachedToken.expiresAt - TOKEN_EXPIRY_SKEW_SECONDS > now
  ) {
    return cachedToken.token;
  }
  return await mintAccessToken();
}

function modelForTier(tier: ModelTier): string {
  const name = tier === "fast"
    ? Deno.env.get("GEMINI_FAST_MODEL")
    : Deno.env.get("GEMINI_DEEP_MODEL");
  if (!name) {
    throw new Error(
      `model secret for tier "${tier}" is not configured (GEMINI_${
        tier === "fast" ? "FAST" : "DEEP"
      }_MODEL)`,
    );
  }
  return name;
}

interface VertexCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface VertexResponse {
  candidates?: VertexCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    /** Implicit-cache hit size (billed at 10%); present when the prefix cached. */
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

/**
 * Resolve the Vertex location for model calls. This is DECOUPLED from the
 * sandbox compute zone on purpose: `VERTEX_LOCATION` selects where Gemini is
 * served (e.g. the `global` endpoint that fronts the GA 3.x models), while the
 * sandbox stays on its own regional compute zone (`GCP_LOCATION`, us-central1).
 * Falls back to `GCP_LOCATION` when `VERTEX_LOCATION` is unset so existing
 * regional deployments keep working unchanged.
 */
function vertexLocation(): string {
  const loc = (Deno.env.get("VERTEX_LOCATION") ?? Deno.env.get("GCP_LOCATION"))?.trim();
  if (!loc) {
    throw new Error("VERTEX_LOCATION or GCP_LOCATION is not configured");
  }
  return loc;
}

function buildEndpoint(model: string): string {
  const project = Deno.env.get("GCP_PROJECT_ID");
  if (!project) {
    throw new Error("GCP_PROJECT_ID is not configured");
  }
  const location = vertexLocation();
  // The `global` endpoint (which serves the GA 3.x models) uses the unprefixed
  // host `aiplatform.googleapis.com` with `locations/global` in the path.
  // Regional locations use the `{location}-aiplatform.googleapis.com` host.
  const host = location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

/**
 * Generate a completion from the selected model tier via Vertex.
 * Retries exactly once on a 401/403 (stale/rotated token) after re-minting.
 */
export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const model = modelForTier(opts.tier);
  const endpoint = buildEndpoint(model);

  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    // Thinking tokens count against the output budget; default 0 protects JSON.
    thinkingConfig: { thinkingBudget: opts.thinking ?? 0 },
  };
  if (opts.json) generationConfig.responseMimeType = "application/json";
  if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig,
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }

  const callOnce = async (token: string): Promise<Response> =>
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  let token = await getAccessToken();
  let res = await callOnce(token);
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    token = await getAccessToken(true); // force re-mint on auth failure
    res = await callOnce(token);
  }

  if (!res.ok) {
    // Never embed the raw Vertex error body in the thrown Error (it can contain
    // the GCP project path/quota names and would flow into exported logs). Log
    // a truncated copy server-side only; surface just the status to callers.
    try {
      const errText = await res.text();
      console.debug("vertex error body (status %d): %s", res.status, errText.slice(0, 300));
    } catch {
      // ignore
    }
    throw new Error(`Vertex generateContent failed (status ${res.status})`);
  }

  const data = (await res.json()) as VertexResponse;

  if (data.promptFeedback?.blockReason) {
    throw new Error(
      `model blocked the prompt (${data.promptFeedback.blockReason})`,
    );
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error("model returned no candidates");
  }
  if (
    candidate.finishReason &&
    candidate.finishReason !== "STOP" &&
    candidate.finishReason !== "MAX_TOKENS"
  ) {
    throw new Error(`model stopped early (finishReason: ${candidate.finishReason})`);
  }

  const text = (candidate.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  const result: GenerateResult = { text, usage: data.usageMetadata };

  if (opts.json) {
    if (candidate.finishReason === "MAX_TOKENS") {
      throw new Error(
        "model output was truncated (MAX_TOKENS); increase maxOutputTokens",
      );
    }
    try {
      result.json = JSON.parse(text);
    } catch {
      throw new Error("model did not return valid JSON");
    }
  }

  return result;
}
