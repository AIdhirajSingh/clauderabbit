/**
 * Thin HTTP client for the real, deployed ClaudeRabbit API — the same public
 * Supabase edge function and PostgREST route the Next.js frontend calls
 * (`lib/scan.ts` runScan, `lib/report-fetch.ts` fetchLatestReportRest). No
 * scanning or scoring logic is reimplemented here; this module only sends the
 * HTTP requests and reshapes the response into `Report`.
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
  | { ok: true; report: Report; stageCount: number }
  | { ok: false; error: string };

/** The exact PostgREST column selection the report page reads (mirrors `lib/report-fetch.ts`). */
const REPORT_SELECT =
  "owner_login,repo_name,commit_sha,score,verdict,cached,deep,summary,confidence,scan_path,stats_json,packages_json,risky_json,logs_json,forensics_json,owners(github_login,display_name,account_age_label,established,public_repos,stars_total,sentiment,sentiment_score,reputation_json)";

interface OwnerRow {
  github_login: string;
  display_name: string | null;
  account_age_label: string | null;
  established: boolean;
  public_repos: number | null;
  stars_total: number | null;
  sentiment: string | null;
  sentiment_score: number | null;
  reputation_json?: unknown;
}

interface ReportRow {
  owner_login: string;
  repo_name: string;
  commit_sha: string;
  score: number;
  verdict: string;
  cached: boolean;
  deep: boolean;
  summary: string | null;
  scan_path: string;
  stats_json: unknown;
  packages_json: unknown;
  risky_json: unknown;
  logs_json: unknown;
  forensics_json?: unknown;
  owners?: OwnerRow | OwnerRow[] | null;
}

function formatNumber(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Reshape a `reports` row (mirrors the main app's `lib/report-row.ts`). */
function reportRowToReport(row: ReportRow): Report {
  const owner = Array.isArray(row.owners) ? (row.owners[0] ?? null) : (row.owners ?? null);
  const statsJson = (row.stats_json ?? {}) as Record<string, unknown>;
  const stars =
    typeof statsJson.stars === "string" ? statsJson.stars : formatNumber(owner?.stars_total ?? null);

  const rj = owner?.reputation_json;
  const reputation =
    rj && typeof rj === "object" && typeof (rj as Record<string, unknown>).stars === "string"
      ? {
          stars: (rj as Record<string, unknown>).stars as string,
          forks:
            typeof (rj as Record<string, unknown>).forks === "string"
              ? ((rj as Record<string, unknown>).forks as string)
              : "—",
          sentiment: owner?.sentiment ?? "",
          sentScore: owner?.sentiment_score ?? 0,
        }
      : { stars, forks: "—", sentiment: owner?.sentiment ?? "", sentScore: owner?.sentiment_score ?? 0 };

  return normalizeReport({
    id: `${row.owner_login}/${row.repo_name}`,
    owner: row.owner_login,
    name: row.repo_name,
    score: row.score,
    verdict: row.verdict,
    cached: row.cached,
    deep: row.deep,
    summary: row.summary ?? "",
    ownerHistory: {
      handle: owner?.github_login ?? row.owner_login,
      name: owner?.display_name ?? row.owner_login,
      age: owner?.account_age_label ?? "unknown",
      established: owner?.established ?? false,
      repos: owner?.public_repos ?? 0,
      note: "",
    },
    reputation,
    stats: {
      loc: typeof statsJson.loc === "string" ? statsJson.loc : "—",
      packages: typeof statsJson.packages === "number" ? statsJson.packages : 0,
      stars,
      created: typeof statsJson.created === "string" ? statsJson.created : "unknown",
    },
    packages: row.packages_json,
    risky: row.risky_json,
    logs: row.logs_json,
    forensics: row.forensics_json,
    commit_sha: row.commit_sha,
  });
}

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
        const body = (await res.json()) as { error?: string };
        if (typeof body.error === "string" && body.error) message = body.error;
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

export type GetReportResult =
  | { ok: true; report: Report }
  | { ok: false; error: string; notFound: boolean };

/**
 * Fetch the latest cached report for owner/repo via the real, public,
 * anonymous PostgREST read — GET {supabaseUrl}/rest/v1/reports?... — the same
 * route the report page's client-side fetch uses. Does not trigger a new
 * scan; returns `notFound: true` when no report row exists yet.
 */
export async function getReport(
  config: ClaudeRabbitConfig,
  owner: string,
  repo: string,
): Promise<GetReportResult> {
  const url =
    `${config.supabaseUrl}/rest/v1/reports?owner_login=eq.${encodeURIComponent(owner)}` +
    `&repo_name=eq.${encodeURIComponent(repo)}` +
    `&select=${encodeURIComponent(REPORT_SELECT)}` +
    `&order=created_at.desc&limit=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${config.supabasePublishableKey}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      return { ok: false, notFound: false, error: `Network error reaching ClaudeRabbit: ${(err as Error).message}` };
    }
    if (!res.ok) {
      return { ok: false, notFound: false, error: `ClaudeRabbit returned HTTP ${res.status}.` };
    }
    let rows: unknown;
    try {
      rows = await res.json();
    } catch {
      return { ok: false, notFound: false, error: "ClaudeRabbit returned an unreadable response." };
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        ok: false,
        notFound: true,
        error: `No cached report exists yet for ${owner}/${repo}. Use scan_repo to run one.`,
      };
    }
    const report = reportRowToReport(rows[0] as ReportRow);
    return { ok: true, report };
  } finally {
    clearTimeout(timeout);
  }
}
