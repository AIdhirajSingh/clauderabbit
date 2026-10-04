/**
 * Vertex AI Gemini model seam (server-side only).
 *
 * This is THE swap seam for ClaudeRabbit's model layer. Today it calls Gemini
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

/** Which backend serves a call — see `modelBackend()`. */
export type ModelBackend = "dialogflow" | "vertex";

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
  /** Pin this call to a backend, overriding the env flags. */
  backend?: ModelBackend;
}

export interface GenerateResult {
  /** Concatenated text from the model. */
  text: string;
  /** Billable model requests this call made (2 when a schema repair ran). */
  calls?: number;
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
 * Which backend serves model calls.
 *  - `vertex` (DEFAULT): Gemini via Vertex `generateContent` — billed as Vertex
 *    AI, which no credit on this billing account covers.
 *  - `dialogflow`: the same Gemini model run as a Conversational Agents
 *    (Dialogflow CX) GENERATOR, billed as a Conversational Agents generative
 *    request — the SKU family the account's generative trial credits pay for.
 * The code default stays `vertex` so a missing secret can never break scans;
 * `CR_MODEL_BACKEND=dialogflow` switches to the credit path and
 * `CR_MODEL_BACKEND=vertex` (or unsetting it) is the one-step switch back.
 */
export function parseBackend(v: string | null | undefined): ModelBackend | undefined {
  const t = v?.trim().toLowerCase();
  return t === "vertex" || t === "dialogflow" ? t : undefined;
}

/**
 * Backend for a tier: `CR_MODEL_BACKEND_FAST` / `CR_MODEL_BACKEND_DEEP` win for
 * their tier (so one call can stay on direct Vertex while the rest move), then
 * `CR_MODEL_BACKEND`, then the default `vertex`.
 */
export function modelBackend(tier?: ModelTier): ModelBackend {
  const perTier = tier ? parseBackend(Deno.env.get(`CR_MODEL_BACKEND_${tier.toUpperCase()}`)) : undefined;
  return perTier ?? parseBackend(Deno.env.get("CR_MODEL_BACKEND")) ?? "vertex";
}

/**
 * Generate a completion from the selected model tier on the configured backend
 * (or on `opts.backend` when a caller pins one — the operator probe does).
 */
export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  return (opts.backend ?? modelBackend(opts.tier)) === "dialogflow"
    ? await generateDialogflow(opts)
    : await generateDirectVertex(opts);
}

/**
 * Original path: Gemini via Vertex `generateContent`.
 * Retries exactly once on a 401/403 (stale/rotated token) after re-minting.
 */
async function generateDirectVertex(opts: GenerateOptions): Promise<GenerateResult> {
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

  const result: GenerateResult = { text, usage: data.usageMetadata, calls: 1 };

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

function schemaInstruction(schema: unknown): string {
  return [
    "",
    "OUTPUT FORMAT (mandatory): reply with exactly ONE JSON object and nothing else —",
    "no prose, no markdown, no code fences. It MUST validate against this JSON Schema",
    "(every `required` key present, types exact, enum values verbatim, integers as integers):",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Repair the two ways an unconstrained model breaks JSON when it quotes code:
 * a backslash that is not a legal JSON escape (Windows paths, regexes:
 * "C:\Users", "\d+") and raw control characters (newline, tab) inside a string.
 * Only string contents are touched. Runs only after a strict parse has failed.
 */
export function sanitizeJsonText(t: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === "\\") {
      const n = t[i + 1];
      // \b and \f are treated as literal backslashes: this only runs after a strict
      // parse failed, and model prose means "scripts\find", not a form feed.
      if (n !== undefined && '"\\/nrt'.includes(n)) {
        out += c + n;
        i++;
      } else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(i + 2, i + 6))) {
        out += t.slice(i, i + 6);
        i += 5;
      } else {
        out += "\\\\"; // lone backslash -> escaped backslash
      }
      continue;
    }
    if (c === '"') {
      inStr = false;
      out += c;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += c;
  }
  return out;
}

function parseLenient(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(sanitizeJsonText(body));
  }
}

/** Pull the JSON object out of a reply that may carry fences or stray prose. */
export function extractJsonObject(text: string): unknown {
  // A clean object first: a valid reply may itself contain ``` inside a string
  // (a summary quoting code), which the fence match below would cut apart.
  try {
    return parseLenient(text.trim());
  } catch {
    // fall through to fence / brace extraction
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return parseLenient(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) return parseLenient(body.slice(start, end + 1));
    throw new Error("no JSON object in model reply");
  }
}

/**
 * Validate a value against the OpenAPI-3.0 subset the scan schemas use
 * (type / properties / required / items / enum / nullable). Returns the list of
 * violations (empty = valid). Mirrors what Vertex's responseSchema enforced.
 */
