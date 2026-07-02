/**
 * Domain types for Claude Rabbit, derived from the Claude Design prototype's
 * data shapes (`design-source/Claude Rabbit.dc.html`, REPOS / LEADERBOARD /
 * ACTIVITY / useCases, lines ~1009–1110 and ~1285–1290).
 *
 * Per CLAUDE.md, reputation signals and code/behavior signals are kept
 * structurally separate: `OwnerHistory` + `Reputation` describe the owner and
 * community; `RiskyItem.kind` distinguishes a behavior/code finding from a
 * reputation ('rep') finding so a report can always tell the user which is
 * which.
 */

/** Severity of a single risky finding. */
export type Severity = "high" | "med" | "low";

/**
 * What kind of signal a risky finding is. `behavior` = observed when run;
 * `code` = found by reading the code; `rep` = a reputation signal (owner/account).
 */
export type RiskKind = "behavior" | "code" | "rep";

/** Status of a single chapter in the live scan log. */
export type LogKind = "ok" | "warn" | "bad";

/** Owner / account history — a reputation signal, kept separate from code behavior. */
export interface OwnerHistory {
  handle: string;
  name: string;
  /** Human-readable account age, e.g. "8 yr 2 mo" or "3 days". */
  age: string;
  established: boolean;
  repos: number;
  note: string;
}

/** Community reputation — a reputation signal, kept separate from code behavior. */
export interface Reputation {
  stars: string;
  forks: string;
  sentiment: string;
  /** Sentiment score 0–100. */
  sentScore: number;
}

/** Top-line repository statistics. */
export interface RepoStats {
  /** Repository size, formatted (e.g. "9880 KB"). Despite the field name, this is a byte-size metric from repo metadata, not a line count. */
  loc: string;
  packages: number;
  stars: string;
  created: string;
}

/** Per-package safety score with a short note. */
export interface PackageScore {
  name: string;
  score: number;
  note: string;
}

/** A single risky finding — code, behavior, or reputation. */
export interface RiskyItem {
  title: string;
  severity: Severity;
  kind: RiskKind;
  detail: string;
}

/** One chapter of the live scan log (clone, static scan, reputation, etc.). */
export interface LogChapter {
  /** Chapter label, e.g. "Clone", "Static scan", "Dynamic run". */
  ch: string;
  kind: LogKind;
  lines: string[];
}

// ───────────────────────── forensic record ─────────────────────────
// The structured evidence the dynamic sandbox produces for a repo that
// escalated to a deep run. Shape mirrors `claude-rabbit/forensic-record@1`
// (the producer is `sandbox/harness/forensics.py`). It is persisted to the
// live `reports.forensics_json` jsonb column and read by anon.
//
// Per CLAUDE.md the forensic record is code/behavior + network intent only —
// reputation never lives in here, preserving the structural separation.

/** What the sandbox actually built and ran. */
export interface ForensicsRuntime {
  project_type: string | null;
  install_command: string | null;
  run_command: string | null;
  auto_build_succeeded: boolean;
  ran_without_crash: boolean;
  build_exit_code: number | null;
  run_exit_code: number | null;
}

/**
 * One outbound connection the code tried — what it MEANT to reach (domain),
 * the inert would-be payload, port, transport. The intended IP is intelligence
 * resolved off-VM and was never routed to.
 */
export interface ForensicsNetworkAttempt {
  intended_host: string | null;
  sni: string | null;
  http_host_header: string | null;
  dest_port: number | null;
  transport: string | null;
  tls: boolean;
  tls_handshake: string | null;
  http_method: string | null;
  http_path: string | null;
  http_headers: Record<string, string> | null;
  /** The would-be exfil payload, captured INERT (base64), never delivered. */
  would_be_payload_b64: string | null;
  payload_len: number | null;
  captured_at: string | null;
}

/** An intended destination resolved off-VM for intelligence only. */
export interface ForensicsDestination {
  host: string | null;
  intended_ips: string[];
}

/** A GeoIP record for an intended destination (intelligence only). */
export interface ForensicsGeolocation {
  host?: string | null;
  ip?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  org?: string | null;
}

/** The fused network-intent evidence (external trap + off-VM analysis). */
export interface ForensicsNetworkIntent {
  attempts: ForensicsNetworkAttempt[];
  attempt_count: number;
  intended_destinations: ForensicsDestination[];
  geolocations: ForensicsGeolocation[];
}

/** A single credential-read observation (decoy reads in the sandbox). */
export interface ForensicsCredentialRead {
  path: string;
  succeeded: boolean;
  high_value: boolean;
}

