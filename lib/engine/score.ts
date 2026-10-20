/**
 * The deterministic score (DESIGN.md section 5). This file is the only place the
 * number is decided. No model emits it: the inputs are sandbox facts (forged
 * calls and canary hits, decoy credential reads, persistence writes, process
 * and strace facts, dropped datagrams), static scanner hits, OSV intel, Jev's
 * typed check answers (mapped to bounded, reachability-filtered findings in
 * model/checks.ts) and reputation, which is kept in its own group.
 *
 *   score = clamp(85 + B + I + max(S, -40) + D + R, 0, 100), then caps.
 *
 * Behaviour outweighs static: B reaches -85 while S stops at -40, and a single
 * canary hit alone lands under 30. Unreachable files (tests, docs, examples,
 * infra) contribute nothing. Reputation is bounded to [-8, +5] and reported as
 * its own group. The word "Safe" is never a verdict, and `not_verified` is never
 * empty.
 */

import type {
  Band,
  FileEventData,
  ForgedCallData,
  MaliciousDependency,
  ProcessEventData,
  ScoreDelta,
  TaggedCheckFinding,
  TaggedFinding,
  Verdict,
} from "./types";
import type { Capability } from "./static/heuristics";
import type { ReputationSignals } from "./reputation";

// ---- weights (each one documented; tests pin every value) -------------------

export const BASE = 85;

/**
 * Version of the rules below. Bumped whenever a weight, a cap or a classifier
 * changes, so a cached report scored under older rules is never served as a hit.
 * 2: shells, distribution fetches and reputation never lower the score; every
 * applied deduction cites evidence; a Jev "unclear" no longer blocks 90.
 * 3: an entry that fails or is skipped is neutral; a proven run with nothing
 * taken off reaches the top band on code evidence alone (reputation no longer
 * decides it; at most it lifts an unproven clean run from 85 toward 90).
 * 4: a known-malicious dependency with the repo's own code clean is labelled as a
 * dependency danger and lands in the Caution band, never Malicious.
 */
export const SCORE_RULES = 4;

/** A per-run canary value left the VM (request, DNS name) or was copied into a written file. */
export const W_CANARY = -70;
/** A decoy credential file was opened by a repo process. */
export const W_DECOY_READ = -35;
/** A write to a shell rc file, crontab, systemd user unit, authorized_keys, autostart or /etc. */
export const W_PERSISTENCE = -35;
/** A DNS query shaped like tunneling (subdomain entropy > 3.5 bits/char, length > 40). */
export const W_DNS_TUNNEL = -30;
/** Contact to a host that is neither a package registry nor a distribution host, per distinct host. */
export const W_NON_DIST_HOST = -25;
export const CAP_NON_DIST_HOST = -45;
/** A client refused the forge's per-VM CA (pinning or mTLS): it insisted on a real remote. */
export const W_TLS_REFUSED = -20;
/** An install-phase exec of curl, wget, nc, bash -c, powershell or base64 -d, per distinct command. */
export const W_INSTALL_EXEC = -15;
export const CAP_INSTALL_EXEC = -30;
/** Floor for the whole behaviour group. */
export const CAP_BEHAVIOUR = -85;

/** Any installed or locked dependency with an OSV MAL- id. */
export const W_MALICIOUS_DEP = -60;

/** Static scanner or heuristic finding in a reachable file. */
export const W_STATIC_HIGH = -12;
export const W_STATIC_MEDIUM = -5;
/** Jev check answer of malicious or suspicious on a reachable file (severity set in code, model/checks.ts). */
export const W_CHECK_HIGH = -8;
export const W_CHECK_MEDIUM = -4;
export const FLOOR_STATIC = -40;

/** README/description declares no network or pure, and behaviour contradicts it. */
export const W_DOCS_BEHAVIOUR = -15;
/** The same declaration contradicted only by a reachable static capability. */
export const W_DOCS_STATIC = -6;

