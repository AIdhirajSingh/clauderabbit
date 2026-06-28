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
  Forensics,
  ForensicsGeolocation,
  ForensicsNetworkAttempt,
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

// ───────────────────────── forensics view ─────────────────────────

/** A network attempt with its band color + a one-line geolocation label. */
export interface ForensicsAttemptView extends ForensicsNetworkAttempt {
  _color: string;
  _geoLabel: string;
}

/**
 * A single captured payload, decoded INERT for display. `text` is the decoded
 * (never delivered) payload; `truncated` flags when we capped its length.
 */
export interface ForensicsPayloadView {
  host: string | null;
  text: string;
  bytesLen: number;
  truncated: boolean;
}

/**
 * The forensic record enriched with the derived display fields the forensic
 * section reads. Pure (no React). Built only when a report carries `forensics`.
 */
export interface ForensicsView {
  raw: Forensics;
  /** Verdict color from the dynamic score (the one shared band logic). */
  _verdictColor: string;
  _verdictGlow: string;
  _verdictTint: string;
  _verdictBand: string;
  /** The honest one-word verdict, never a bare "Safe". */
  _verdictWord: string;
  _headline: string;
  /** Network attempts that actually named a destination (the meaningful rows). */
  _namedAttempts: ForensicsAttemptView[];
  /** Count of additional blocked attempts with no resolved host (TLS-failed noise). */
  _blockedNoHostCount: number;
  /** Decoded would-be exfil payloads, captured inert. */
  _payloads: ForensicsPayloadView[];
  /** The captured C2/destination hosts (intelligence only). */
  _capturedHosts: string[];
  /** True when the run was caught attempting egress / credential theft. */
  _caughtAttack: boolean;
  /** True when the code ran but did nothing observable (reported as unverified). */
  _possiblyDormant: boolean;
  /** The honest "not verified" notes for this run. */
  _notVerified: string[];
  /** A concise board marker, e.g. "Caught calling exfil.evil-c2.example". */
  _boardMarker: string | null;
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
  /** The enriched forensic record, present only for escalated/deep repos. */
  _forensics?: ForensicsView;
  /**
   * The HONEST "the sandbox actually ran" signal — true ONLY when a forensic
   * record is present. Drives the runtime-vs-static verdict language and the
   * Sandbox-run-vs-Static-read badge. Never the bare `deep`/`scan_path` flag,
   * which only records that escalation was DECIDED, not that it executed.
   */
  _ranSandbox: boolean;
}

// ───────────── pure derivation helpers (ported from the prototype) ─────────────

/**
 * The final-verdict note. `ranSandbox` is the HONEST signal — true ONLY when the
 * sandbox actually ran and produced a forensic record. When it is false the note
 * speaks strictly in static terms: it never claims "we observed [runtime]" or
 * "blocked outbound attempts" for a scan that was never executed (BUG-2, the
 * canary). The runtime-claim language is reserved for scans that genuinely ran.
 */
function finalNote(score: number, forensics: ForensicsView | undefined): string {
  // STATIC path (no forensic record): speak strictly in static terms. Never claim
  // "we observed [runtime]" or "blocked outbound attempts" for a scan that was
  // never executed (BUG-2, the canary). Keyed on the score band.
  if (!forensics) {
    if (score >= 90)
      return "No malicious behavior in our static read, and reputation is strong. Runtime was not executed in a sandbox on this pass, so this is a static-read clearance, not a guarantee.";
    if (score >= 80)
      return "No malicious behavior in our static read. The caveats above are worth noting and the owner is not yet long-established. Runtime was not executed in a sandbox on this pass.";
    if (score >= 60)
      return "Static analysis flagged undisclosed install-time behavior. This is not confirmed malicious, but it is more than this tool needs, and runtime was not executed in a sandbox on this pass. Run it only inside a sandbox or throwaway environment.";
    return "Static analysis flagged behavior consistent with malware — install-time network/shell execution, credential access, or obfuscation. Runtime was not executed in a sandbox on this pass, so this is a static-read warning, not an observed detonation. Treat it as dangerous and run it only inside a fully disposable environment.";
  }

  // RAN in the sandbox (escalation OWNS the report): state what running it showed
  // with CONFIDENCE — no "unverified / not a guarantee / only partially exercised /
  // the run was limited" hedge (U1). The run is the point, not a caveat. The two
  // rails that remain are not hedges: never a bare "Safe" (the verdict carries
  // evidence), and the low-score reason names the static + reputation concerns
  // (explanation, not a hedge). Caught-attack language must survive (never softened).
  if (forensics._caughtAttack) {
    return "We ran it in the sandbox and caught it attempting credential access or outbound exfiltration. Every outbound attempt was intercepted and never reached its destination. This is malware behavior; do not run it outside a fully disposable environment.";
  }
  // Ran, nothing malicious observed. Say exactly that, plainly. When the score is
  // low it is driven by the static read + reputation, which we NAME as the reason.
  if (score >= 60)
    return "We ran it in the sandbox and observed no malicious behavior, credential access, or outbound exfiltration.";
  return "We ran it in the sandbox and observed no malicious behavior, credential access, or outbound exfiltration. The score is driven by the static-read and reputation concerns above. Run it only inside a sandbox or throwaway environment.";
}