export function validateAgainstSchema(value: unknown, schema: unknown, path = "$"): string[] {
  const s = schema as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    enum?: unknown[];
    nullable?: boolean;
  };
  if (!s || typeof s !== "object") return [];
  if (value === null) return s.nullable ? [] : [`${path}: null not allowed`];
  const errs: string[] = [];
  switch (s.type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
      const obj = value as Record<string, unknown>;
      for (const k of s.required ?? []) if (!(k in obj)) errs.push(`${path}.${k}: missing`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        if (k in obj) errs.push(...validateAgainstSchema(obj[k], sub, `${path}.${k}`));
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) return [`${path}: expected array`];
      value.forEach((v, i) => errs.push(...validateAgainstSchema(v, s.items, `${path}[${i}]`)));
      break;
    case "string":
      if (typeof value !== "string") errs.push(`${path}: expected string`);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) errs.push(`${path}: expected integer`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errs.push(`${path}: expected number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errs.push(`${path}: expected boolean`);
      break;
  }
  if (s.enum && !s.enum.includes(value)) errs.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  return errs;
}


/** A model failure that still records how many billable requests it made. */
export class ModelCallError extends Error {
  constructor(message: string, readonly calls: number) {
    super(message);
  }
}

// --- Conversational Agents (Dialogflow CX) generator backend ----------------
//
// One agent (CR_DF_AGENT_ID, location global) carries two generators whose text
// prompt is exactly "$system $prompt": `cr-fast` (gemini-3.1-flash-lite — the same
// model the direct fast read uses — temperature 0.2, 8192-token limit) fired by the
// custom event `cr_fast`, and `cr-deep` (gemini-2.5-flash, temperature 0.2, 8192)
// fired by `cr_deep`. The caller's system instruction and prompt travel as SESSION
// PARAMETERS (detect-intent text input is capped at 256 chars; parameters are not)
// and the reply comes back in the session parameter `cr_result` (response
// messages are capped at 4,000 chars; parameters are not). Generators have no
// responseSchema, so structured output is enforced exactly as before: the schema
// is stated in the system text, the reply is parsed and validated against the
// SAME schema the direct path enforces, with one corrective call before failing.

const DF_EVENT: Record<ModelTier, string> = { fast: "cr_fast", deep: "cr_deep" };

interface DetectIntentResponse {
  queryResult?: {
    parameters?: Record<string, unknown>;
    responseMessages?: Array<{ text?: { text?: string[] } }>;
  };
}

function dialogflowEndpoint(): string {
  const project = Deno.env.get("GCP_PROJECT_ID");
  const agent = Deno.env.get("CR_DF_AGENT_ID")?.trim();
  if (!project) throw new Error("GCP_PROJECT_ID is not configured");
  if (!agent) throw new Error("CR_DF_AGENT_ID is not configured");
  return `https://dialogflow.googleapis.com/v3/projects/${project}/locations/global/agents/${agent}/sessions/${crypto.randomUUID()}:detectIntent`;
}

async function callDialogflow(tier: ModelTier, system: string, prompt: string): Promise<string> {
  const body = {
    queryInput: { event: { event: DF_EVENT[tier] }, languageCode: "en" },
    queryParams: { parameters: { system, prompt } },
  };
  const callOnce = async (token: string): Promise<Response> =>
    await fetch(dialogflowEndpoint(), {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  let res = await callOnce(await getAccessToken());
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    res = await callOnce(await getAccessToken(true)); // force re-mint on auth failure
  }
  if (!res.ok) {
    // Same rule as the direct path: never put the raw error body in the Error.
    try {
      const errText = await res.text();
      console.debug("dialogflow error body (status %d): %s", res.status, errText.slice(0, 300));
    } catch {
      // ignore
    }
    throw new Error(`Dialogflow detectIntent failed (status ${res.status})`);
  }
  const data = (await res.json()) as DetectIntentResponse;
  const out = data.queryResult?.parameters?.cr_result;
  if (typeof out === "string" && out.length > 0) return out;
  throw new Error("generator returned no output (cr_result empty)");
}

async function generateDialogflow(opts: GenerateOptions): Promise<GenerateResult> {
  const wantsJson = Boolean(opts.json || opts.responseSchema);
  const system = (opts.system ?? "") +
    (opts.responseSchema ? schemaInstruction(opts.responseSchema) : opts.json ? "\nReply with a single JSON object only." : "");

  let text = await callDialogflow(opts.tier, system, opts.prompt);
  if (!wantsJson) return { text, calls: 1 };

  // One corrective call if the reply is not a schema-valid object. Generators are
  // single-turn, so the bad reply and the problems are appended to the prompt.
  for (let attempt = 0; ; attempt++) {
    let parsed: unknown;
    let problems: string[];
    try {
      parsed = extractJsonObject(text);
      problems = opts.responseSchema ? validateAgainstSchema(parsed, opts.responseSchema) : [];
    } catch {
      problems = ["reply was not a parseable JSON object"];
    }
    if (problems.length === 0) return { text, json: parsed, calls: attempt + 1 };
    if (attempt === 0) {
      // Each repair is a second billable request: log it so the rate is visible.
      console.warn("dialogflow repair (%s tier): %s", opts.tier, problems.slice(0, 5).join("; "));
    }
    if (attempt >= 1) {
      console.error("dialogflow JSON invalid after retry: %s", problems.slice(0, 5).join("; "));
      console.debug("dialogflow unparseable reply head: %s ... tail: %s", text.slice(0, 300), text.slice(-200));
      throw new ModelCallError("model did not return valid JSON", attempt + 1);
    }
    const repair = `${opts.prompt}\n\nYOUR PREVIOUS REPLY:\n${text.slice(0, 20_000)}\n\n` +
      `It did not validate: ${problems.slice(0, 20).join("; ")}. ` +
      "Return the corrected JSON object only, same content, fixing just these problems.";
    text = await callDialogflow(opts.tier, system, repair);
  }
}