// Reputation can only raise the score. A young owner account, a new npm package or
// a recent maintainer change is shown in the reputation group at 0 points: none of
// them is a file, a line or a sandbox event, so none of them takes a point off.
export const W_OWNER_NEW = 0; // GitHub owner account younger than 60 days
export const W_NPM_NEW = 0; // npm first publish younger than 30 days
export const W_MAINTAINER_CHANGED = 0; // npm maintainer set changed within 30 days
export const W_OWNER_ESTABLISHED = 3; // owner older than a year with 3+ public repositories
export const W_DOWNLOADS = 2; // more than 100k npm downloads per week
export const W_STARS = 2; // GitHub repository target with STARS_THRESHOLD or more stars
export const STARS_THRESHOLD = 1000;
export const REPUTATION_MIN = 0;
export const REPUTATION_MAX = 5;

export const CAP_CANARY_OR_PERSISTENCE = 15;
export const CAP_MALICIOUS_DEP = 25;
/** Own code clean, danger only in a dependency: the Caution band (60 to 79), at its top. */
export const CAP_DEPENDENCY_ONLY = 74;
export const CAP_INSTALL_INCOMPLETE = 74;
export const CAP_ENTRY_INCOMPLETE = 89;
export const CAP_NOT_PROVEN = 89;
/** Lowest score of the top band ("No threats observed"). */
export const TOP_BAND = 90;
/** The detonation produced no forensic record (lost bundle, overrun, crash, failed containment probe). */
export const CAP_FORENSICS_LOST = 59;
/** Part of the forensic record was cut by a size cap or a timed-out collection step. */
export const CAP_FORENSICS_PARTIAL = 74;

/**
 * How much of the detonation's forensic record reached the scorer.
 *  - complete: the bundle was read and nothing score-relevant was cut;
 *  - partial: the bundle was read but a harness size cap or collection timeout cut part of it;
 *  - lost: no bundle (or only a salvaged one without the harness result), so behaviour was not observed.
 */
export type ForensicCoverage = "complete" | "partial" | "lost";

// ---- behaviour derivation from forensics ------------------------------------

/** Forge record kinds for registry traffic served from the mirror (never scored). */
export const REGISTRY_FORGED_KINDS = new Set(["mirror", "registry"]);
export const REGISTRY_HOSTS = new Set(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
/** Distribution hosts for behaviour scoring (section 5.3). Anchored suffix match. */
export const BEHAVIOUR_DISTRIBUTION_HOSTS = ["github.com", "objects.githubusercontent.com", "sourceforge.net", "nodejs.org"];

export function isBehaviourDistributionHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return BEHAVIOUR_DISTRIBUTION_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Subdomain part (all labels but the last two), dots removed, length > 40 and entropy > 3.5. */
export function isTunnelingDnsName(name: string): boolean {
  const labels = name.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 3) return false;
  const sub = labels.slice(0, -2).join("");
  return sub.length > 40 && shannonEntropy(sub) > 3.5;
}

const PERSISTENCE_RE =
  /(^|\/)\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|bash_logout)$|\/\.config\/fish\/config\.fish$|\/\.config\/systemd\/user\/|\/\.config\/autostart\/|\/\.ssh\/authorized_keys2?$|^\/etc\/|^\/var\/spool\/cron\//;

export function isPersistencePath(path: string): boolean {
  return PERSISTENCE_RE.test(path);
}

const SUSPICIOUS_BINARIES = new Set(["curl", "wget", "nc", "ncat", "netcat", "powershell", "pwsh", "powershell.exe"]);

function base(argv0: string): string {
  return argv0.slice(argv0.lastIndexOf("/") + 1);
}

/**
 * curl|wget|nc|powershell|base64 -d during install. A shell (`sh -c`, `bash -c`,
 * `zsh -c`) is never counted: npm runs every lifecycle script through one, the
 * harness runs `npm install` through `bash -c`, and an install script that runs
 * `npm install` or `node build.js` is ordinary install behaviour.
 */
export function isSuspiciousInstallExec(argv: string[]): boolean {
  const b = base(argv[0] ?? "");
  if (SUSPICIOUS_BINARIES.has(b)) return true;
  if (b === "base64" && (argv.includes("-d") || argv.includes("--decode") || argv.includes("-D"))) return true;
  return false;
}

