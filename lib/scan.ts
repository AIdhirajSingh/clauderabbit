/**
 * Real scan wiring — calls the deployed `scan` Supabase Edge Function and maps
 * its structured JSON response onto the app's `Report` shape so the SPA can
 * render a live scan exactly the way it renders a demo repo.
 *
 * The function URL is derived from the public Supabase URL; the publishable key
 * is sent as both `apikey` and `Authorization: Bearer` (the function is
 * deployed `--no-verify-jwt`, so the anon key is enough to invoke it). No
 * secret is ever used here (CLAUDE.md: only the publishable key is client-side).
 *
 * Errors are returned as a typed discriminated union — never thrown to the
 * caller — so the UI can branch on a friendly message (network / not-found /
 * rate-limit / generic) and show the existing `failed` state.
 */

import type {
  LogChapter,
  PackageScore,
  Report,
  RiskKind,
  RiskyItem,
  Severity,
} from "./types";
import { enforceVerdict } from "./report-view";

/** A successful scan returns a normalized `Report`; a failure carries a message. */
export type ScanResult =
  | { ok: true; report: Report }
  | { ok: false; error: string };

interface ScanArgs {
  owner: string;
  repo: string;
  ref?: string;
  deviceId?: string;
  userId?: string;
}

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["high", "med", "low"]);
const KINDS: ReadonlySet<string> = new Set<RiskKind>(["behavior", "code", "rep"]);
const LOG_KINDS: ReadonlySet<string> = new Set(["ok", "warn", "bad"]);

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown): boolean {
  return v === true;
}

function normalizePackages(v: unknown): PackageScore[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      name: str(p.name, "package"),
      score: Math.round(num(p.score, 50)),
      note: str(p.note),
    }));
}

function normalizeRisky(v: unknown): RiskyItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .filter((x) => typeof x.title === "string")
    .map((x) => ({
      title: str(x.title),
      severity: (SEVERITIES.has(x.severity as string)
        ? x.severity
        : "low") as Severity,
      kind: (KINDS.has(x.kind as string) ? x.kind : "code") as RiskKind,
      detail: str(x.detail),
    }));
}

function normalizeLogs(v: unknown): LogChapter[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({
      ch: str(l.ch, "Scan"),
      kind: (LOG_KINDS.has(l.kind as string)
        ? l.kind
        : "ok") as LogChapter["kind"],
      lines: Array.isArray(l.lines)
        ? l.lines.filter((s): s is string => typeof s === "string")
        : [],
    }));
}

/**
 * Map an arbitrary structured scan payload (edge-function response OR a row's
 * blended object) onto the strict `Report` shape. Tolerant of missing fields:
 * the edge function already validates and clamps, but we re-coerce so a partial
 * or surprising payload still renders.
 */
export function normalizeReport(raw: unknown): Report {
  const r = (raw ?? {}) as Record<string, unknown>;
  const owner = str(r.owner);
  const name = str(r.name);
  const score = Math.round(num(r.score, 50));

  const ownerHistoryRaw = (r.ownerHistory ?? {}) as Record<string, unknown>;
  const reputationRaw = (r.reputation ?? {}) as Record<string, unknown>;
  const statsRaw = (r.stats ?? {}) as Record<string, unknown>;

  return {
    id: str(r.id) || `${owner}/${name}`,
    owner,
    name,
    score,
    verdict: enforceVerdict(str(r.verdict), score),
    cached: bool(r.cached),
    deep: bool(r.deep),
    summary: str(r.summary),
    ownerHistory: {
      handle: str(ownerHistoryRaw.handle, owner),
      name: str(ownerHistoryRaw.name, owner),
      age: str(ownerHistoryRaw.age, "unknown"),
      established: bool(ownerHistoryRaw.established),
      repos: Math.round(num(ownerHistoryRaw.repos, 0)),
      note: str(ownerHistoryRaw.note),
    },
    reputation: {
      stars: str(reputationRaw.stars, "—"),
      forks: str(reputationRaw.forks, "—"),
      sentiment: str(reputationRaw.sentiment),
      sentScore: Math.round(num(reputationRaw.sentScore, 0)),
    },
    stats: {
      loc: str(statsRaw.loc, "—"),
      packages: Math.round(num(statsRaw.packages, 0)),
      stars: str(statsRaw.stars, "—"),
      created: str(statsRaw.created, "unknown"),
    },
    packages: normalizePackages(r.packages),
    risky: normalizeRisky(r.risky),
    logs: normalizeLogs(r.logs),
  };
}

function functionUrl(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  }
  return `${base.replace(/\/$/, "")}/functions/v1/scan`;
}

/**
 * Run a real scan against the deployed edge function. Always resolves to a
 * `ScanResult` — network and HTTP errors are mapped to friendly messages, never
 * thrown.
 */
export async function runScan(args: ScanArgs): Promise<ScanResult> {
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!key) {
    return { ok: false, error: "Scanner is not configured." };
  }

  let res: Response;
  try {
    res = await fetch(functionUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        owner: args.owner,
        repo: args.repo,
        ...(args.ref ? { ref: args.ref } : {}),
        ...(args.deviceId ? { deviceId: args.deviceId } : {}),
        ...(args.userId ? { userId: args.userId } : {}),
      }),
    });
  } catch {
    return {
      ok: false,
      error: "Network error reaching the scanner. Check your connection and retry.",
    };
  }

  if (!res.ok) {
    // The function returns { error } with a meaningful status code. Prefer the
    // function's specific message; only fall back to a status-derived friendly
    // string when the body gave us nothing specific.
    const GENERIC = "The scan could not be completed.";
    let message = GENERIC;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Non-JSON error body — keep the status-derived fallback below.
    }
    if (message === GENERIC) {
      if (res.status === 404) {
        message = "Repository not found. Check the owner and repo name.";
      } else if (res.status === 429) {
        message = "GitHub rate limit hit. Please try again in a few minutes.";
      }
    }
    return { ok: false, error: message };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, error: "The scanner returned an unreadable response." };
  }

  return { ok: true, report: normalizeReport(payload) };
}
