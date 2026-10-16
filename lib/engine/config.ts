/**
 * Engine configuration from the environment (DESIGN.md section 9).
 *
 * Pure: `loadEngineConfig(env)` reads only the record it is given, so tests pass
 * a literal object and production passes `process.env`. Keys are never logged;
 * `missingKeys` reports only the NAMES of absent required keys.
 */

export const DEFAULT_MODEL_ID = "gpt-6-luna";
export const DEFAULT_E2B_TEMPLATE = "clauderabbit-detonate";
export const DEFAULT_SITE_URL = "https://clauderabbit.in";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface EngineLimits {
  /** Compressed tarball cap (bytes). */
  maxCompressedBytes: number;
  /** Expanded archive cap (bytes). */
  maxExpandedBytes: number;
  /** Expanded archive file-count cap. */
  maxFiles: number;
  /** Full npm packument read cap (bytes). */
  maxPackumentBytes: number;
}

export interface EngineDeadlines {
  preflightMs: number;
  resolveMs: number;
  fetchMs: number;
  analysisMs: number;
  osvMs: number;
  reachMs: number;
  readerMs: number;
  installMs: number;
  entryMs: number;
  detonateTotalMs: number;
  writerMs: number;
  persistMs: number;
  scanMs: number;
  sandboxTimeoutMs: number;
}

export interface AdsenseConfig {
  clientId: string | null;
  slotId: string | null;
  adtest: "on" | "off";
}

export interface EngineConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  e2bTemplate: string;
  openaiApiKey: string | null;
  e2bApiKey: string | null;
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  supabaseSecretKey: string | null;
  siteUrl: string;
  githubToken: string | null;
  adsense: AdsenseConfig;
  /** Null unless CR_OPERATOR_KEY is set and at least 32 characters. */
  operatorKey: string | null;
  dailySandboxSecondsCap: number;
  dailyModelTokensCap: number;
  limits: EngineLimits;
  deadlines: EngineDeadlines;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxCompressedBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 120 * 1024 * 1024,
  maxFiles: 20_000,
  maxPackumentBytes: 24 * 1024 * 1024,
};

/** Hard deadlines from DESIGN.md section 2.2. */
export const DEFAULT_DEADLINES: EngineDeadlines = {
  preflightMs: 1_500,
  resolveMs: 4_000,
  fetchMs: 8_000,
  analysisMs: 15_000,
  osvMs: 5_000,
  reachMs: 1_000,
  readerMs: 12_000,
  installMs: 20_000,
  entryMs: 4_000,
  detonateTotalMs: 30_000,
  writerMs: 10_000,
  persistMs: 3_000,
  scanMs: 75_000,
  sandboxTimeoutMs: 90_000,
};

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | null {
  const v = env[name];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const v = str(env, name);
  if (v === null) return fallback;
  if (!/^\d+$/.test(v)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function reasoningEffort(env: Env): ReasoningEffort {
  const v = str(env, "CR_MODEL_REASONING_EFFORT");
  if (v === null) return "low";
  if (v === "none" || v === "low" || v === "medium" || v === "high") return v;
  throw new Error("CR_MODEL_REASONING_EFFORT must be one of none, low, medium, high");
}

function siteUrl(env: Env): string {
  const v = str(env, "NEXT_PUBLIC_SITE_URL") ?? DEFAULT_SITE_URL;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("NEXT_PUBLIC_SITE_URL must be an absolute URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must be http or https");
  }
  return u.origin;
}

export function loadEngineConfig(env: Env): EngineConfig {
  const operator = str(env, "CR_OPERATOR_KEY");
  return {
    modelId: str(env, "CR_MODEL_ID") ?? DEFAULT_MODEL_ID,
    reasoningEffort: reasoningEffort(env),
    e2bTemplate: str(env, "CR_E2B_TEMPLATE") ?? DEFAULT_E2B_TEMPLATE,
    openaiApiKey: str(env, "OPENAI_API_KEY"),
    e2bApiKey: str(env, "E2B_API_KEY"),
    supabaseUrl: str(env, "NEXT_PUBLIC_SUPABASE_URL"),
    supabasePublishableKey: str(env, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    supabaseSecretKey: str(env, "SUPABASE_SECRET_KEY") ?? str(env, "SUPABASE_SERVICE_ROLE_KEY"),
    siteUrl: siteUrl(env),
    githubToken: str(env, "GITHUB_TOKEN"),
    adsense: {
      clientId: str(env, "NEXT_PUBLIC_ADSENSE_CLIENT_ID"),
      slotId: str(env, "NEXT_PUBLIC_ADSENSE_SLOT_ID"),
      adtest: str(env, "NEXT_PUBLIC_ADSENSE_TEST")?.toLowerCase() === "off" ? "off" : "on",
    },
    operatorKey: operator !== null && operator.length >= 32 ? operator : null,
    dailySandboxSecondsCap: positiveInt(env, "CR_DAILY_SANDBOX_SECONDS_CAP", 20_000),
    dailyModelTokensCap: positiveInt(env, "CR_DAILY_MODEL_TOKENS_CAP", 20_000_000),
    limits: { ...DEFAULT_LIMITS },
    deadlines: { ...DEFAULT_DEADLINES },
  };
}

/** Names of the server env vars a fresh scan needs that are absent. */
export function missingKeys(config: EngineConfig): string[] {
  const missing: string[] = [];
  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!config.e2bApiKey) missing.push("E2B_API_KEY");
  if (!config.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!config.supabaseSecretKey) missing.push("SUPABASE_SECRET_KEY");
  return missing;
}

/** Constant-time comparison of an operator header against CR_OPERATOR_KEY. */
export function isOperatorKey(config: EngineConfig, presented: string | null | undefined): boolean {
  const key = config.operatorKey;
  if (!key || typeof presented !== "string" || presented.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}