function notVerified(ranSandbox: boolean): string[] {
  // U1: an escalated repo (the sandbox RAN it) carries NO "what we could not verify"
  // list — running the code is the point, not a caveat, and the report states what
  // the run showed with confidence. The list is for STATIC reads only, where it is
  // genuinely true that runtime was not exercised.
  if (ranSandbox) return [];
  return [
    "Full runtime behavior (this repo was not executed in a sandbox on this pass)",
    "Every conditional and time-triggered branch",
    "Behavior under real credentials (no sandbox was run on this pass)",
  ];
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

// ───────────── forensics derivation helpers (pure) ─────────────

/** Max characters of a decoded payload we surface inline (kept readable). */
const PAYLOAD_PREVIEW_MAX = 1400;

/**
 * Hard cap on how many entries we iterate from any array in the hostile
 * `forensics_json`. `buildForensicsView` runs at SSR on attacker-controlled
 * data (and on demo rows that never passed through the scan normalizer), so a
 * record with a huge array must not be able to spike SSR memory.
 */
const MAX_FORENSIC_ITEMS = 200;

/** A one-line geolocation label for a network attempt, or "" when unknown. */
function geoLabel(host: string | null, geos: ForensicsGeolocation[]): string {
  // Only attribute a geolocation to the host it actually belongs to. No
  // `geos[0]` fallback — attributing one host's geo to a different host would
  // misrepresent the forensic record.
  const g = geos.find((x) => x.host && host && x.host === host);
  if (!g) return "";
  const parts = [g.city, g.region, g.country].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const place = parts.join(", ");
  if (place && g.org) return `${place} · ${g.org}`;
  return place || g.org || "";
}

/**
 * Strip characters that could misrepresent a captured payload on the public
 * forensic page: C0 control chars (keeping `\n` and `\t`), DEL, and Unicode
 * bidi overrides/isolates. This prevents ANSI/bidi tricks from making the inert
 * payload render as something other than the bytes that were actually captured.
 */
function sanitizePayloadText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g, "�");
}

/** Decode a base64 would-be payload to readable text, inert. Returns "" on failure. */
function decodeInertPayload(b64: string): string {
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      // Reconstruct UTF-8 text from the binary string where possible.
      try {
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return sanitizePayloadText(new TextDecoder().decode(bytes));
      } catch {
        return sanitizePayloadText(bin);
      }
    }
    // Node / SSR fallback.
    const BufferCtor = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }).Buffer;
    if (BufferCtor) return sanitizePayloadText(BufferCtor.from(b64, "base64").toString("utf-8"));
  } catch {
    return "";
  }
  return "";
}

/**
 * Build the enriched forensic view from a raw record. Pure — usable from a
 * Server Component and the SPA. Returns undefined when there is no record.
 */