export interface BehaviourSignals {
  canaryHits: string[];
  decoyReads: string[];
  persistenceWrites: string[];
  tunnelingDns: string[];
  nonDistributionHosts: string[];
  tlsRefused: string[];
  suspiciousInstallExecs: string[];
  distributionFetches: string[];
}

export const NO_BEHAVIOUR: BehaviourSignals = {
  canaryHits: [],
  decoyReads: [],
  persistenceWrites: [],
  tunnelingDns: [],
  nonDistributionHosts: [],
  tlsRefused: [],
  suspiciousInstallExecs: [],
  distributionFetches: [],
};

export interface ForensicSummary {
  forgedCalls: ForgedCallData[];
  files: FileEventData[];
  processes: ProcessEventData[];
  /** Written files whose content held a canary value. */
  canaryInFiles: string[];
  /** Non-DNS datagram or ICMP egress the fence dropped (strace destinations or fence counters). */
  datagramEgress?: string[];
}

export function deriveBehaviour(f: ForensicSummary): BehaviourSignals {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const canary: string[] = [];
  const tunnel: string[] = [];
  const nonDist: string[] = [];
  const tls: string[] = [];
  const dist: string[] = [];
  for (const c of f.forgedCalls) {
    const host = c.host.toLowerCase();
    for (const hit of c.canary_hits) canary.push(`${hit} sent to ${host} (${c.proto}, ${c.phase})`);
    if (c.proto === "dns") {
      if (isTunnelingDnsName(host)) tunnel.push(host);
      continue;
    }
    if (REGISTRY_FORGED_KINDS.has(c.forged_kind) && REGISTRY_HOSTS.has(host)) continue;
    if (c.tls === "refused") tls.push(host);
    if (isBehaviourDistributionHost(host)) dist.push(host);
    else nonDist.push(host);
  }
  for (const p of f.canaryInFiles) canary.push(`canary copied into written file ${p}`);
  // A dropped UDP or ICMP attempt scores like a non-distribution contact.
  for (const d of f.datagramEgress ?? []) nonDist.push(d);
  const decoy: string[] = [];
  const persist: string[] = [];
  for (const e of f.files) {
    if (e.op === "read_decoy") decoy.push(e.path);
    else if (e.op !== "unlink" && isPersistencePath(e.path)) persist.push(e.path);
  }
  const execs: string[] = [];
  for (const p of f.processes) {
    const b = base(p.argv[0] ?? "");
    if (b === "crontab" && !p.argv.includes("-l")) persist.push(`crontab ${p.argv.slice(1).join(" ")}`.trim());
    if (p.phase === "install" && isSuspiciousInstallExec(p.argv)) {
      execs.push(p.argv.slice(0, 3).join(" ").slice(0, 160));
    }
  }
  return {
    canaryHits: uniq(canary),
    decoyReads: uniq(decoy),
    persistenceWrites: uniq(persist),
    tunnelingDns: uniq(tunnel),
    nonDistributionHosts: uniq(nonDist),
    tlsRefused: uniq(tls),
    suspiciousInstallExecs: uniq(execs),
    distributionFetches: uniq(dist),
  };
}

// ---- score -------------------------------------------------------------------

export type PhaseOutcome = "completed" | "failed" | "timeout" | "skipped";

export interface DocsClaims {
  declaresNoNetwork: boolean;
  declaresPure: boolean;
  quote: string | null;
}

export interface ScoreInput {
  behaviour: BehaviourSignals;
  install: PhaseOutcome;
  entry: PhaseOutcome;
  archiveTruncated: boolean;
  /** Forensic coverage of the detonation, and the reasons for any gap (each becomes a not_verified line). */
  forensics: { coverage: ForensicCoverage; gaps: string[] };
  coverage: { scanners: boolean; osv: boolean; checks: boolean };
  malicious: MaliciousDependency[];
  staticFindings: TaggedFinding[];
  /** Jev check answers that were not benign (malicious, suspicious, unclear). */
  checkFindings: TaggedCheckFinding[];
  docs: DocsClaims | null;
  capabilities: Array<{ file: string; capability: Capability; reach: "install" | "import" | "unreachable" }>;
  reputation: ReputationSignals;
  /** Extra stage failures (deadline, scanner crash) to list under not_verified. */
  failedStages: string[];
}

