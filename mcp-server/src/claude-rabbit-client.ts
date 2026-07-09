/**
 * Thin HTTP client for the real, deployed ClaudeRabbit API — the same public
 * Supabase edge function the Next.js frontend calls (`lib/scan.ts` runScan).
 * No scanning or scoring logic is reimplemented here; this module only sends
 * the HTTP request and reshapes the response into `Report`.
 */

import type { ClaudeRabbitConfig } from "./env.js";
import { normalizeReport } from "./normalize.js";
import type { Report } from "./types.js";

/** A GitHub repo scan target — `{ owner, repo, ref? }`, exactly as before. */
export interface GithubScanArgs {
  ecosystem?: "github";
  owner: string;
  repo: string;
  ref?: string;
}

/**
 * An npm package scan target. The edge function scans the REAL published
 * registry artifact (the tarball `npm install` fetches, integrity-verified),
 * NOT the GitHub repo its package.json links to — see supabase/functions
 * /_shared/npm.ts. The returned report's owner is `"npm"` and its name is the
 * package name.
 */
export interface NpmScanArgs {
  ecosystem: "npm";
  package: string;
  version?: string;
}

export type ScanArgs = GithubScanArgs | NpmScanArgs;

export type ScanResult =
  | { ok: true; report: Report; stageCount: number }
  | { ok: false; error: string };

interface StreamEvent {
  t?: string;
  report?: unknown;
  error?: string;
}

/** Split a growing buffer into complete NDJSON lines, mirrors `lib/scan.ts` splitNdjson. */
function splitNdjson(prevRest: string, chunk: string): { lines: string[]; rest: string } {
  const combined = prevRest + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.trim()).filter((l) => l.length > 0), rest };
}

/** Consume an NDJSON scan stream, returning the terminal `result` or `error` event. */
async function consumeScanStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ report: Report | null; error: string | null; stageCount: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let report: Report | null = null;
  let error: string | null = null;
  let stageCount = 0;

  const handle = (line: string): void => {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object") return;
    const e = ev as StreamEvent;
    if (e.t === "stage") {
      stageCount += 1;
    } else if (e.t === "result") {
      report = normalizeReport(e.report);
    } else if (e.t === "error") {
      error = typeof e.error === "string" && e.error ? e.error : "The scan failed.";
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const split = splitNdjson(buffer, decoder.decode(value, { stream: true }));
      buffer = split.rest;
      for (const line of split.lines) handle(line);
    }
    const tail = buffer.trim();
    if (tail) handle(tail);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // reader already released
    }
  }

  return { report, error, stageCount };
}

/**
 * Trigger (or hit the cache for) a ClaudeRabbit fast-path scan by calling the
 * real deployed edge function — POST {supabaseUrl}/functions/v1/scan.
 *
 * IMPORTANT (honesty rail): this call, by itself, only ever runs the static
 * fast-path (clone + static scanners + reputation + a fast model) and DECIDES
 * whether the repo looks ambiguous enough to escalate. It sets the report's
 * `deep` flag when escalation is decided, but it does NOT execute the dynamic
 * sandbox — that detonation is a separate, privileged, localhost-only route
 * (`/api/deep`) in the Next.js app that is fail-closed off any public
 * deployment. So a report returned here can have `deep: true` (escalation
 * decided) while still having no `forensics` (sandbox never actually ran).
 * Callers of this client MUST key "did the sandbox really run" off
 * `report.forensics` being present, never off `report.deep` alone.
 */
export async function scanRepo(
  config: ClaudeRabbitConfig,
  args: ScanArgs,
  token: string,
): Promise<ScanResult> {
  const url = `${config.supabaseUrl}/functions/v1/scan`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.scanTimeoutMs);

  // The GitHub body is byte-identical to before (`{ owner, repo, ref? }`, no
  // `ecosystem` field); an npm target sends `{ ecosystem:"npm", package, version? }`.
  // The edge function treats a missing/non-"npm" ecosystem as GitHub.
  const requestBody =
    args.ecosystem === "npm"
      ? {
          ecosystem: "npm" as const,
          package: args.package,
          ...(args.version ? { version: args.version } : {}),
        }
      : {
          owner: args.owner,
          repo: args.repo,
          ...(args.ref ? { ref: args.ref } : {}),
        };

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${token}`,
          "X-ClaudeRabbit-Client": "mcp",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, error: `The scan timed out after ${config.scanTimeoutMs}ms. Please retry.` };
      }
      return { ok: false, error: `Network error reaching ClaudeRabbit: ${(err as Error).message}` };
    }

    if (!res.ok) {
      let message = `ClaudeRabbit returned HTTP ${res.status}.`;
      try {
        const body = (await res.json()) as { error?: string };
        if (typeof body.error === "string" && body.error) message = body.error;
      } catch {
        // non-JSON error body — keep the status-derived fallback
      }
      // These fallbacks are GitHub-specific. For an npm target the edge function
      // returns 404 with a precise registry message (e.g. `npm package "…" was
      // not found on the public registry`) — keep it rather than mislabeling it
      // as a repo/GitHub error.
      const isNpm = args.ecosystem === "npm";
      if (res.status === 404 && !isNpm) message = "Repository not found. Check the owner and repo name.";
      if (res.status === 429 && !isNpm) message = "GitHub rate limit hit upstream. Please try again shortly.";
      return { ok: false, error: message };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isStream = (contentType.includes("ndjson") || contentType.includes("event-stream")) && !!res.body;

    if (isStream && res.body) {
      const { report, error, stageCount } = await consumeScanStream(res.body);
      if (error) return { ok: false, error };
      if (report) return { ok: true, report, stageCount };
      return { ok: false, error: "The scan stream ended without a result. Please retry." };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, error: "ClaudeRabbit returned an unreadable response." };
    }
    return { ok: true, report: normalizeReport(payload), stageCount: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