export function buildForensicsView(f: Forensics | undefined): ForensicsView | undefined {
  if (!f) return undefined;
  const v = f.verdict;
  const score = typeof v.dynamic_score === "number" ? v.dynamic_score : 50;
  const geos = f.network_intent.geolocations ?? [];

  // Attempts that named a destination are the meaningful rows; the rest are
  // blocked TLS-handshake-failed noise we summarize as a single count. Cap the
  // hostile array before mapping so it can't spike SSR memory.
  const namedRaw = f.network_intent.attempts
    .slice(0, MAX_FORENSIC_ITEMS)
    .filter((a) => a.intended_host || a.sni || a.http_host_header);
  const namedAttempts: ForensicsAttemptView[] = namedRaw.map((a) => {
    const host = a.intended_host ?? a.http_host_header ?? a.sni;
    return {
      ...a,
      _color: bandColor(score),
      _geoLabel: geoLabel(host, geos),
    };
  });
  const blockedNoHostCount = f.network_intent.attempts.length - namedRaw.length;

  // Decode the captured would-be payloads, inert. Prefer the b64 on the attempt
  // (the raw captured bytes); fall back to the analysis text.
  const payloads: ForensicsPayloadView[] = [];
  for (const a of namedRaw) {
    if (!a.would_be_payload_b64) continue;
    const decoded = decodeInertPayload(a.would_be_payload_b64);
    if (!decoded.trim()) continue;
    const truncated = decoded.length > PAYLOAD_PREVIEW_MAX;
    payloads.push({
      host: a.intended_host ?? a.http_host_header ?? a.sni,
      text: truncated ? decoded.slice(0, PAYLOAD_PREVIEW_MAX) : decoded,
      bytesLen: a.payload_len ?? decoded.length,
      truncated,
    });
  }
  // If no attempt carried inline bytes, surface any analyzed decoded payloads.
  if (payloads.length === 0) {
    for (const p of f.payload_analysis.decoded_payloads.slice(0, MAX_FORENSIC_ITEMS)) {
      if (!p.text || !p.text.trim()) continue;
      // This text comes straight from the hostile record (it never went through
      // decodeInertPayload), so sanitize bidi/control chars here too.
      const clean = sanitizePayloadText(p.text);
      const truncated = clean.length > PAYLOAD_PREVIEW_MAX;
      payloads.push({
        host: p.host,
        text: truncated ? clean.slice(0, PAYLOAD_PREVIEW_MAX) : clean,
        bytesLen: p.bytes_len,
        truncated,
      });
    }
  }

  const capturedHosts = Array.from(
    new Set(
      [
        ...v.captured_network_intent,
        ...f.network_intent.intended_destinations
          .map((d) => d.host)
          .filter((h): h is string => !!h),
      ].filter(Boolean),
    ),
  );

  const caughtAttack =
    !!v.attack_egress_intercepted ||
    f.in_vm_behavior.high_value_credential_reads > 0 ||
    capturedHosts.length > 0;

  const possiblyDormant = f.honesty.possibly_dormant_unverified;
  const notVerified =
    f.honesty.notes.length > 0 ? f.honesty.notes : v.not_verified;

  // The board marker: the C2/destination it was caught calling, plus geo when
  // known. Never a bare reassurance; null when nothing was captured.
  let boardMarker: string | null = null;
  if (capturedHosts.length > 0) {
    const host = capturedHosts[0];
    const geo = geoLabel(host ?? null, geos);
    boardMarker = geo
      ? `Caught calling ${host} (${geo})`
      : `Caught calling ${host}`;
  } else if (caughtAttack && f.in_vm_behavior.high_value_credential_reads > 0) {
    boardMarker = `Caught reading ${f.in_vm_behavior.high_value_credential_reads} credential file(s) in the sandbox`;
  }

  return {
    raw: f,
    _verdictColor: bandColor(score),
    _verdictGlow: bandGlow(score),
    _verdictTint: bandTint(score),
    _verdictBand: bandLabel(score),
    _verdictWord: enforceVerdict(v.one_word, score),
    _headline: v.headline,
    _namedAttempts: namedAttempts,
    _blockedNoHostCount: Math.max(0, blockedNoHostCount),
    _payloads: payloads,
    _capturedHosts: capturedHosts,
    _caughtAttack: caughtAttack,
    _possiblyDormant: possiblyDormant,
    _notVerified: notVerified,
    _boardMarker: boardMarker,
  };
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
  const rawForensics = buildForensicsView(r.forensics);
  // ONE report, ONE verdict (U1): the forensic section must show the SAME verdict as
  // the hero. Drive its verdict word/band/colors from the BLENDED report score (the
  // escalation's score), not the dynamic-only score, so the card and the hero can
  // never display two different verdicts on the same report.
  const forensicsView = rawForensics
    ? {
        ...rawForensics,
        _verdictColor: bandColor(r.score),
        _verdictGlow: bandGlow(r.score),
        _verdictTint: bandTint(r.score),
        _verdictBand: bandLabel(r.score),
        _verdictWord: verdict,
      }
    : undefined;
  // The honest signal: the sandbox ran iff it produced a forensic record. The
  // `deep`/`scan_path` flags only record that escalation was decided.
  const ranSandbox = !!forensicsView;
  return {
    ...r,
    verdict,
    // The stored `summary` is authoritative: the fast path writes the static
    // summary; the escalation/attach path (U1) overwrites it with a runtime-first,
    // hedge-free summary. Either way it is correct as stored — no render-time edit.
    ...(forensicsView ? { _forensics: forensicsView } : {}),
    _ranSandbox: ranSandbox,
    _color: bandColor(r.score),
    _glow: bandGlow(r.score),
    _tint: bandTint(r.score),
    _band: bandLabel(r.score),
    _ring: RING_CIRC * (1 - r.score / 100),
    _hasRisky: r.risky.length > 0,
    _finalNote: finalNote(r.score, forensicsView),
    _notVerified: notVerified(ranSandbox),
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