/** In-VM behavior (strace), kept separate from the network intent. */
export interface ForensicsInVmBehavior {
  high_value_credential_reads: number;
  high_value_credential_reads_succeeded: number;
  credential_reads_detail: ForensicsCredentialRead[];
  suspicious_binaries: string[];
  files_dropped_count: number;
  files_dropped: string[];
  high_cpu: boolean;
  run_cpu_cores_busy: number;
  process_exec_count: number;
}

/** A decoded would-be payload, captured inert in the disposable env. */
export interface ForensicsDecodedPayload {
  host: string | null;
  text: string | null;
  bytes_len: number;
  kind?: string;
  note?: string;
}

/** Captured-payload analysis (decode + AI intent summary). */
export interface ForensicsPayloadAnalysis {
  decoded_payloads: ForensicsDecodedPayload[];
  ai_intent_summary: string | null;
  ai_model: string | null;
  ai_analysis_error: string | null;
}

/** The dual-source containment proof. */
export interface ForensicsContainment {
  external_monitor_saw_egress: boolean;
  in_vm_saw_egress: boolean;
  /** The invariant: no real packet reached its intended destination. */
  no_real_packet_reached_destination: boolean;
  containment_notes: string;
  egress_control_probe: string | null;
}

/** A single code/behavior finding from the dynamic verdict. */
export interface ForensicsVerdictFinding {
  signal: string;
  severity: string;
  detail: string;
}

/** The honest dynamic verdict (`claude-rabbit/dynamic-verdict@1`). */
export interface ForensicsVerdict {
  schema?: string;
  dynamic_score: number;
  score_color: string;
  one_word: string;
  headline: string;
  code_behavior_findings: ForensicsVerdictFinding[];
  captured_network_intent: string[];
  egress_intercepted_count: number;
  attack_egress_intercepted: boolean;
  not_verified: string[];
  signal_class?: string;
  auto_build_succeeded?: boolean;
  ran_without_crash?: boolean;
  project_type?: string | null;
}

/** The honesty rail: dormant/unverified flagging and the not-verified notes. */
export interface ForensicsHonesty {
  possibly_dormant_unverified: boolean;
  notes: string[];
}

/**
 * The full forensic record for a deep/escalated repo, schema
 * `claude-rabbit/forensic-record@1`. Optional on a `Report` — only escalated
 * repos carry one; a clean fast-path repo simply has none.
 */
export interface Forensics {
  schema: string;
  generated_at: string;
  target: string;
  what_it_ran: ForensicsRuntime;
  network_intent: ForensicsNetworkIntent;
  in_vm_behavior: ForensicsInVmBehavior;
  payload_analysis: ForensicsPayloadAnalysis;
  containment: ForensicsContainment;
  verdict: ForensicsVerdict;
  honesty: ForensicsHonesty;
}

/** A full safety report for a single repo. */
export interface Report {
  id: string;
  owner: string;
  name: string;
  /** Safety score 0–100. */
  score: number;
  /** One-word verdict, e.g. "Trusted", "Likely safe", "Caution", "Malicious". */
  verdict: string;
  /** Whether this report is served from cache. */
  cached: boolean;
  /** Whether this report involved a deep (dynamic sandbox) run. */
  deep: boolean;
  summary: string;
  ownerHistory: OwnerHistory;
  reputation: Reputation;
  stats: RepoStats;
  packages: PackageScore[];
  risky: RiskyItem[];
  logs: LogChapter[];
  /**
   * The dynamic sandbox forensic record, present only when this repo escalated
   * to a deep run. A clean fast-path repo omits it (the forensic section is
   * then not rendered — no empty shell).
   */
  forensics?: Forensics;
  /**
   * The resolved commit SHA this report is for. Carried through so the inline
   * deep run can pin its detonation to (and attach its forensics onto) this exact
   * report row — fresh and cached renders agree per commit (see BUG-17).
   */
  commit_sha?: string;
}

/** A row on the public dangerous-repos leaderboard. */
export interface LeaderboardEntry {
  owner: string;
  name: string;
  score: number;
  reason: string;
  /** Linked report id, or null when the report is not in this demo set. */
  id: string | null;
  /**
   * The forensic record for a caught repo, when the sandbox produced one. The
   * board surfaces a concise marker (the C2 host/geo it was caught calling)
   * from this. Optional — most board rows are demo entries without forensics.
   */
  forensics?: Forensics;
}

/** A recent-activity ticker entry on the homepage. */
export interface ActivityEntry {
  owner: string;
  name: string;
  score: number;
  /** Relative timestamp, e.g. "just now", "12s ago". */
  when: string;
}

/** A homepage "use case" card. */
export interface UseCase {
  no: string;
  title: string;
  body: string;
}
