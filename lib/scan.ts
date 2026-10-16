/**
 * Real scan wiring: posts to the same-origin `POST /api/scan` (the Vercel
 * function that runs the whole 2.0 engine), reads its NDJSON event stream and
 * maps the final payload onto the app's `Report` shape so the SPA renders a
 * live scan exactly the way it renders a stored report. No secret is ever used
 * here (CLAUDE.md: only the publishable key is client-side).
 *
 * Errors are returned as a typed discriminated union, never thrown to the
 * caller — so the UI can branch on a friendly message (network / not-found /
 * rate-limit / generic) and show the existing `failed` state.
 */

import type {
  NpmReputation,
  ForensicsContainment,
  ForensicsCredentialRead,
  ForensicsDecodedPayload,
  ForensicsDestination,
  ForensicsGeolocation,
  ForensicsHonesty,
  ForensicsInVmBehavior,
  ForensicsNetworkAttempt,
  ForensicsNetworkIntent,
  Forensics,
  ForensicsPayloadAnalysis,
  ForensicsRuntime,
  ForensicsVerdict,
  ForensicsVerdictFinding,
  LogChapter,
  PackageScore,
  Report,
  RiskKind,
  RiskyItem,
  Severity,
} from "./types";
import { enforceVerdict } from "./report-view";
import type { Ad, ReportPayload, ScanEvent, StageName } from "./engine/types";
import { normalizeLocDisplay } from "./format";

/**
 * A scan result: the normalized `Report` the screens render, the engine's own
 * report (score breakdown, evidence groups, `not_verified`) and the ad that came
 * with the response. A failure carries a message and, when the server sent one,
 * the ad too.
 */
export type ScanResult =
  | { ok: true; report: Report; engine: ReportPayload; ad: Ad; runId: string; outcome: "cached" | "fresh"; reportUrl: string }
  | { ok: false; error: string; code?: string; ad?: Ad };

/**
 * A streamed scan-stage event for the processing timeline, derived from the
 * engine's real `stage` events: `active` when a stage starts, `done` (with
 * real lines) when it completes.
 */
export interface ScanStage {
  ch: string;
  status: "active" | "done";
  kind?: string;
  lines?: string[];
}

/** Fields shared by every scan request, regardless of ecosystem. */
interface ScanArgsBase {
  /** Anonymous device id; rides along for the burst floor only. */
  deviceId?: string;
  /** The signed-in user's Supabase session token, sent as a Bearer. Optional: the web never requires sign-in. */
  accessToken?: string;
  /** Called for each stage event as it arrives (live and replayed). */
  onStage?: (stage: ScanStage) => void;
  /** Called for every raw engine event (transcript, forged calls, files, processes, checks). */
  onEvent?: (event: ScanEvent) => void;
}

/** A GitHub owner/repo scan target. */
export interface GithubScanArgs extends ScanArgsBase {
  owner: string;
  repo: string;
  ref?: string;
}

/** An npm package scan target: the integrity-verified registry tarball. */
export interface NpmScanArgs extends ScanArgsBase {
  ecosystem: "npm";
  package: string;
  version?: string;
}

/** A scan request is either a GitHub repo or an npm package. */
export type ScanArgs = GithubScanArgs | NpmScanArgs;

/** Client ceiling for one scan request: the server's maxDuration plus slack. */
const SCAN_TIMEOUT_MS = 130_000;

/**
 * Split accumulated NDJSON text into complete lines plus a trailing remainder.
 * Pure + exported so the partial-line-across-chunks behavior is unit-tested: a
 * chunk can end mid-object, so the last (incomplete) segment is kept in `rest`
 * and only re-parsed once its closing newline arrives.
 */
