/**
 * Configuration for the ClaudeRabbit CLI.
 *
 * ClaudeRabbit is a free, no-login, public product: the Supabase URL and the
 * Supabase PUBLISHABLE key are not secrets. They are the exact two values the
 * ClaudeRabbit web app itself ships in its client bundle (see the repo root
 * `.env.example` and `docs/INFRASTRUCTURE.md` — the publishable key is
 * explicitly documented as safe client-side). This CLI ships with them as
 * built-in defaults so it works with zero setup, and lets them be overridden
 * via env vars for a fork or a future production deployment.
 *
 * These are the SAME defaults the production-verified `mcp-server/` package
 * uses, so the CLI hits the same live API.
 */

/** Default Supabase project URL (ClaudeRabbit's production project). */
const DEFAULT_SUPABASE_URL = "https://mjvlczaytkhvsolnhhkz.supabase.co";

/** Default Supabase publishable key (client-safe, matches the web app). */
const DEFAULT_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_HAPgnT9M5Sr166Se8Nx0yg_qxzn-08B";

/** Default public site origin for building report-page and sign-in links. */
const DEFAULT_SITE_URL = "https://clauderabbit.in";

/** Default ceiling on how long `scan` will wait for a fresh scan to finish. */
const DEFAULT_SCAN_TIMEOUT_MS = 120_000;

export interface ClaudeRabbitConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  siteUrl: string;
  scanTimeoutMs: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Read and validate configuration from the environment, with safe public defaults. */
export function loadConfig(): ClaudeRabbitConfig {
  const supabaseUrl = trimTrailingSlash(
    process.env.CLAUDE_RABBIT_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL,
  );
  const supabasePublishableKey =
    process.env.CLAUDE_RABBIT_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    DEFAULT_SUPABASE_PUBLISHABLE_KEY;
  const siteUrl = trimTrailingSlash(
    process.env.CLAUDE_RABBIT_SITE_URL?.trim() || DEFAULT_SITE_URL,
  );
  const timeoutRaw = process.env.CLAUDE_RABBIT_SCAN_TIMEOUT_MS?.trim();
  const parsedTimeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  const scanTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : DEFAULT_SCAN_TIMEOUT_MS;

  if (!supabaseUrl) {
    throw new Error("CLAUDE_RABBIT_SUPABASE_URL resolved to an empty value.");
  }
  if (!supabasePublishableKey) {
    throw new Error(
      "CLAUDE_RABBIT_SUPABASE_PUBLISHABLE_KEY resolved to an empty value.",
    );
  }

  return { supabaseUrl, supabasePublishableKey, siteUrl, scanTimeoutMs };
}
