/**
 * Shared report-view derivation — the single source of truth for turning a
 * `Report` into the enriched `RepoView` the report UI reads (the prototype's
 * `viewRepo()`). Extracted from `components/spa/state.tsx` so the SAME
 * derivation drives the SPA report screen AND the server-rendered public report
 * page (`app/[owner]/[repo]/page.tsx`) — a demo repo and a live scan result
 * become identical view objects.
 *
 * This module is pure (no React, no "use client") so it is safe to import from
 * both Server Components and Client Components.
 *
 * Per CLAUDE.md: reputation signals and code/behavior signals stay structurally
 * separate, and a bare "Safe" verdict is never produced (the edge function and
 * `enforceVerdict` here both guard this).
 */

import { bandColor, bandGlow, bandLabel, bandTint } from "./score";
import type {
  LogChapter,
  PackageScore,
  Report,
  RiskyItem,
  Severity,
} from "./types";

/** Circumference of the score ring (r=52 → ~327), used for stroke-dashoffset. */
export const RING_CIRC = 327;

const VERDICT_BARE_SAFE = "safe";

// ───────────────────────── derived view types ─────────────────────────

/** A risky item with the prototype's derived severity/kind display fields. */
export interface RiskyItemView extends RiskyItem {
  _sevColor: string;
  _sevLabel: string;
  _kindLabel: string;
}

/** A package score with derived band color + tint. */
export interface PackageScoreView extends PackageScore {
  _color: string;
  _tint: string;
}

/** A log chapter with its derived band color. */
export interface LogChapterView extends LogChapter {
  _color: string;
}

/** A full report enriched with every derived field the report screen reads. */
export interface RepoView extends Omit<Report, "packages" | "risky" | "logs"> {
  _color: string;
  _glow: string;
  _tint: string;
  _band: string;
  _ring: number;
  _hasRisky: boolean;
  _finalNote: string;
  _notVerified: string[];
  _repBar: number;
  _ownerInitial: string;
  _ageColor: string;
  packages: PackageScoreView[];
  risky: RiskyItemView[];
  logs: LogChapterView[];
}

// ───────────── pure derivation helpers (ported from the prototype) ─────────────

function finalNote(score: number): string {
  if (score >= 90)
    return "No malicious behavior observed in our tests. The code read clean and reputation is strong. We did not exhaustively execute every branch, and a clean read is not a guarantee.";
  if (score >= 80)
    return "No malicious behavior observed in our tests. The caveats above are worth noting, and the owner is not yet long-established, but nothing here points to harm.";
  if (score >= 60)
    return "We observed undisclosed install-time behavior. This is not confirmed malicious, but it is more than this tool needs. Run it only inside a sandbox or throwaway environment.";
  return "We observed active credential access or network behavior consistent with malware. Do not run this outside a fully disposable environment. The blocked outbound attempts are themselves the detection signal.";
}

function notVerified(r: Pick<Report, "deep">): string[] {
  const base = [
    "Every conditional and time-triggered branch",
    "Behavior under real credentials (none were present in the sandbox)",
  ];
  if (!r.deep) {
    base.unshift(
      "Full runtime behavior (this repo did not escalate to a sandbox run)",
    );
  }
  return base;
}

function sevColor(severity: Severity): string {
  return severity === "high"
    ? "var(--red)"
    : severity === "med"
      ? "var(--amber)"
      : "var(--blue)";
}
function sevLabel(severity: Severity): string {
  return severity === "high" ? "High" : severity === "med" ? "Medium" : "Low";
}
function kindLabel(kind: RiskyItem["kind"]): string {
  return kind === "behavior" ? "Behavior" : kind === "rep" ? "Reputation" : "Code";
}
export function logColor(kind: LogChapter["kind"]): string {
  return kind === "bad"
    ? "var(--red)"
    : kind === "warn"
      ? "var(--amber)"
      : "var(--green)";
}

/**
 * RAIL ENFORCEMENT: never let a bare "Safe" verdict reach the UI, and ensure a
 * present verdict maps to the score band when it is empty or a bare "Safe".
 * Mirrors the edge function's `enforceVerdictRails` so the rail holds even if a
 * row somehow stored a bare verdict.
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

/**
 * The single derivation. Enriches a plain `Report` (from demo data OR a live
 * scan / DB row, both already normalized to the `Report` shape) into the full
 * `RepoView` the report screen and server page render. This is the prototype's
 * `viewRepo` body, now framework-agnostic.
 */
export function buildReportView(r: Report): RepoView {
  const verdict = enforceVerdict(r.verdict, r.score);
  return {
    ...r,
    verdict,
    _color: bandColor(r.score),
    _glow: bandGlow(r.score),
    _tint: bandTint(r.score),
    _band: bandLabel(r.score),
    _ring: RING_CIRC * (1 - r.score / 100),
    _hasRisky: r.risky.length > 0,
    _finalNote: finalNote(r.score),
    _notVerified: notVerified(r),
    _repBar: r.reputation.sentScore,
    _ownerInitial: (r.ownerHistory.name || "?").slice(0, 1).toUpperCase(),
    _ageColor: r.ownerHistory.established ? "var(--t1)" : "var(--amber)",
    packages: r.packages.map((p) => ({
      ...p,
      _color: bandColor(p.score),
      _tint: bandTint(p.score),
    })),
    risky: r.risky.map((x) => ({
      ...x,
      _sevColor: sevColor(x.severity),
      _sevLabel: sevLabel(x.severity),
      _kindLabel: kindLabel(x.kind),
    })),
    logs: r.logs.map((l) => ({ ...l, _color: logColor(l.kind) })),
  };
}