export function splitNdjson(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
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

// ───────────────────────── forensics normalization ─────────────────────────
// The dynamic sandbox forensic record (`claude-rabbit/forensic-record@1`) is
// stored in `reports.forensics_json` and may also arrive on a live scan
// response. We coerce it to the strict `Forensics` shape, tolerant of missing
// fields, so a partial record still renders and a clean repo (no record at all)
// simply yields `undefined` — the report then omits the forensic section.

/**
 * Hard cap on the number of entries we keep from any array inside the hostile
 * `forensics_json`. The record is attacker-controlled and rendered on a public
 * Server Component, so a single record with a huge array must not be able to
 * spike SSR memory; we keep a generous-but-bounded prefix.
 */
const MAX_FORENSIC_ITEMS = 200;

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string").slice(0, MAX_FORENSIC_ITEMS)
    : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function objArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .slice(0, MAX_FORENSIC_ITEMS);
}

function normalizeRuntime(v: unknown): ForensicsRuntime {
  const r = obj(v);
  return {
    project_type: strOrNull(r.project_type),
    install_command: strOrNull(r.install_command),
    run_command: strOrNull(r.run_command),
    auto_build_succeeded: bool(r.auto_build_succeeded),
    ran_without_crash: bool(r.ran_without_crash),
    build_exit_code: numOrNull(r.build_exit_code),
    run_exit_code: numOrNull(r.run_exit_code),
  };
}

function normalizeNetworkAttempt(v: Record<string, unknown>): ForensicsNetworkAttempt {
  const headers = obj(v.http_headers);
  const hasHeaders = Object.keys(headers).length > 0;
  return {
    intended_host: strOrNull(v.intended_host),
    sni: strOrNull(v.sni),
    http_host_header: strOrNull(v.http_host_header),
    dest_port: numOrNull(v.dest_port),
    transport: strOrNull(v.transport),
    tls: bool(v.tls),
    tls_handshake: strOrNull(v.tls_handshake),
    http_method: strOrNull(v.http_method),
    http_path: strOrNull(v.http_path),
    http_headers: hasHeaders
      ? Object.fromEntries(
          Object.entries(headers).map(([k, val]) => [k, str(val)]),
        )
      : null,
    would_be_payload_b64: strOrNull(v.would_be_payload_b64),
    payload_len: numOrNull(v.payload_len),
    captured_at: strOrNull(v.captured_at),
  };
}

function normalizeNetworkIntent(v: unknown): ForensicsNetworkIntent {
  const r = obj(v);
  const attempts = objArray(r.attempts).map(normalizeNetworkAttempt);
  const destinations: ForensicsDestination[] = objArray(r.intended_destinations).map((d) => ({
    host: strOrNull(d.host),
    intended_ips: strArray(d.intended_ips),
  }));
  const geolocations: ForensicsGeolocation[] = objArray(r.geolocations).map((g) => ({
    host: strOrNull(g.host),
    ip: strOrNull(g.ip),
    country: strOrNull(g.country),
    region: strOrNull(g.region),
    city: strOrNull(g.city),
    org: strOrNull(g.org),
  }));
  return {
    attempts,
    attempt_count:
      typeof r.attempt_count === "number" ? num(r.attempt_count) : attempts.length,
    intended_destinations: destinations,
    geolocations,
  };
}

function normalizeInVmBehavior(v: unknown): ForensicsInVmBehavior {
  const r = obj(v);
  const reads: ForensicsCredentialRead[] = objArray(r.credential_reads_detail).map((c) => ({
    path: str(c.path),
    succeeded: bool(c.succeeded),
    high_value: bool(c.high_value),
  }));
  return {
    high_value_credential_reads: num(r.high_value_credential_reads),
    high_value_credential_reads_succeeded: num(r.high_value_credential_reads_succeeded),
    credential_reads_detail: reads,
    suspicious_binaries: strArray(r.suspicious_binaries),
    files_dropped_count: num(r.files_dropped_count),
    files_dropped: strArray(r.files_dropped),
    high_cpu: bool(r.high_cpu),
    run_cpu_cores_busy: num(r.run_cpu_cores_busy),
    process_exec_count: num(r.process_exec_count),
  };
}