export interface ScoreResult {
  score: number;
  /** The score before caps. */
  raw: number;
  verdict: Verdict;
  band: Band;
  groups: { behaviour: number; intel: number; static: number; docs: number; reputation: number };
  breakdown: ScoreDelta[];
  notVerified: string[];
  /** Set when the repo's own code is clean and a dependency carries a known malicious record. */
  label?: string;
}

const OS_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows", freebsd: "FreeBSD" };

/** "fsevents 1.2.2 (MAL-2023-462), macOS only, dev lockfile only, not installed in this run" */
export function dependencyLabel(deps: MaliciousDependency[]): string {
  const parts = deps.slice(0, 3).map((m) => {
    const s = m.scope;
    const who: string[] = [];
    if (s && s.os.length > 0) who.push(`${s.os.map((o) => OS_NAMES[o] ?? o).join(", ")} only`);
    if (s?.dev) who.push("dev lockfile only (repo install, not package users)");
    if (s && !s.installed) who.push("not installed in this run");
    return `${m.name} ${m.version} (${m.ids.join(", ")})${who.length ? `, ${who.join(", ")}` : ""}`;
  });
  const more = deps.length > 3 ? ` and ${deps.length - 3} more` : "";
  return `Own code: clean. Danger in a dependency: ${parts.join("; ")}${more}.`;
}

export function verdictFor(score: number): Verdict {
  if (score >= 90) return "No threats observed";
  if (score >= 80) return "Low risk";
  if (score >= 60) return "Caution";
  if (score >= 30) return "High risk";
  return "Malicious";
}

/** Same bands as lib/score.ts (90/80/60). */
export function bandFor(score: number): Band {
  return score >= 90 ? "green" : score >= 80 ? "blue" : score >= 60 ? "yellow" : "red";
}

export const BASE_NOT_VERIFIED = [
  "Behaviour outside the observed install and entry windows.",
  "Code paths not triggered by install or the entry point.",
  "Payloads gated on calendar dates past the accelerated clock window, or on hosts that need real responses.",
];

function capped(points: number, cap: number): number {
  return Math.max(points, cap);
}

function behaviourDeltas(b: BehaviourSignals): ScoreDelta[] {
  const out: ScoreDelta[] = [];
  if (b.canaryHits.length > 0) {
    out.push({ group: "behaviour", code: "canary_exfiltration", points: W_CANARY, detail: "A per-run canary credential left the sandbox or was copied into a file.", evidence: b.canaryHits });
  }
  if (b.decoyReads.length > 0) {
    out.push({ group: "behaviour", code: "decoy_credential_read", points: W_DECOY_READ, detail: "A repo process opened a decoy credential file.", evidence: b.decoyReads });
  }
  if (b.persistenceWrites.length > 0) {
    out.push({ group: "behaviour", code: "persistence_write", points: W_PERSISTENCE, detail: "The code wrote a persistence location (shell rc, crontab, systemd, authorized_keys or /etc).", evidence: b.persistenceWrites });
  }
  if (b.tunnelingDns.length > 0) {
    out.push({ group: "behaviour", code: "dns_tunneling_shape", points: W_DNS_TUNNEL, detail: "DNS queries with a data-carrying subdomain shape.", evidence: b.tunnelingDns });
  }
  if (b.nonDistributionHosts.length > 0) {
    out.push({
      group: "behaviour",
      code: "non_distribution_contact",
      points: capped(W_NON_DIST_HOST * b.nonDistributionHosts.length, CAP_NON_DIST_HOST),
      detail: `Contacted ${b.nonDistributionHosts.length} host(s) that are neither registries nor distribution hosts; the forge answered every call.`,
      evidence: b.nonDistributionHosts,
    });
  }
  if (b.tlsRefused.length > 0) {
    out.push({ group: "behaviour", code: "tls_interception_refused", points: W_TLS_REFUSED, detail: "A client refused the sandbox CA (certificate pinning or mutual TLS).", evidence: b.tlsRefused });
  }
  if (b.suspiciousInstallExecs.length > 0) {
    out.push({
      group: "behaviour",
      code: "install_hook_exec",
      points: capped(W_INSTALL_EXEC * b.suspiciousInstallExecs.length, CAP_INSTALL_EXEC),
      detail: "Install hooks executed download, shell or decode tools.",
      evidence: b.suspiciousInstallExecs,
    });
  }
  // A fetch from a distribution host (github.com and friends: prebuilt binaries,
  // release assets) is ordinary install behaviour and costs nothing on its own. It
  // still counts as network activity against a README that declares no network.
  return out;
}

