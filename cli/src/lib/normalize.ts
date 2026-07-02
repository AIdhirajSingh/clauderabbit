/**
 * Coerce an arbitrary payload from the Claude Rabbit API into the `Report`
 * shape this CLI relies on. Reimplemented standalone from the main app's
 * `lib/scan.ts` (`normalizeReport`) and `lib/report-view.ts`
 * (`enforceVerdict`), mirroring the production-verified `mcp-server/`
 * package — this CLI has no dependency on `lib/`.
 *
 * The one rail that MUST be preserved here: a bare/empty verdict is never
 * passed through as "Safe" (CLAUDE.md — never state a bare "Safe"). If the
 * upstream ever sent one, it is remapped to a score-banded verdict word, same
 * as the web app does both server-side and at render time.
 */

import type {
  Forensics,
  LogChapter,
  OwnerHistory,
  PackageScore,
  Report,
  Reputation,
  RepoStats,
  RiskyItem,
} from "./types.js";

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

const VERDICT_BARE_SAFE = "safe";

/**
 * RAIL: never let a bare "Safe" verdict reach a caller. Mirrors the main
 * app's `enforceVerdict` exactly (same score bands) so the CLI surface never
 * disagrees with the report page on the same repo.
 */
export function enforceVerdict(verdict: string, score: number): string {
  const trimmed = (verdict || "").trim();
  if (!trimmed || trimmed.toLowerCase() === VERDICT_BARE_SAFE) {
    return score >= 90
      ? "Trusted"
      : score >= 80
        ? "Likely safe"
        : score >= 60
          ? "Caution"
          : "High risk";
  }
  return trimmed;
}

function normalizeOwnerHistory(raw: unknown): OwnerHistory {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    handle: str(r.handle, "unknown"),
    name: str(r.name, str(r.handle, "unknown")),
    age: str(r.age, "unknown"),
    established: bool(r.established, false),
    repos: num(r.repos, 0),
    note: str(r.note, ""),
  };
}

function normalizeReputation(raw: unknown): Reputation {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    stars: str(r.stars, "—"),
    forks: str(r.forks, "—"),
    sentiment: str(r.sentiment, ""),
    sentScore: num(r.sentScore, 0),
  };
}

function normalizeStats(raw: unknown): RepoStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    loc: str(r.loc, "—"),
    packages: Math.round(num(r.packages, 0)),
    stars: str(r.stars, "—"),
    created: str(r.created, "unknown"),
  };
}

function normalizePackages(raw: unknown): PackageScore[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const r = (p ?? {}) as Record<string, unknown>;
    return {
      name: str(r.name, "unknown"),
      score: num(r.score, 0),
      note: str(r.note, ""),
    };
  });
}

const VALID_SEVERITY = new Set(["high", "med", "low"]);
const VALID_KIND = new Set(["behavior", "code", "rep"]);

function normalizeRisky(raw: unknown): RiskyItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => {
    const r = (it ?? {}) as Record<string, unknown>;
    const severity = str(r.severity, "low");
    const kind = str(r.kind, "code");
    return {
      title: str(r.title, "Finding"),
      severity: (VALID_SEVERITY.has(severity) ? severity : "low") as RiskyItem["severity"],
      kind: (VALID_KIND.has(kind) ? kind : "code") as RiskyItem["kind"],
      detail: str(r.detail, ""),
    };
  });
}

const VALID_LOG_KIND = new Set(["ok", "warn", "bad"]);

function normalizeLogs(raw: unknown): LogChapter[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const r = (c ?? {}) as Record<string, unknown>;
    const kind = str(r.kind, "ok");
    return {
      ch: str(r.ch, "Scan"),
      kind: (VALID_LOG_KIND.has(kind) ? kind : "ok") as LogChapter["kind"],
      lines: Array.isArray(r.lines)
        ? (r.lines as unknown[]).filter((l): l is string => typeof l === "string")
        : [],
    };
  });
}

/**
 * A forensic record is present ONLY when the sandbox genuinely ran (see
 * `types.ts`). We normalize it loosely — the fields this CLI reads
 * (`verdict.*`, `honesty.*`) are coerced defensively; everything else passes
 * through untouched so we never silently drop upstream data.
 */
function normalizeForensics(raw: unknown): Forensics | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const vRaw = (r.verdict ?? {}) as Record<string, unknown>;
  const hRaw = (r.honesty ?? {}) as Record<string, unknown>;
  return {
    ...r,
    verdict: {
      dynamic_score: num(vRaw.dynamic_score, 0),
      one_word: str(vRaw.one_word, ""),
      headline: str(vRaw.headline, ""),
      attack_egress_intercepted: bool(vRaw.attack_egress_intercepted, false),
      not_verified: Array.isArray(vRaw.not_verified)
        ? (vRaw.not_verified as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
    },
    honesty: {
      possibly_dormant_unverified: bool(hRaw.possibly_dormant_unverified, false),
      notes: Array.isArray(hRaw.notes)
        ? (hRaw.notes as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
    },
  };
}

/** Coerce an arbitrary API payload into a strict `Report`. Never throws. */
export function normalizeReport(raw: unknown): Report {
  const r = (raw ?? {}) as Record<string, unknown>;
  const score = Math.max(0, Math.min(100, Math.round(num(r.score, 0))));
  const owner = str(r.owner, "unknown");
  const name = str(r.name, "unknown");
  const forensics = normalizeForensics(r.forensics ?? r.forensics_json);
  return {
    id: str(r.id, `${owner}/${name}`),
    owner,
    name,
    score,
    verdict: enforceVerdict(str(r.verdict), score),
    cached: bool(r.cached, false),
    deep: bool(r.deep, false),
    summary: str(r.summary, ""),
    ownerHistory: normalizeOwnerHistory(r.ownerHistory),
    reputation: normalizeReputation(r.reputation),
    stats: normalizeStats(r.stats),
    packages: normalizePackages(r.packages),
    risky: normalizeRisky(r.risky),
    logs: normalizeLogs(r.logs),
    ...(forensics ? { forensics } : {}),
    ...(typeof r.commit_sha === "string" && r.commit_sha ? { commit_sha: r.commit_sha } : {}),
  };
}