function normalizePayloadAnalysis(v: unknown): ForensicsPayloadAnalysis {
  const r = obj(v);
  const decoded: ForensicsDecodedPayload[] = objArray(r.decoded_payloads).map((p) => ({
    host: strOrNull(p.host),
    text: strOrNull(p.text),
    bytes_len: num(p.bytes_len),
    ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
    ...(typeof p.note === "string" ? { note: p.note } : {}),
  }));
  return {
    decoded_payloads: decoded,
    ai_intent_summary: strOrNull(r.ai_intent_summary),
    ai_model: strOrNull(r.ai_model),
    ai_analysis_error: strOrNull(r.ai_analysis_error),
  };
}

function normalizeContainment(v: unknown): ForensicsContainment {
  const r = obj(v);
  return {
    external_monitor_saw_egress: bool(r.external_monitor_saw_egress),
    in_vm_saw_egress: bool(r.in_vm_saw_egress),
    no_real_packet_reached_destination: bool(r.no_real_packet_reached_destination),
    containment_notes: str(r.containment_notes),
    egress_control_probe: strOrNull(r.egress_control_probe),
  };
}

function normalizeForensicsVerdict(v: unknown): ForensicsVerdict {
  const r = obj(v);
  const findings: ForensicsVerdictFinding[] = objArray(r.code_behavior_findings).map((f) => ({
    signal: str(f.signal),
    severity: str(f.severity),
    detail: str(f.detail),
  }));
  return {
    ...(typeof r.schema === "string" ? { schema: r.schema } : {}),
    dynamic_score: num(r.dynamic_score),
    score_color: str(r.score_color),
    one_word: str(r.one_word),
    headline: str(r.headline),
    code_behavior_findings: findings,
    captured_network_intent: strArray(r.captured_network_intent),
    egress_intercepted_count: num(r.egress_intercepted_count),
    attack_egress_intercepted: bool(r.attack_egress_intercepted),
    not_verified: strArray(r.not_verified),
    ...(typeof r.signal_class === "string" ? { signal_class: r.signal_class } : {}),
    ...(typeof r.auto_build_succeeded === "boolean"
      ? { auto_build_succeeded: r.auto_build_succeeded }
      : {}),
    ...(typeof r.ran_without_crash === "boolean"
      ? { ran_without_crash: r.ran_without_crash }
      : {}),
    project_type: strOrNull(r.project_type),
  };
}

function normalizeHonesty(v: unknown): ForensicsHonesty {
  const r = obj(v);
  return {
    possibly_dormant_unverified: bool(r.possibly_dormant_unverified),
    notes: strArray(r.notes),
  };
}

/**
 * Coerce a raw forensic record onto the strict `Forensics` shape. Returns
 * `undefined` when the input is absent or not a forensic record (so the report
 * omits the section). Recognizes the record by its schema or by the presence of
 * its signature blocks.
 */
export function normalizeForensics(raw: unknown): Forensics | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const looksLikeRecord =
    (typeof r.schema === "string" && r.schema.startsWith("claude-rabbit/forensic-record")) ||
    "network_intent" in r ||
    "in_vm_behavior" in r ||
    "containment" in r;
  if (!looksLikeRecord) return undefined;
  return {
    schema: str(r.schema, "claude-rabbit/forensic-record@1"),
    generated_at: str(r.generated_at),
    target: str(r.target),
    what_it_ran: normalizeRuntime(r.what_it_ran),
    network_intent: normalizeNetworkIntent(r.network_intent),
    in_vm_behavior: normalizeInVmBehavior(r.in_vm_behavior),
    payload_analysis: normalizePayloadAnalysis(r.payload_analysis),
    containment: normalizeContainment(r.containment),
    verdict: normalizeForensicsVerdict(r.verdict),
    honesty: normalizeHonesty(r.honesty),
  };
}

