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

/**
 * A GitHub scan target — unchanged wire shape: `{ owner, repo, ref? }`.
 * `ecosystem` is optional here (defaults to GitHub) so existing callers that
 * build a bare `{ owner, repo }` keep type-checking exactly as before.
 */
export interface GithubScanArgs {
  ecosystem?: "github";
  owner: string;
  repo: string;
  ref?: string;
}

/**
 * An npm scan target — the API scans the REAL published artifact for this
 * package (its tarball + install hooks), NOT a linked GitHub repo. `owner`/
 * `repo`/`ref` are omitted; the edge function re-validates the package name.
 */
export interface NpmScanArgs {
  ecosystem: "npm";
  package: string;
  version?: string;
}

export type ScanArgs = GithubScanArgs | NpmScanArgs;

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

/**
 * Each phase of a scan (e.g. "Static scan") emits two real stage events from
 * the edge function: `status: "active"` when it starts, `status: "done"` when
 * it finishes — a genuine start/complete pair, not a duplicate. `Resolve` and
 * `Verdict` are `done`-only (already-resolved/final steps with no separate
 * "starting" moment). Callers render the two statuses distinctly.
 */
export type StageStatus = "active" | "done";
export type StageListener = (chapter: string, status: StageStatus) => void;

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
        onStage(label, e.status === "active" ? "active" : "done");
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
 * This call, by itself, only runs the static fast-path (clone + static scanners
 * + reputation + a fast model) and DECIDES whether to escalate — it sets the
 * report's `deep` flag but does NOT run the dynamic sandbox. When `deep` is set
 * and `forensics` is absent, the caller then invokes {@link runDeepScan} to
 * trigger the real detonation and re-fetch the sandbox-verified report (see
 * `commands/scan.ts`). Either way, "did the sandbox really run" is keyed off
 * `report.forensics` being present, never off `report.deep` alone.
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
        // npm → { ecosystem, package, version? } (owner/repo omitted); GitHub
        // → { owner, repo, ref? }, byte-identical to before. The edge function
        // re-validates either shape authoritatively.
        body: JSON.stringify(
          args.ecosystem === "npm"
            ? {
                ecosystem: "npm",
                package: args.package,
                ...(args.version ? { version: args.version } : {}),
              }
            : {
                owner: args.owner,
                repo: args.repo,
                ...(args.ref ? { ref: args.ref } : {}),
              },
        ),
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
      // GitHub-specific fallbacks only — for npm the edge returns a precise
      // message (e.g. `npm package "x@1.2.3" was not found…`), already captured
      // into `message` from body.error above; don't clobber it with GitHub copy.
      if (res.status === 404 && args.ecosystem !== "npm") {
        message = "Repository not found. Check the owner and repo name.";
      }
      if (res.status === 429 && args.ecosystem !== "npm") {
        message = "GitHub rate limit hit upstream. Please try again shortly.";
      }
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

/** Outcome of triggering the live sandbox detonation. */
export type DeepResult =
  | { ok: true; persisted: boolean; pending: boolean }
  | { ok: false; error: string; unavailable?: boolean };

/**
 * Trigger the REAL dynamic-sandbox detonation via the SAME production dispatch
 * the website uses — POST `{siteUrl}/api/deep {owner,repo,sha}`. That endpoint
 * is the one true dispatch (Cloud Run REST through the least-privilege
 * `cr-dispatch` service account, bounded by the already-fast-path-escalated
 * report-row precondition + rate limits + the shared gateway's concurrency
 * ceiling — safe to call publicly). This client does NOT re-implement dispatch;
 * it calls that endpoint and streams its real progress, resolving once forensics
 * attach (`persisted`) or while the run is still going (`pending` → poll the
 * report row). `unavailable` means the deployment has no live sandbox wired
 * (e.g. a fork without the dispatch credential) — an honest static-only result,
 * not a failure.
 */
export async function runDeepScan(
  config: ClaudeRabbitConfig,
  args: { owner: string; repo: string; sha: string },
  onStage?: StageListener,
): Promise<DeepResult> {
  const url = `${config.siteUrl}/api/deep`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.deepTimeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: args.owner, repo: args.repo, sha: args.sha }),
        signal: controller.signal,
      });
    } catch (err) {
      // A timeout or dropped connection is NOT proof of failure — the detonation
      // may still be running and attaching forensics. Signal pending so the
      // caller polls the report row rather than declaring failure.
      if (controller.signal.aborted) return { ok: true, persisted: false, pending: true };
      return { ok: false, error: `Could not reach the sandbox controller: ${(err as Error).message}` };
    }
    if (!res.ok || !res.body) {
      let error = "The sandbox run could not start.";
      let unavailable = false;
      try {
        const b = (await res.json()) as { error?: string; reason?: string };
        if (b.reason === "unavailable") {
          error = "A live sandbox isn't available from this deployment — showing the static read only.";
          unavailable = true;
        } else if (typeof b.error === "string" && b.error) {
          error = b.error;
        }
      } catch {
        // non-JSON body — keep the default message
      }
      return { ok: false, error, unavailable };
    }

    // Consume the /api/deep NDJSON stream: {t:"stage"}/{t:"result"}/{t:"pending"}/{t:"error"}.
    let persisted = false;
    let pending = false;
    let error: string | null = null;
    let fatal = false;
    let sawResult = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line: string): void => {
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!ev || typeof ev !== "object") return;
      const e = ev as Record<string, unknown>;
      if (e.t === "stage") {
        if (onStage) {
          const label = typeof e.ch === "string" ? e.ch : typeof e.label === "string" ? e.label : "sandbox";
          onStage(label, e.status === "active" ? "active" : "done");
        }
      } else if (e.t === "result") {
        sawResult = true;
        persisted = e.persisted === true;
      } else if (e.t === "pending") {
        pending = true;
      } else if (e.t === "error") {
        error = typeof e.error === "string" && e.error ? e.error : "The sandbox run failed.";
        fatal = e.fatal === true;
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
    } catch {
      // Mid-stream read failure — the serverless connection was cut, but the
      // detonation is likely still running. Treat as pending → poll.
      return { ok: true, persisted: false, pending: true };
    } finally {
      try {
        await reader.cancel();
      } catch {
        // reader already released
      }
    }
    if (error && fatal) return { ok: false, error };
    if (persisted) return { ok: true, persisted: true, pending: false };
    // A "pending", a non-fatal error, or a stream that just ended (serverless cut
    // the long connection) all mean the run was dispatched and is likely still
    // going — signal pending so the caller polls the report row for forensics.
    return { ok: true, persisted: false, pending: pending || !!error || !sawResult };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Re-fetch the report (via the cache-aware fast-path endpoint) until the sandbox
 * forensics attach, or a bound elapses. Used after {@link runDeepScan} to return
 * the final sandbox-verified report rather than the interim static one. Returns
 * the latest report even if forensics never attach in time (honest: the caller
 * still shows a real report, and `sandboxActuallyRan` reflects the truth).
 */
export async function awaitForensics(
  config: ClaudeRabbitConfig,
  args: ScanArgs,
  token: string,
  opts?: { tries?: number; delayMs?: number },
): Promise<Report | null> {
  const tries = Math.max(1, opts?.tries ?? 30);
  const delayMs = opts?.delayMs ?? 5_000;
  let last: Report | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await scanRepo(config, args, token);
    if (r.ok) {
      last = r.report;
      if (r.report.forensics) return r.report;
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, delayMs));
  }
  return last;
}

