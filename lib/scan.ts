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
import { normalizeLocDisplay } from "./format";

/** A successful scan returns a normalized `Report`; a failure carries a message. */
export type ScanResult =
  | { ok: true; report: Report }
  | { ok: false; error: string };

/**
 * A real, streamed scan-stage event (BUG-5/6). The edge function emits one
 * `active` event when a stage starts and one `done` event (with real lines) when
 * it completes. The processing timeline renders these — never canned text.
 */
export interface ScanStage {
  ch: string;
  status: "active" | "done";
  kind?: string;
  lines?: string[];
}

interface ScanArgs {
  owner: string;
  repo: string;
  ref?: string;
  deviceId?: string;
  /**
   * The current user's Supabase session access token, when signed in. Sent as
   * `Authorization: Bearer <token>` so the edge function can verify it server-
   * side (`auth.getUser(token)`) and attribute the scan to a TRUSTED user id.
   * The publishable `apikey` header is still sent for gateway routing.
   */
  accessToken?: string;
  /**
   * Called for each REAL streamed scan-stage event as it arrives. Optional — when
   * omitted (or when the response is a non-streamed cache hit) no stages fire.
   */
  onStage?: (stage: ScanStage) => void;
  /**
   * Set ONLY by the remote MCP server (app/mcp/route.ts) to identify itself to
   * the edge function's CLI/MCP login gate. The web app never sets this, so its
   * existing anonymous-scan behavior is completely unaffected — the gate only
   * triggers when this header is present (see supabase/functions/scan/index.ts
   * `clientKind`).
   */
  clientKind?: "mcp";
}

/** Hard ceiling for a single scan request — longer than the slowest deep read. */
const SCAN_TIMEOUT_MS = 90_000;

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

  // A half-open stream that stalls would otherwise spin the loader forever, so
  // every scan is bounded by a hard ceiling timeout via an AbortController.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(functionUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // `apikey` is the publishable key — it routes the request at the
          // Functions gateway. The Bearer carries the USER session token when
          // signed in (so the function can verify + attribute it); otherwise it
          // falls back to the publishable key for the logged-out free scan.
          apikey: key,
          Authorization: `Bearer ${args.accessToken ?? key}`,
          ...(args.clientKind ? { "X-ClaudeRabbit-Client": args.clientKind } : {}),
        },
        body: JSON.stringify({
          owner: args.owner,
          repo: args.repo,
          ...(args.ref ? { ref: args.ref } : {}),
          ...(args.deviceId ? { deviceId: args.deviceId } : {}),
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        return { ok: false, error: "The scan timed out. Please try again." };
      }
      return {
        ok: false,
        error: "Network error reaching the scanner. Check your connection and retry.",
      };
    }

    if (!res.ok) {
      // The function returns { error } with a meaningful status code (early
      // errors + the cache path stay non-streamed JSON). Prefer the function's
      // specific message; fall back to a status-derived friendly string.
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

    // A FRESH scan streams NDJSON stage events; a cache hit (or any non-stream
    // response) is plain JSON. Detect by Content-Type and consume accordingly.
    const contentType = res.headers.get("content-type") ?? "";
    const isStream =
      (contentType.includes("ndjson") || contentType.includes("event-stream")) && !!res.body;
    if (isStream && res.body) {
      try {
        return await consumeScanStream(res.body, args.onStage);
      } catch {
        if (controller.signal.aborted) {
          return { ok: false, error: "The scan timed out. Please try again." };
        }
        return { ok: false, error: "The scanner returned an unreadable response." };
      }
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, error: "The scanner returned an unreadable response." };
    }
    return { ok: true, report: normalizeReport(payload) };
  } finally {
    clearTimeout(timeout);
  }
}

/** A parsed NDJSON event from a scan / deep-run stream. */
type StreamEvent = Record<string, unknown>;

/**
 * Read an NDJSON ReadableStream line by line, invoking `onEvent` for each parsed
 * object. Buffers partial lines across chunks (a JSON object can split across two
 * reads) and skips any unparseable line rather than aborting. Shared by the
 * fast-path scan stream and the inline deep-run stream.
 */
async function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string): void => {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // stray/blank/partial line — skip, never abort the stream
    }
    if (ev && typeof ev === "object") onEvent(ev as StreamEvent);
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
}