/**
 * Map an arbitrary structured scan payload (engine payload OR a row's
 * blended object) onto the strict `Report` shape. Tolerant of missing fields:
 * the engine already validates and clamps, but we re-coerce so a partial
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
  // The forensic record may arrive under `forensics` (live scan) or
  // `forensics_json` (a reshaped DB row); accept either and omit when absent.
  const forensics = normalizeForensics(r.forensics ?? r.forensics_json);

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
      // `loc` arrives as a pre-formatted string from the model (e.g. "9880 KB").
      // There is no code-side enforcement of that formatting, so defensively
      // re-format it here if it looks like a raw, unformatted integer — the
      // one failure mode where the model's own formatting slips (see
      // `normalizeLocDisplay`). Already-formatted strings pass through as-is.
      loc: normalizeLocDisplay(str(statsRaw.loc, "—")),
      packages: Math.round(num(statsRaw.packages, 0)),
      stars: str(statsRaw.stars, "—"),
      created: str(statsRaw.created, "unknown"),
    },
    packages: normalizePackages(r.packages),
    risky: normalizeRisky(r.risky),
    logs: normalizeLogs(r.logs),
    ...(forensics ? { forensics } : {}),
    // Carry the resolved commit SHA so the inline deep run can pin its detonation
    // to (and attach forensics onto) this exact report row.
    ...(typeof r.commit_sha === "string" && r.commit_sha ? { commit_sha: r.commit_sha } : {}),
    ...(normalizeNpm(r.npm) ? { npm: normalizeNpm(r.npm) } : {}),
  };
}

/**
 * Keep an npm reputation block's REAL fields only (each type-checked); anything
 * missing or malformed is dropped rather than defaulted to "unknown"/0.
 */
export function normalizeNpm(raw: unknown): NpmReputation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.package !== "string" || !o.package) return undefined;
  const v: NpmReputation = { package: o.package, version: typeof o.version === "string" ? o.version : "" };
  if (typeof o.publisher === "string" && o.publisher) v.publisher = o.publisher;
  if (Array.isArray(o.maintainers)) {
    const m = o.maintainers.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (m.length) v.maintainers = m;
  }
  if (typeof o.firstPublished === "string") v.firstPublished = o.firstPublished;
  if (typeof o.ageLabel === "string" && o.ageLabel) v.ageLabel = o.ageLabel;
  for (const k of ["weeklyDownloads", "monthlyDownloads", "versionCount"] as const) {
    if (typeof o[k] === "number" && Number.isFinite(o[k])) v[k] = o[k] as number;
  }
  if (typeof o.license === "string" && o.license) v.license = o.license;
  return v;
}

const STAGE_LABEL: Record<StageName, string> = {
  cache: "Cache",
  resolve: "Resolve",
  fetch: "Fetch",
  verify: "Verify integrity",
  reach: "Reachability",
  static: "Static scanners",
  osv: "OSV lookup",
  readers: "Model readers",
  detonate: "Sandbox run",
  score: "Score",
  report: "Report",
  persist: "Save",
};

/** Map an engine stage event onto the timeline shape. Timing and other types return null. */
export function toScanStage(e: ScanEvent, timings: Map<string, number>): ScanStage | null {
  if (e.type === "timing") {
    timings.set(e.data.name, e.data.ms);
    return null;
  }
  if (e.type !== "stage") return null;
  const ch = STAGE_LABEL[e.data.name] ?? e.data.name;
  if (e.data.status === "start") return { ch, status: "active" };
  const lines = [e.data.detail ?? "", e.data.status === "skipped" ? "skipped" : ""].filter((l) => l.length > 0);
  return { ch, status: "done", kind: e.data.status === "error" ? "bad" : "ok", lines };
}

