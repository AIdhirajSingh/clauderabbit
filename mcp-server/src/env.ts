/**
 * Configuration from the environment (CLI and stdio MCP server). Only public values: the site the
 * CLI talks to (`/api/scan`, `/cli-auth`, report pages) and the client
 * timeout, plus an optional deployment-protection bypass for a protected Vercel Preview.
 *
 *   CLAUDE_RABBIT_SITE_URL           default https://clauderabbit.in
 *   CLAUDE_RABBIT_SCAN_TIMEOUT_MS    default 150000 (server maxDuration 120 s plus slack)
 *   CLAUDE_RABBIT_PROTECTION_BYPASS  optional; sent only as the `x-vercel-protection-bypass`
 *                                    request header, never printed or logged
 */

const DEFAULT_SITE_URL = "https://clauderabbit.in";
const DEFAULT_SCAN_TIMEOUT_MS = 150_000;

export interface ClaudeRabbitConfig {
  siteUrl: string;
  scanTimeoutMs: number;
  protectionBypass?: string;
}

/** Validate and normalise a site origin (CLAUDE_RABBIT_SITE_URL or the CLI's `--api`). */
export function normaliseSiteUrl(raw: string, name = "CLAUDE_RABBIT_SITE_URL"): string {
  const siteUrl = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL.`);
  }
  return siteUrl;
}

export function loadConfig(): ClaudeRabbitConfig {
  const siteUrl = normaliseSiteUrl(process.env.CLAUDE_RABBIT_SITE_URL?.trim() || DEFAULT_SITE_URL);
  const raw = process.env.CLAUDE_RABBIT_SCAN_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  const bypass = process.env.CLAUDE_RABBIT_PROTECTION_BYPASS?.trim();
  return {
    siteUrl,
    scanTimeoutMs: Number.isFinite(n) && n > 0 ? n : DEFAULT_SCAN_TIMEOUT_MS,
    ...(bypass ? { protectionBypass: bypass } : {}),
  };
}
