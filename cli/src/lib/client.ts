/**
 * Thin HTTP client for the real, deployed ClaudeRabbit API — the same public
 * Supabase edge function the Next.js frontend calls (`lib/scan.ts` runScan),
 * and the same client the production-verified `mcp-server/` package uses. No
 * scanning or scoring logic is reimplemented here; this module only sends the
 * HTTP request and reshapes the response into `Report`.
 */

import type { ClaudeRabbitConfig } from "./env.js";
import { normalizeReport } from "./normalize.js";
import type { Report } from "./types.js";

export interface ScanArgs {
  owner: string;
  repo: string;
  ref?: string;
}

export type ScanResult =
  | { ok: true; report: Report; stageCount: number; fresh: boolean }
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

export type StageListener = (chapter: string) => void;

/** Consume an NDJSON scan stream, returning the terminal `result` or `error` event. */
async function consumeScanStream(
  body: ReadableStream<Uint8Array>,
  onStage?: StageListener,
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
    const e = ev as StreamEvent & Record<string, unknown>;
    if (e.t === "stage") {
      stageCount += 1;
      if (onStage) {
        const label =
          typeof e.ch === "string"
            ? e.ch
            : typeof e.label === "string"
              ? e.label
              : `stage ${stageCount}`;
        onStage(label);
      }
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
 * Callers MUST key "did the sandbox really run" off `report.forensics` being
 * present, never off `report.deep` alone.
 */
export async function scanRepo(
  config: ClaudeRabbitConfig,
  args: ScanArgs,
  token: string,
  onStage?: StageListener,
): Promise<ScanResult> {
  const url = `${config.supabaseUrl}/functions/v1/scan`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.scanTimeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${token}`,
          "X-ClaudeRabbit-Client": "cli",
        },
        body: JSON.stringify({
          owner: args.owner,
          repo: args.repo,
          ...(args.ref ? { ref: args.ref } : {}),
        }),
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
        const body = (await res.json()) as { error?: string; signInUrl?: string };
        if (typeof body.error === "string" && body.error) message = body.error;
        if (res.status === 401 && typeof body.signInUrl === "string") {
          message = `${message} Run \`clauderabbit login\`, or visit ${body.signInUrl}`;
        }
      } catch {
        // non-JSON error body — keep the status-derived fallback
      }
      if (res.status === 404) message = "Repository not found. Check the owner and repo name.";
      if (res.status === 429) message = "GitHub rate limit hit upstream. Please try again shortly.";
      return { ok: false, error: message };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isStream = (contentType.includes("ndjson") || contentType.includes("event-stream")) && !!res.body;

    if (isStream && res.body) {
      const { report, error, stageCount } = await consumeScanStream(res.body, onStage);
      if (error) return { ok: false, error };
      if (report) return { ok: true, report, stageCount, fresh: true };
      return { ok: false, error: "The scan stream ended without a result. Please retry." };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, error: "ClaudeRabbit returned an unreadable response." };
    }
    // A plain-JSON (non-streamed) body is a cache hit — the edge function
    // returned an existing report rather than running a fresh scan.
    return { ok: true, report: normalizeReport(payload), stageCount: 0, fresh: false };
  } finally {
    clearTimeout(timeout);
  }
}

