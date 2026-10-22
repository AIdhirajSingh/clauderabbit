/**
 * Engine configuration from the environment (DESIGN.md section 9).
 *
 * Pure: `loadEngineConfig(env)` reads only the record it is given, so tests pass
 * a literal object and production passes `process.env`. Keys are never logged;
 * `missingKeys` reports only the NAMES of absent required keys.
 */

import { DEFAULT_FX, type FxRate } from "./cost";

/** Luna: the one report call per fresh scan (OpenAI Responses API, OPENAI_API_KEY). */
export const DEFAULT_MODEL_ID = "gpt-6-luna";
/** Jev: every model-judged check (AI Gateway decision model, Vercel OIDC). */
export const DEFAULT_JEV_MODEL_ID = "typesafe-ai/jev";
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
  checkMs: number;
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
  /** Luna's model id (CR_MODEL_ID). */
  modelId: string;
  /** Jev's gateway model id (CR_JEV_MODEL_ID). */
  jevModelId: string;
  /** USD to INR rate for the cost ledger (CR_USD_INR overrides the pinned rate). */
  fx: FxRate;
  reasoningEffort: ReasoningEffort;
  e2bTemplate: string;
  openaiApiKey: string | null;
  e2bApiKey: string | null;
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  /** Pooler URL for the cr_v2_server role (schema v2 only). Server-only; never logged. */
  databaseUrl: string | null;
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

/**
 * Worst-case wall time cr-detonate.sh spends outside install and entry: CA and
 * fence setup 2 s, forge start 5 s, containment probes 6.3 s, extraction 6 s,
 * install kill grace 2 s, .pth scan 2 s, clock check 3 s, entry kill grace 1 s,
 * dependency listing 3 s, written-file listing 5 s, canary search 3 s, fence
 * counters 0.5 s, capture reordering 6 s, trace cuts 1 s, packing 4 s. Each step
 * carries its own `timeout` in the harness.
 */
export const HARNESS_OVERHEAD_MS = 134_000; // extraction now up to 90 s for a whole large repo
/** Budget for the salvage pack after an overrun (lib/engine/sandbox/detonate.ts SALVAGE_MS). */
export const SALVAGE_BUDGET_MS = 8_000;

/**
 * Hard deadlines (DESIGN.md section 2.2). These are ceilings for the worst case,
 * not the target: the owner's 8 s target is measured per stage in the event
 * stream and reported as p50/p95 by scripts/labeled-run.mjs on key day.
 */
export const DEFAULT_DEADLINES: EngineDeadlines = {
  preflightMs: 1_500,
  resolveMs: 4_000,
  fetchMs: 8_000,
  analysisMs: 15_000,
  osvMs: 5_000,
  reachMs: 1_000,
  checkMs: 12_000,
  installMs: 60_000,
  entryMs: 4_000,
  detonateTotalMs: 200_000,
  writerMs: 10_000, // Luna takes 4.5 to 7.3 s; 6 s cut every report off (step 20)
  persistMs: 3_000,
  scanMs: 280_000,
  sandboxTimeoutMs: 220_000,
};

/**
 * Deadlines for a full-install scan (the viewer pressed Yes on "Keep installing
 * to scan it fully?"): the install gets FULL_INSTALL_MS, and the detonation
 * command and the VM are sized to cover it. The scan deadline does not grow:
 * the route's maxDuration (300 s, the most the Vercel plan allows) bounds every
 * scan, so scanMs stays the real limit. A full install that does not fit in it
 * ends as a partial scan with its coverage gaps stated, like any overrun.
 */
export const FULL_INSTALL_MS = 180_000;
export function fullInstallDeadlines(d: EngineDeadlines): EngineDeadlines {
  const installMs = Math.max(d.installMs, FULL_INSTALL_MS);
  const detonateTotalMs = Math.max(d.detonateTotalMs, installMs + d.entryMs + HARNESS_OVERHEAD_MS);
  const sandboxTimeoutMs = Math.max(d.sandboxTimeoutMs, detonateTotalMs + SALVAGE_BUDGET_MS + 10_000);
  return { ...d, installMs, detonateTotalMs, sandboxTimeoutMs };
}

