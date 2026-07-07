/**
 * Vercel-native Cloud Run Jobs dispatch — the REAL production detonation trigger.
 *
 * The deployed website (app/api/deep) triggers a `cr-detonation` Cloud Run Job
 * execution by calling the Cloud Run Admin v2 REST API directly over HTTPS with a
 * dedicated service-account credential. There is NO dependency on a local `gcloud`
 * CLI or an operator machine being switched on — this is what makes a real visitor's
 * scan on clauderabbit.in actually detonate.
 *
 * Auth mirrors supabase/functions/_shared/vertex.ts: mint a Google OAuth access
 * token from the service-account JSON via the JWT-bearer flow (RS256, Web Crypto),
 * scoped to cloud-platform. The private key never leaves this module and is never
 * logged or returned.
 *
 * CREDENTIAL — `CR_RUN_SA_JSON` is a DEDICATED, LEAST-PRIVILEGE dispatcher service
 * account (`cr-dispatch@…`): it holds only `run.jobs.run` on the single
 * `cr-detonation` job resource plus `actAs` on the job's runtime SA. If this key
 * ever leaks from the Vercel server-side env, its entire blast radius is "can run
 * this one sandbox job" — it cannot read secrets, call Vertex, or touch any other
 * resource. It is a SERVER-side Vercel env var, never `NEXT_PUBLIC_*`, never the
 * client, never the repo.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const RUN_API_HOST = "https://run.googleapis.com";
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

/** Is Vercel-native dispatch configured on this deployment? */
export function cloudRunDispatchConfigured(): boolean {
  return !!process.env.CR_RUN_SA_JSON;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedKey: CryptoKey | null = null;
let cachedServiceAccount: ServiceAccount | null = null;

function getServiceAccount(): ServiceAccount {
  if (cachedServiceAccount) return cachedServiceAccount;
  const raw = process.env.CR_RUN_SA_JSON;
  if (!raw) throw new Error("CR_RUN_SA_JSON is not configured");
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error("CR_RUN_SA_JSON is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("CR_RUN_SA_JSON is missing client_email or private_key");
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

function toBuffer(str: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(str);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** PKCS8 PEM private key → DER bytes for Web Crypto importKey. */
function pemToDer(pem: string): ArrayBuffer {
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
    throw new Error("dispatcher private_key is not valid PEM/base64");
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
    throw new Error("failed to import dispatcher private key (expected RSA PKCS8)");
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
    await res.body?.cancel();
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

/** The dispatch target — project comes from the SA JSON, region/job from env. */
export interface JobTarget {
  project: string;
  region: string;
  job: string;
}

/** Resolve the job target from the configured SA JSON + env (pure once env is set). */
export function resolveJobTarget(): JobTarget {
  const sa = getServiceAccount();
  const project = process.env.CR_RUN_PROJECT ?? sa.project_id;
  if (!project) {
    throw new Error("Cloud Run project not resolvable (no CR_RUN_PROJECT, no SA project_id)");
  }
  return {
    project,
    region: process.env.CR_RUN_REGION ?? "us-central1",
    job: process.env.CR_RUN_JOB_NAME ?? "cr-detonation",
  };
}

/** The Cloud Run Admin v2 `:run` endpoint for a job. Pure. */
export function buildRunUrl(t: JobTarget): string {
  return `${RUN_API_HOST}/v2/projects/${t.project}/locations/${t.region}/jobs/${t.job}:run`;
}

/**
 * Build the RunJob request body that overrides THIS execution's env only (the job
 * template is untouched, so concurrent scans never race each other's inputs — the
 * same guarantee `gcloud run jobs execute --update-env-vars` gives). Pure.
 */
export function buildRunBody(env: Record<string, string>): {
  overrides: { containerOverrides: Array<{ env: Array<{ name: string; value: string }> }> };
} {
  return {
    overrides: {
      containerOverrides: [
        { env: Object.entries(env).map(([name, value]) => ({ name, value })) },
      ],
    },
  };
}

export interface RunResult {
  /** The long-running operation name to poll for completion. */
  operationName: string;
}

/**
 * Trigger one Cloud Run Job execution with per-execution env overrides. Returns the
 * operation name immediately (the execution runs asynchronously; the container then
 * POSTs its own forensic record to attach-forensics). Retries once on 401/403 after
 * re-minting a token (a rotated key under a warm instance).
 */
export async function runCloudRunJob(env: Record<string, string>): Promise<RunResult> {
  const target = resolveJobTarget();
  const url = buildRunUrl(target);
  const body = JSON.stringify(buildRunBody(env));

  const callOnce = async (token: string): Promise<Response> =>
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });

  let token = await getAccessToken();
  let res = await callOnce(token);
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    token = await getAccessToken(true);
    res = await callOnce(token);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    // Surface a bounded detail (this is server-side operator diagnostics; the
    // client-facing route maps it to a friendly message). Never includes the key.
    throw new Error(`Cloud Run jobs.run failed (status ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json()) as { name?: string };
  if (!data.name) throw new Error("Cloud Run jobs.run returned no operation name");
  return { operationName: data.name };
}

export interface OperationStatus {
  done: boolean;
  /** Present iff the execution operation failed. */
  error?: { code?: number; message?: string };
}

/** Poll a long-running Cloud Run operation. Retries once on 401/403. */
export async function getOperation(operationName: string): Promise<OperationStatus> {
  const url = `${RUN_API_HOST}/v2/${operationName}`;
  const callOnce = async (token: string): Promise<Response> =>
    await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  let token = await getAccessToken();
  let res = await callOnce(token);
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    token = await getAccessToken(true);
    res = await callOnce(token);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Cloud Run operation poll failed (status ${res.status})`);
  }
  const data = (await res.json()) as {
    done?: boolean;
    error?: { code?: number; message?: string };
  };
  return { done: data.done === true, error: data.error };
}