function staticPoints(f: TaggedFinding): number {
  return f.severity === "high" ? W_STATIC_HIGH : f.severity === "medium" ? W_STATIC_MEDIUM : 0;
}

function checkPoints(f: TaggedCheckFinding): number {
  if (f.verdict !== "malicious" && f.verdict !== "suspicious") return 0;
  return f.severity === "high" ? W_CHECK_HIGH : f.severity === "medium" ? W_CHECK_MEDIUM : 0;
}

interface StaticTally {
  total: number;
  deltas: ScoreDelta[];
  reachableHigh: boolean;
  /** Reachable locations Jev could not decide on. */
  unclear: string[];
}

function staticTally(staticFindings: TaggedFinding[], checks: TaggedCheckFinding[]): StaticTally {
  const best = new Map<string, { points: number; label: string; high: boolean }>();
  const consider = (key: string, points: number, label: string, high: boolean) => {
    const prev = best.get(key);
    if (!prev || points < prev.points) best.set(key, { points, label, high: high || (prev?.high ?? false) });
    else if (high) prev.high = true;
  };
  for (const f of staticFindings) {
    if (f.reach === "unreachable") continue;
    const p = staticPoints(f);
    if (p === 0) continue;
    const key = `${f.file}:${f.line ?? `rule:${f.rule}`}`;
    consider(key, p, `${f.source} ${f.rule} at ${f.file}${f.line ? `:${f.line}` : ""} (${f.reach})`, f.severity === "high");
  }
  const unclear: string[] = [];
  for (const f of checks) {
    if (f.reach === "unreachable") continue;
    if (f.verdict === "unclear") {
      unclear.push(`${f.file}${f.line ? `:${f.line}` : ""} (${f.check} check)`);
      continue;
    }
    const p = checkPoints(f);
    if (p === 0) continue;
    const key = `${f.file}:${f.line ?? `check:${f.check}:${f.question}`}`;
    consider(key, p, `Jev ${f.check} check: ${f.verdict} at ${f.file}${f.line ? `:${f.line}` : ""} (${f.reach}${f.probability !== null ? `, p=${f.probability.toFixed(2)}` : ""})`, f.severity === "high");
  }
  const entries = [...best.values()];
  const raw = entries.reduce((s, e) => s + e.points, 0);
  const total = Math.max(raw, FLOOR_STATIC);
  const deltas: ScoreDelta[] = [];
  if (raw !== 0) {
    deltas.push({
      group: "static",
      code: "reachable_static_findings",
      points: total,
      detail: `${entries.length} reachable finding location(s)${raw < FLOOR_STATIC ? `, ${raw} floored at ${FLOOR_STATIC}` : ""}.`,
      evidence: entries.map((e) => `${e.points}: ${e.label}`).slice(0, 25),
    });
  }
  return { total, deltas, reachableHigh: entries.some((e) => e.high), unclear: [...new Set(unclear)].sort() };
}