/**
 * The detonation command deadline must cover install, entry and every harness
 * step, or an overrun erases the forensic bundle; the VM must outlive the
 * command plus the salvage; the scan deadline must cover the serial path.
 * Returns the violated rules (empty when consistent).
 */
export function deadlineViolations(d: EngineDeadlines): string[] {
  const out: string[] = [];
  const harness = d.installMs + d.entryMs + HARNESS_OVERHEAD_MS;
  if (d.detonateTotalMs < harness) out.push(`detonateTotalMs ${d.detonateTotalMs} < installMs + entryMs + harness overhead (${harness})`);
  const vm = d.detonateTotalMs + SALVAGE_BUDGET_MS + 10_000;
  if (d.sandboxTimeoutMs < vm) out.push(`sandboxTimeoutMs ${d.sandboxTimeoutMs} < detonateTotalMs + salvage + upload margin (${vm})`);
  const serial = d.resolveMs + d.fetchMs + d.detonateTotalMs + SALVAGE_BUDGET_MS + d.osvMs + d.writerMs + d.persistMs;
  if (d.scanMs < serial) out.push(`scanMs ${d.scanMs} < resolve + fetch + detonation + salvage + OSV pass 2 + writer + persist (${serial})`);
  return out;
}

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
  // "none": measured on the preview's operator smoke, Luna's report took 5.4 s at "low" and 2.7 s at
  // "none" on the same facts, and both outputs passed validateWriterOutput (docs/runs/2.0-keyday.md step 8).
  // The score never comes from Luna, and a rejected output falls back to the deterministic report.
  if (v === null) return "none";
  if (v === "none" || v === "low" || v === "medium" || v === "high") return v;
  throw new Error("CR_MODEL_REASONING_EFFORT must be one of none, low, medium, high");
}

function fxRate(env: Env): FxRate {
  const v = str(env, "CR_USD_INR");
  if (v === null) return { ...DEFAULT_FX };
  if (!/^\d+(?:\.\d+)?$/.test(v) || Number(v) <= 0) throw new Error("CR_USD_INR must be a positive decimal number");
  return { usd_inr: Number(v), source: "CR_USD_INR environment variable", as_of: "configured" };
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
    jevModelId: str(env, "CR_JEV_MODEL_ID") ?? DEFAULT_JEV_MODEL_ID,
    fx: fxRate(env),
    reasoningEffort: reasoningEffort(env),
    e2bTemplate: str(env, "CR_E2B_TEMPLATE") ?? DEFAULT_E2B_TEMPLATE,
    openaiApiKey: str(env, "OPENAI_API_KEY"),
    e2bApiKey: str(env, "E2B_API_KEY"),
    supabaseUrl: str(env, "NEXT_PUBLIC_SUPABASE_URL"),
    supabasePublishableKey: str(env, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    databaseUrl: str(env, "CR_V2_DATABASE_URL"),
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
    deadlines: checkedDeadlines({ ...DEFAULT_DEADLINES }),
  };
}

function checkedDeadlines(d: EngineDeadlines): EngineDeadlines {
  const v = deadlineViolations(d);
  if (v.length > 0) throw new Error(`inconsistent scan deadlines: ${v.join("; ")}`);
  return d;
}

/** Names of the server env vars a fresh scan needs that are absent. */
export function missingKeys(config: EngineConfig): string[] {
  const missing: string[] = [];
  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!config.e2bApiKey) missing.push("E2B_API_KEY");
  if (!config.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!config.supabasePublishableKey) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!config.databaseUrl) missing.push("CR_V2_DATABASE_URL");
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
