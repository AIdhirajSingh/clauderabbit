/**
 * Shared types for the 2.0 scan engine (docs/2.0/DESIGN.md sections 4, 6 and 8).
 *
 * Every module under lib/engine imports its contracts from here so the event
 * schema, the score inputs and the report payload stay one definition.
 */

import type { CostLedger } from "./cost";

/** What a scan targets. `tarball` is the operator-only target (CR_OPERATOR_KEY). */
export type ScanTarget =
  | { kind: "github"; owner: string; repo: string; ref?: string }
  | { kind: "npm"; name: string; version?: string }
  | { kind: "tarball"; url: string; integrity: string; label: string };

/** Which surface asked for the scan. Drives the ad payload and auth rules. */
export type Surface = "web" | "cli" | "mcp" | "mcp-remote";

export interface ScanCaller {
  surface: Surface;
  /** Supabase user id when signed in (CLI/MCP always, web optionally). */
  userId: string | null;
  /** Client IP from Vercel headers, used only for the anti-abuse floor. */
  ip: string | null;
  deviceId: string | null;
  /** True when a valid CR_OPERATOR_KEY header was presented. */
  operator: boolean;
  /**
   * Set only by /api/scan after it ran the anonymous fresh-scan limits itself, before booting the runner sandbox,
   * so the runner does not count the same scan twice. Never read from a client.
   */
  anonGateChecked?: boolean;
}

export interface ScanRequest {
  target: ScanTarget;
  caller: ScanCaller;
  /** Operator-only: run a fresh scan over a cached report. */
  regenerate: boolean;
  /**
   * Run fresh even when a stored run exists (the proof driver's rescans). It adds no capacity beyond pasting a
   * target nobody has scanned: the burst limit and the daily budget apply as to any fresh scan.
   */
  fresh?: boolean;
  /**
   * The viewer asked to keep installing a very large repo: the install runs to
   * completion (lib/engine/config.ts fullInstallDeadlines) and a stored partial
   * report is not served for it.
   */
  full?: boolean;
}

export type ErrorCode =
  | "invalid_target"
  | "not_found"
  | "private_repo"
  | "rate_limited"
  | "upstream"
  | "integrity"
  | "too_large"
  | "unauthorized"
  | "budget_exhausted"
  | "capacity"
  | "timeout"
  | "internal";

export type Phase = "install" | "entry";

export type StageName =
  | "cache"
  | "resolve"
  | "fetch"
  | "verify"
  | "reach"
  | "static"
  | "osv"
  | "checks"
  | "detonate"
  | "score"
  | "report"
  | "persist";

export type TranscriptSource =
  | "install"
  | "entry"
  | "semgrep"
  | "guarddog"
  | "yara"
  | "jev.install"
  | "jev.flagged"
  | "jev.docs"
  | "luna.report";

export interface StageEventData {
  name: StageName;
  status: "start" | "done" | "error" | "skipped";
  detail?: string;
}
export interface TimingEventData {
  name: string;
  ms: number;
}
export interface TranscriptEventData {
  source: TranscriptSource;
  stream: "stdout" | "stderr" | "model";
  text: string;
}
export interface ForgedCallData {
  phase: Phase;
  proto: "http" | "https" | "dns" | "tcp";
  host: string;
  port: number;
  method?: string;
  path?: string;
  sni?: string;
  req_bytes: number;
  forged_kind: string;
  tls?: "intercepted" | "refused";
  canary_hits: string[];
  /** When it happened inside the sandbox (epoch ms), when the record carries a time. */
  at?: number;
}
export interface FileEventData {
  phase: Phase;
  op: "write" | "create" | "unlink" | "rename" | "chmod" | "read_decoy";
  path: string;
  pid: number;
  /** When it happened inside the sandbox (epoch ms), when the record carries a time. */
  at?: number;
}
export interface ProcessEventData {
  phase: Phase;
  pid: number;
  ppid: number;
  argv: string[];
  /** When it happened inside the sandbox (epoch ms), when the record carries a time. */
  at?: number;
}
export interface CheckEventData {
  name: string;
  ok: boolean;
  detail?: string;
}

export type ScanEventBody =
  | { type: "stage"; data: StageEventData }
  | { type: "timing"; data: TimingEventData }
  | { type: "transcript"; data: TranscriptEventData }
  | { type: "forged_call"; data: ForgedCallData }
  | { type: "file"; data: FileEventData }
  | { type: "process"; data: ProcessEventData }
  | { type: "check"; data: CheckEventData };

export type ScanEventType = ScanEventBody["type"];

export const SCAN_EVENT_TYPES: readonly ScanEventType[] = [
  "stage",
  "timing",
  "transcript",
  "forged_call",
  "file",
  "process",
  "check",
];

export type ScanEvent = { run_id: string; seq: number; t_ms: number; replayed?: boolean } & ScanEventBody;

/** Severity used across static scanners, heuristics and reader findings. */
export type Severity = "high" | "medium" | "low";

export type FindingSource = "heuristic" | "semgrep" | "yara" | "guarddog";

/** One static finding (heuristic or scanner), before reachability tagging. */
export interface StaticFinding {
  source: FindingSource;
  rule: string;
  severity: Severity;
  file: string;
  /** 1-based line, or null when the tool reports none. */
  line: number | null;
  message: string;
  snippet?: string;
}

/** A static finding after the reachability graph has classified its file. */
export interface TaggedFinding extends StaticFinding {
  reach: "install" | "import" | "unreachable";
}

