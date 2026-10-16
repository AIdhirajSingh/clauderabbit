/**
 * Configuration from the environment (CLI and stdio MCP server). Only public values: the site the
 * CLI talks to (`/api/scan`, `/cli-auth`, report pages) and the client
 * timeout. No key of any kind lives here.
 *
 *   CLAUDE_RABBIT_SITE_URL          default https://clauderabbit.in
 *   CLAUDE_RABBIT_SCAN_TIMEOUT_MS   default 150000 (server maxDuration 120 s plus slack)
 */

const DEFAULT_SITE_URL = "https://clauderabbit.in";
const DEFAULT_SCAN_TIMEOUT_MS = 150_000;

export interface ClaudeRabbitConfig {
  siteUrl: string;
  scanTimeoutMs: number;
}

export function loadConfig(): ClaudeRabbitConfig {
  const siteUrl = (process.env.CLAUDE_RABBIT_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, "");
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    throw new Error("CLAUDE_RABBIT_SITE_URL must be an absolute http(s) URL.");
  }
  const raw = process.env.CLAUDE_RABBIT_SCAN_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return { siteUrl, scanTimeoutMs: Number.isFinite(n) && n > 0 ? n : DEFAULT_SCAN_TIMEOUT_MS };
}