/** Map the engine ReportPayload onto the `Report` the existing screens render. */
export function reportFromPayload(p: ReportPayload, target: { owner: string; name: string }, cached: boolean): Report {
  const risky: RiskyItem[] = [
    ...p.evidence.behaviour.map((t) => ({ title: "Observed when run", severity: (p.score < 60 ? "high" : "low") as Severity, kind: "behavior" as RiskKind, detail: t })),
    ...p.evidence.code.map((t) => ({ title: "Found in the code", severity: (p.score < 60 ? "med" : "low") as Severity, kind: "code" as RiskKind, detail: t })),
    ...p.evidence.reputation.map((t) => ({ title: "Reputation signal", severity: "low" as Severity, kind: "rep" as RiskKind, detail: t })),
  ];
  const logs: LogChapter[] = Object.entries(p.timings).map(([name, ms]) => ({ ch: STAGE_LABEL[name as StageName] ?? name, kind: "ok", lines: [`${Math.round(ms)} ms`] }));
  return normalizeReport({
    owner: target.owner,
    name: target.name,
    score: p.score,
    verdict: p.verdict,
    cached,
    deep: true,
    summary: [p.headline, p.summary].filter((x) => x).join(" "),
    risky,
    logs,
    commit_sha: p.commit_sha,
  });
}

function targetLabel(args: ScanArgs): { owner: string; name: string } {
  return "ecosystem" in args ? { owner: "npm", name: args.package } : { owner: args.owner, name: args.repo };
}

/**
 * Run one scan through `POST /api/scan` (same origin). Streams the engine's
 * events (NDJSON) into `onStage` / `onEvent` and resolves with the final
 * result line. Every response carries an ad, success or failure.
 */
export async function runScan(args: ScanArgs): Promise<ScanResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  const body: Record<string, unknown> =
    "ecosystem" in args
      ? { ecosystem: "npm", package: args.package, ...(args.version ? { version: args.version } : {}), ...(args.deviceId ? { deviceId: args.deviceId } : {}) }
      : { ecosystem: "github", owner: args.owner, repo: args.repo, ...(args.ref ? { ref: args.ref } : {}), ...(args.deviceId ? { deviceId: args.deviceId } : {}) };
  try {
    let res: Response;
    try {
      res = await fetch("/api/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          "X-ClaudeRabbit-Client": "web",
          ...(args.accessToken ? { Authorization: `Bearer ${args.accessToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return { ok: false, error: "The scan timed out. Please try again." };
      return { ok: false, error: "Network error reaching the scanner. Check your connection and retry." };
    }
    if (!res.ok || !res.body) {
      let parsed: { message?: string; code?: string; ad?: Ad } = {};
      try {
        parsed = (await res.json()) as typeof parsed;
      } catch {
        // Non-JSON error body: fall back to the status text below.
      }
      return { ok: false, error: parsed.message || `The scan could not be completed (HTTP ${res.status}).`, ...(parsed.code ? { code: parsed.code } : {}), ...(parsed.ad ? { ad: parsed.ad } : {}) };
    }

    const timings = new Map<string, number>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: Record<string, unknown> | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      const { lines, rest } = splitNdjson(buffer, done ? chunk + "\n" : chunk);
      buffer = rest;
      for (const line of lines) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.type === "event" && msg.event && typeof msg.event === "object") {
          const e = msg.event as ScanEvent;
          args.onEvent?.(e);
          const stage = toScanStage(e, timings);
          if (stage) args.onStage?.(stage);
        } else if (msg.type === "result" || msg.type === "error") {
          final = msg;
        }
      }
      if (done) break;
    }
    if (!final) return { ok: false, error: "The scan stream ended without a result. Please try again." };
    if (final.type === "error") {
      return { ok: false, error: str(final.message, "The scan could not be completed."), code: str(final.code), ...(final.ad ? { ad: final.ad as Ad } : {}) };
    }
    const payload = final.report as ReportPayload;
    const outcome = final.outcome === "cached" ? "cached" : "fresh";
    return {
      ok: true,
      report: reportFromPayload(payload, targetLabel(args), outcome === "cached"),
      engine: payload,
      ad: final.ad as Ad,
      runId: str(final.run_id),
      outcome,
      reportUrl: str(final.report_url),
    };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, error: "The scan timed out. Please try again." };
    return { ok: false, error: err instanceof Error ? err.message : "The scan could not be completed." };
  } finally {
    clearTimeout(timeout);
  }
}