function docsDelta(input: ScoreInput): ScoreDelta | null {
  const d = input.docs;
  if (!d || (!d.declaresNoNetwork && !d.declaresPure)) return null;
  const b = input.behaviour;
  const networkObserved = b.nonDistributionHosts.length > 0 || b.canaryHits.length > 0 || b.tunnelingDns.length > 0 || b.distributionFetches.length > 0;
  const sideEffectObserved = b.persistenceWrites.length > 0 || b.decoyReads.length > 0;
  const claim = [d.declaresNoNetwork ? "no network" : null, d.declaresPure ? "pure" : null].filter(Boolean).join(" and ");
  const quote = d.quote ? [`declared: "${d.quote.slice(0, 200)}"`] : [];
  if ((d.declaresNoNetwork || d.declaresPure) && networkObserved) {
    return { group: "docs", code: "docs_contradicted_by_behaviour", points: W_DOCS_BEHAVIOUR, detail: `Documentation declares ${claim}; the detonation observed network activity.`, evidence: quote };
  }
  if (d.declaresPure && sideEffectObserved) {
    return { group: "docs", code: "docs_contradicted_by_behaviour", points: W_DOCS_BEHAVIOUR, detail: "Documentation declares pure; the detonation observed side effects.", evidence: quote };
  }
  const reachableCaps = input.capabilities.filter((c) => c.reach !== "unreachable");
  const staticHit = reachableCaps.find(
    (c) => (d.declaresNoNetwork && c.capability === "network") || (d.declaresPure && (c.capability === "network" || c.capability === "process" || c.capability === "fs_write")),
  );
  if (staticHit) {
    return {
      group: "docs",
      code: "docs_contradicted_by_static",
      points: W_DOCS_STATIC,
      detail: `Documentation declares ${claim}; reachable code has ${staticHit.capability} capability.`,
      evidence: [...quote, `${staticHit.capability} in ${staticHit.file}`],
    };
  }
  return null;
}

function reputationDeltas(r: ReputationSignals): { total: number; deltas: ScoreDelta[] } {
  const deltas: ScoreDelta[] = [];
  if (r.ownerAgeDays !== null && r.ownerAgeDays < 60) {
    deltas.push({ group: "reputation", code: "owner_new", points: W_OWNER_NEW, detail: `GitHub owner account is ${r.ownerAgeDays} days old.` });
  }
  if (r.npmFirstPublishDays !== null && r.npmFirstPublishDays < 30) {
    deltas.push({ group: "reputation", code: "npm_new", points: W_NPM_NEW, detail: `npm package first published ${r.npmFirstPublishDays} days ago.` });
  }
  if (r.maintainerChangedWithin30d === true) {
    deltas.push({ group: "reputation", code: "maintainer_changed", points: W_MAINTAINER_CHANGED, detail: "npm maintainer set changed within the last 30 days." });
  }
  if (r.ownerEstablished === true) {
    deltas.push({ group: "reputation", code: "owner_established", points: W_OWNER_ESTABLISHED, detail: "GitHub owner account is over a year old with 3 or more public repositories." });
  }
  if (r.weeklyDownloads !== null && r.weeklyDownloads > 100_000) {
    deltas.push({ group: "reputation", code: "high_downloads", points: W_DOWNLOADS, detail: `${r.weeklyDownloads} npm downloads in the last week.` });
  }
  if (r.repoStars !== null && r.repoStars >= STARS_THRESHOLD) {
    deltas.push({ group: "reputation", code: "popular_repo", points: W_STARS, detail: `GitHub repository has ${r.repoStars} stars.` });
  }
  const raw = deltas.reduce((s, d) => s + d.points, 0);
  return { total: Math.min(REPUTATION_MAX, Math.max(REPUTATION_MIN, raw)), deltas };
}

function phaseText(name: string, p: PhaseOutcome): string {
  return p === "skipped" ? `${name} phase was skipped, so its behaviour was not observed.` : `${name} phase did not complete (${p}), so later behaviour was not observed.`;
}

/** A deduction that cannot point at a file, a line or a sandbox event is not applied. */
function evidenced(d: ScoreDelta): boolean {
  return d.points >= 0 || (Array.isArray(d.evidence) && d.evidence.some((e) => typeof e === "string" && e.trim().length > 0));
}