/** Jev's answer to one per-signal check (lib/engine/model/checks.ts). */
export type CheckVerdict = "malicious" | "suspicious" | "benign" | "unclear";

/**
 * One Jev check answer, mapped to a finding in code. `severity` is derived from
 * the verdict and the boolean signals, never chosen by the model. `evidence`
 * points at what Jev judged: the file, the line window and the static rule that
 * opened it, and each boolean signal with its probability.
 */
export interface CheckFinding {
  check: "install" | "flagged" | "docs";
  /** The question id the answer belongs to. */
  question: string;
  file: string;
  line: number | null;
  severity: Severity;
  verdict: CheckVerdict;
  /** Jev's probability for the chosen verdict, when it returned a distribution. */
  probability: number | null;
  title: string;
  evidence: string[];
}

export interface TaggedCheckFinding extends CheckFinding {
  reach: "install" | "import" | "unreachable";
}

/** Score groups. Reputation is always kept apart from code and behaviour. */
export type ScoreGroup = "behaviour" | "intel" | "static" | "docs" | "reputation" | "cap";

export interface ScoreDelta {
  group: ScoreGroup;
  code: string;
  points: number;
  detail: string;
  evidence?: string[];
}

export type Verdict = "No threats observed" | "Low risk" | "Caution" | "High risk" | "Malicious";
export type Band = "green" | "blue" | "yellow" | "red";

export interface MaliciousDependency {
  ecosystem: DependencyRef["ecosystem"];
  name: string;
  version: string;
  ids: string[];
  /** Where the dependency was found and who it reaches (lockfile flags, registry os, this run's install). */
  scope?: DependencyScope;
}

export interface DependencyScope {
  /** The scan's own install pulled this exact version in. */
  installed: boolean;
  /** Marked dev-only in the repo's lockfile. */
  dev: boolean;
  /** Marked optional in the repo's lockfile. */
  optional: boolean;
  /** Operating systems the package declares (`os` in its npm manifest), empty when it declares none. */
  os: string[];
}

export interface DependencyRef {
  ecosystem: "npm" | "PyPI" | "Go" | "crates.io";
  name: string;
  version: string;
}

export interface EvidenceItem {
  group: ScoreGroup;
  text: string;
}

/** Ad payload attached to every response (section 8.3). */
export type Ad =
  | {
      kind: "adsense";
      placement: "scan_result";
      client: string;
      slot: string;
      format: "auto";
      adtest: "on" | "off";
    }
  | {
      kind: "house";
      placement: "scan_result";
      id: string;
      label: "Sponsored";
      headline: string;
      body: string;
      url: string;
    };

export interface ReportPayload {
  run_id: string;
  target: string;
  commit_sha: string;
  score: number;
  verdict: Verdict;
  band: Band;
  summary: string;
  headline: string;
  evidence: { behaviour: string[]; code: string[]; reputation: string[] };
  breakdown: ScoreDelta[];
  not_verified: string[];
  forensics: unknown;
  packages: unknown;
  /** Luna, the report writer's model id. */
  model_id: string;
  /** Jev, the checker's model id (AI Gateway). Absent on reports written before Jev. */
  jev_model_id?: string;
  /** Version of the scoring rules (lib/engine/score.ts SCORE_RULES) that produced this score. */
  score_rules?: number;
  /** Plain label when the repo's own code is clean and the danger is in a dependency. */
  label?: string;
  /** Reputation, kept apart from the code verdict: each fact with its source; warnings never lower the code score. */
  reputation_section?: { facts: Array<{ fact: string; source: string }>; warnings: string[] };
  /**
   * The report in two short plain-English paragraphs: what was run and what
   * happened, then what matters and what to do. Written by the report writer
   * (Luna) or, when its output is rejected or absent, built from the data; the
   * `writer` field says which. Absent on reports written before this field.
   */
  luna_report?: { what_ran: string; what_matters: string };
  /** Install did not finish or the entry point did not run: the score covers only what was observed. */
  partial?: boolean;
  /** One plain line saying why the scan is partial ("Build ran out of time, so the program never ran"). */
  partial_reason?: string;
  /**
   * What the sandbox run did, built in code from the run's facts (lib/engine/ran.ts).
   * Every field the run did not establish is null. Absent on reports written before
   * this field and on runs with no detonation result.
   */
  ran?: {
    package_manager: string | null;
    /** Packages in the installed tree. */
    installed: number | null;
    /** Dev packages the install plan did not run (no install script, or platform-only). */
    skipped: number | null;
    /** Install wall time. */
    install_ms: number | null;
    /** Install scripts in the installed tree (lockfile hasInstallScript, plus the repo's own). */
    install_scripts: number | null;
    /** Registry-only traffic, N non-registry calls answered by the forge, or no calls. */
    network: { kind: "registry_only" } | { kind: "forged"; calls: number } | { kind: "none" } | null;
    entry_point: { command: string; exit_code: number | null } | null;
  };
  template: string;
  timings: Record<string, number>;
  writer: "model" | "deterministic";
  /** Cost ledger of the run that produced this report (lib/engine/cost.ts). Absent on reports written before the ledger. */
  cost?: CostLedger;
}

export type ScanOutcome =
  | { kind: "cached" | "fresh"; runId: string; report: ReportPayload }
  | { kind: "attached"; runId: string }
  /** RunScanOptions.cacheOnly: no stored run serves this request; nothing was claimed or booted. */
  | { kind: "miss" }
  | { kind: "error"; runId: string | null; code: ErrorCode; message: string };

/** Typed engine error carrying the API error code. */
export class EngineError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}
