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
 * This call, by itself, only runs the static fast-path (clone + static scanners
 * + reputation + a fast model) and DECIDES whether to escalate — it sets the
 * report's `deep` flag but does NOT run the dynamic sandbox. When `deep` is set
 * and `forensics` is absent, the tool then invokes {@link runDeepScan} to trigger
 * the real detonation and re-fetch the sandbox-verified report (see
 * `tools/scan.ts`). Either way, "did the sandbox really run" is keyed off
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
 * report row). `unavailable` = the deployment has no live sandbox wired (an
 * honest static-only result, not a failure).
 */
export async function runDeepScan(
  config: ClaudeRabbitConfig,
  args: { owner: string; repo: string; sha: string },
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
      // A timeout or dropped connection isn't proof of failure — the detonation
      // may still be running and attaching forensics. Signal pending → poll.
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
      // {t:"stage"} progress events are intentionally ignored here: the stdio MCP
      // tool returns a single final result, not a live progress stream (the CLI,
      // which does render live stages, keeps its own onStage-aware copy of this).
      if (e.t === "result") {
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
    return { ok: true, persisted: false, pending: pending || !!error || !sawResult };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Does this polled report genuinely correspond to the commit that was actually
 * escalated and detonated? PURE — no network — so it's unit-testable on its own.
 *
 * This is the exact rail that closes a real bug: `awaitForensics` used to re-call
 * `scanRepo` with the caller's ORIGINAL (often ref-less, i.e. "default branch")
 * args. On a fast-moving repo, the default branch can advance between the
 * escalation-triggering scan and a polling re-fetch a few minutes later — so the
 * "poll" silently returned a FRESH scan of a NEWER commit that was never
 * escalated, and the tool reported that unrelated report as if it were the
 * result of the sandbox run it had just claimed to trigger. A report only counts
 * as "the awaited result" when its `commit_sha` matches the commit that was
 * actually dispatched to the sandbox.
 */
export function isAwaitedForensicsReport(report: Report, expectedSha: string): boolean {
  return report.commit_sha === expectedSha;
}

/**
 * Re-fetch the report until sandbox forensics attach for THIS EXACT escalated
 * commit, or a bound elapses. Used after {@link runDeepScan} to return the final
 * sandbox-verified report rather than the interim static one.
 *
 * `expectedSha` pins every poll to the commit that was actually dispatched: for a
 * GitHub target the poll passes `ref: expectedSha` (GitHub's contents/commits API
 * accepts a full commit SHA as a ref, and the edge function's own cache is keyed
 * on (owner, repo, commit_sha) too), so a moving default branch can never
 * substitute a different, non-escalated commit's report. Each response is ALSO
 * gated on {@link isAwaitedForensicsReport} before being accepted.
 *
 * Returns the latest MATCHING report even if forensics never attach in time
 * (honest: still a real report for the right commit, and `sandboxActuallyRan`
 * reflects the truth) — or null if no matching response was ever seen, so the
 * caller keeps the original escalation-decided report instead of silently
 * swapping in something unrelated.
 */
export async function awaitForensics(
  config: ClaudeRabbitConfig,
  args: ScanArgs,
  token: string,
  expectedSha: string,
  opts?: { tries?: number; delayMs?: number },
): Promise<Report | null> {
  const tries = Math.max(1, opts?.tries ?? 30);
  const delayMs = opts?.delayMs ?? 5_000;
  const pinnedArgs: ScanArgs = args.ecosystem === "npm" ? args : { ...args, ref: expectedSha };
  let last: Report | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await scanRepo(config, pinnedArgs, token);
    if (r.ok && isAwaitedForensicsReport(r.report, expectedSha)) {
      last = r.report;
      if (r.report.forensics) return r.report;
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, delayMs));
  }
  return last;
}