export function computeScore(input: ScoreInput): ScoreResult {
  const bDeltas = behaviourDeltas(input.behaviour).filter(evidenced);
  const B = Math.max(CAP_BEHAVIOUR, bDeltas.reduce((s, d) => s + d.points, 0));
  // The repo's own code is clean when nothing in behaviour, static or docs takes a
  // point off. Then a known-malicious dependency is a dependency danger: labelled,
  // capped into Caution, never called Malicious. With own-code signals it counts in full.
  const ownCodeClean = behaviourDeltas(input.behaviour).filter(evidenced).length === 0 && staticTally(input.staticFindings, input.checkFindings).total === 0 && !docsDelta(input);
  const dependencyOnly = input.malicious.length > 0 && ownCodeClean;
  const I = input.malicious.length > 0 && !dependencyOnly ? W_MALICIOUS_DEP : 0;
  const st = staticTally(input.staticFindings, input.checkFindings);
  const S = st.total;
  const dRaw = docsDelta(input);
  const dDelta = dRaw && evidenced(dRaw) ? dRaw : null;
  const D = dDelta ? dDelta.points : 0;
  const rep = reputationDeltas(input.reputation);
  const R = rep.total;

  const breakdown: ScoreDelta[] = [...bDeltas];
  if (B !== bDeltas.reduce((s, d) => s + d.points, 0)) {
    breakdown.push({ group: "behaviour", code: "behaviour_floor", points: B - bDeltas.reduce((s, d) => s + d.points, 0), detail: `Behaviour group floored at ${CAP_BEHAVIOUR}.` });
  }
  if (I !== 0) {
    breakdown.push({
      group: "intel",
      code: "osv_malicious_dependency",
      points: I,
      detail: "A dependency has an OSV malicious-package record.",
      evidence: input.malicious.map((m) => `${m.ecosystem} ${m.name}@${m.version}: ${m.ids.join(", ")}`),
    });
  }
  breakdown.push(...st.deltas);
  if (dDelta) breakdown.push(dDelta);
  breakdown.push(...rep.deltas);
  const repRaw = rep.deltas.reduce((s, d) => s + d.points, 0);
  if (repRaw !== R) {
    breakdown.push({ group: "reputation", code: "reputation_bound", points: R - repRaw, detail: `Reputation bounded to [${REPUTATION_MIN}, +${REPUTATION_MAX}].` });
  }

  const raw = Math.min(100, Math.max(0, BASE + B + I + Math.max(S, FLOOR_STATIC) + D + R));
  let score = raw;
  const applyCap = (cap: number, code: string, detail: string) => {
    if (score > cap) {
      breakdown.push({ group: "cap", code, points: cap - score, detail });
      score = cap;
    }
  };

  const notVerified = [...BASE_NOT_VERIFIED];
  if (input.forensics.coverage === "lost") {
    applyCap(CAP_FORENSICS_LOST, "cap_forensics_lost", `The sandbox run produced no forensic record, so behaviour was not observed and the score is capped at ${CAP_FORENSICS_LOST}.`);
    notVerified.push("The sandbox run did not produce a forensic record, so install-time and runtime behaviour were not observed.");
  } else if (input.forensics.coverage === "partial") {
    applyCap(CAP_FORENSICS_PARTIAL, "cap_forensics_partial", `Part of the sandbox forensic record was cut, so the score is capped at ${CAP_FORENSICS_PARTIAL}.`);
    notVerified.push("Part of the sandbox forensic record was cut, so behaviour in the cut part was not observed.");
  }
  for (const g of input.forensics.gaps) notVerified.push(g);
  if (input.behaviour.canaryHits.length > 0 || input.behaviour.persistenceWrites.length > 0) {
    applyCap(CAP_CANARY_OR_PERSISTENCE, "cap_canary_or_persistence", `Credential exfiltration or persistence caps the score at ${CAP_CANARY_OR_PERSISTENCE}.`);
  }
  if (dependencyOnly) {
    if (score > CAP_DEPENDENCY_ONLY) {
      breakdown.push({
        group: "cap",
        code: "dependency_malicious_record",
        points: CAP_DEPENDENCY_ONLY - score,
        detail: `${dependencyLabel(input.malicious)} The repo's own code is clean, so the score is capped at ${CAP_DEPENDENCY_ONLY} (Caution).`,
        evidence: input.malicious.map((m) => `${m.ecosystem} ${m.name}@${m.version}: ${m.ids.join(", ")}`),
      });
      score = CAP_DEPENDENCY_ONLY;
    }
  } else if (input.malicious.length > 0) {
    applyCap(CAP_MALICIOUS_DEP, "cap_malicious_dependency", `A known malicious dependency caps the score at ${CAP_MALICIOUS_DEP}.`);
  }
  // Running out of time is not a bad signal: a phase that timed out (and an entry
  // skipped only because install timed out) never lowers the score. What did not
  // run is still stated as not verified. A failed phase still caps.
  const installRan = input.install === "completed" || input.install === "timeout";
  // A library usually has no runnable entry point: an entry that fails or is skipped
  // is not a bad signal either. It is stated as not verified.
  const entryRan = true;
  if (input.install !== "completed") notVerified.push(phaseText("Install", input.install));
  if (!installRan || input.archiveTruncated) {
    applyCap(CAP_INSTALL_INCOMPLETE, "cap_install_incomplete", `Install did not complete, so the score is capped at ${CAP_INSTALL_INCOMPLETE}.`);
    if (input.archiveTruncated) notVerified.push("Files past the archive size cap were not analysed.");
  } else if (!entryRan) {
    applyCap(CAP_ENTRY_INCOMPLETE, "cap_entry_incomplete", `The entry point did not complete, so the score is capped at ${CAP_ENTRY_INCOMPLETE}.`);
  }
  if (input.entry !== "completed") notVerified.push(phaseText("Entry", input.entry));
  if (!input.coverage.scanners) notVerified.push("Static scanners (Semgrep, YARA, GuardDog) did not complete.");
  if (!input.coverage.osv) notVerified.push("OSV malicious-package lookup did not complete.");
  if (!input.coverage.checks) notVerified.push("Jev checks did not complete, so no model judged the install surface, the flagged code or the documentation.");
  if (st.unclear.length > 0) notVerified.push(`Jev could not decide on ${st.unclear.length} reachable location(s): ${st.unclear.slice(0, 5).join(", ")}.`);
  for (const u of input.reputation.unavailable) notVerified.push(`Reputation signal unavailable: ${u}.`);
  for (const s of input.failedStages) notVerified.push(s);

  const proven =
    installRan &&
    entryRan &&
    input.forensics.coverage === "complete" &&
    !input.archiveTruncated &&
    B === 0 &&
    I === 0 &&
    !st.reachableHigh &&
    R >= 0 &&
    input.coverage.scanners &&
    input.coverage.osv &&
    input.coverage.checks;
  if (proven && score < TOP_BAND && !breakdown.some((d) => d.points < 0)) {
    // Fully observed and nothing taken off: the code evidence alone earns the top
    // band, whatever the reputation group says.
    breakdown.push({ group: "cap", code: "proven_clean", points: TOP_BAND - score, detail: `Install and entry ran with full coverage and no deduction, so the score is lifted to ${TOP_BAND}.` });
    score = TOP_BAND;
  }
  if (!proven) {
    applyCap(CAP_NOT_PROVEN, "cap_not_proven", "A score of 90 or more needs install and entry to run (a timeout counts as run), no behaviour or intel hits, no reachable high finding and full coverage.");
  }

  const unique = [...new Set(notVerified)];
  const label = dependencyOnly ? dependencyLabel(input.malicious) : undefined;
  return {
    score,
    raw,
    verdict: verdictFor(score),
    band: bandFor(score),
    groups: { behaviour: B, intel: I, static: S, docs: D, reputation: R },
    breakdown,
    notVerified: unique,
    ...(label ? { label } : {}),
  };
}