/** Map a wire `stage` event to a `ScanStage`, or null when it is not one. */
function toScanStage(e: StreamEvent): ScanStage | null {
  if (e.t !== "stage" || typeof e.ch !== "string" || (e.status !== "active" && e.status !== "done")) {
    return null;
  }
  return {
    ch: e.ch,
    status: e.status,
    ...(typeof e.kind === "string" ? { kind: e.kind } : {}),
    ...(Array.isArray(e.lines)
      ? { lines: (e.lines as unknown[]).filter((l): l is string => typeof l === "string") }
      : {}),
  };
}

/**
 * Consume the NDJSON scan stream: surface each `stage` via `onStage`, capture the
 * final `report`, and map an in-band `error` event to a failed result.
 */
async function consumeScanStream(
  body: ReadableStream<Uint8Array>,
  onStage?: (stage: ScanStage) => void,
): Promise<ScanResult> {
  let report: Report | null = null;
  let error: string | null = null;
  await readNdjsonStream(body, (e) => {
    const stage = toScanStage(e);
    if (stage) {
      onStage?.(stage);
    } else if (e.t === "result") {
      report = normalizeReport(e.report);
    } else if (e.t === "error") {
      error = typeof e.error === "string" && e.error ? e.error : "The scan failed.";
    }
  });
  if (error) return { ok: false, error };
  if (report) return { ok: true, report };
  return { ok: false, error: "The scan ended without a result. Please retry." };
}

/** Hard ceiling for an inline deep run (the sandbox dead-man's-switch caps the VM at 30m). */
const DEEP_SCAN_TIMEOUT_MS = 20 * 60 * 1000;

/** Arguments for an inline deep (dynamic sandbox) run. */
export interface DeepScanArgs {
  owner: string;
  repo: string;
  /** The fast-path resolved commit SHA — pins the detonation + the forensics attach. */
  sha: string;
  onStage?: (stage: ScanStage) => void;
}

/** Result of an inline deep run. `persisted` = forensics attached to the report row. */
export type DeepScanResult =
  | { ok: true; persisted: boolean }
  | { ok: false; error: string };

/**
 * Run the dynamic sandbox INLINE via the local deep-scan controller route
 * (`/api/deep`), streaming its real progress. The route spawns the GCP detonation
 * directly (no queue), captures forensics, tears the VM down, and persists the
 * forensics onto this report row — after which the report renders "Sandbox run".
 * Never throws; always resolves to a `DeepScanResult`.
 */
export async function runDeepScan(args: DeepScanArgs): Promise<DeepScanResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEP_SCAN_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch("/api/deep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: args.owner, repo: args.repo, sha: args.sha }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return { ok: false, error: "The sandbox run timed out." };
      return { ok: false, error: "Could not reach the sandbox controller." };
    }
    if (!res.ok || !res.body) {
      let msg = "The sandbox run could not start.";
      try {
        const b = (await res.json()) as { error?: string; reason?: string };
        if (b.reason === "unavailable") {
          // The route's own gate-rejection text (`b.error`) is written for the
          // person operating the sandbox controller ("set CR_ALLOW_LOCAL_DEEP=1
          // ..."), not for a real visitor — this is the expected, documented
          // state on Vercel (docs/DEPLOY.md), not an error to alarm them with.
          msg =
            "A live sandbox detonation isn't available from this deployment right now — this result reflects the static read only.";
        } else if (typeof b.error === "string" && b.error) {
          // A genuine failure from a controller that WAS available (e.g. a
          // real Cloud Run execution error) — keep the real, specific detail.
          msg = b.error;
        }
      } catch {
        // non-JSON body — keep the default message
      }
      return { ok: false, error: msg };
    }
    let persisted = false;
    let error: string | null = null;
    try {
      await readNdjsonStream(res.body, (e) => {
        const stage = toScanStage(e);
        if (stage) {
          args.onStage?.(stage);
        } else if (e.t === "result") {
          persisted = e.persisted === true;
        } else if (e.t === "error") {
          error = typeof e.error === "string" && e.error ? e.error : "The sandbox run failed.";
        }
      });
    } catch {
      if (controller.signal.aborted) return { ok: false, error: "The sandbox run timed out." };
      return { ok: false, error: "The sandbox stream was unreadable." };
    }
    if (error) return { ok: false, error };
    return { ok: true, persisted };
  } finally {
    clearTimeout(timeout);
  }
}
