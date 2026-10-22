/**
 * runScan: the one scan pipeline every surface calls (DESIGN.md sections 2, 6).
 *
 *   resolve -> SHA cache (hit: replay the stored events, done) -> claim the run
 *   (a second request for the same SHA attaches) -> fetch + verify + untar in
 *   memory -> reachability graph -> in parallel: analysis sandbox scanners, OSV,
 *   reputation, Jev checks (AI Gateway, concurrent), detonation in a fresh E2B
 *   VM -> OSV on what was installed -> deterministic score from the sandbox
 *   facts and the Jev answers -> Luna's one call writes the report -> persist
 *   with the cost ledger.
 *
 * Every step emits ordered events on one bus (live to the caller, batched into
 * scan_events for Realtime and replay). A failed stage lowers coverage, which
 * caps the score and lands in `not_verified`; it never produces a confident
 * verdict. Both sandboxes are created for this scan only and killed in
 * `finally`.
 */

import { randomUUID } from "node:crypto";
import { ArchiveError, parseTarball, type ParsedArchive } from "./archive";
import type { EngineConfig } from "./config";
import { createRunEventBus, type RunEventBus } from "./events";
import { makeCanaries, type Canaries } from "./forensics/capture";
import { CostMeter, type CostLedger } from "./cost";
import type { ModelAdapter } from "./model/adapter";
import { buildDocsSlice, buildFlaggedSlice, buildInstallSlice, runDocsCheck, runFlaggedCheck, runInstallCheck, statedPurpose, type CheckAnswerRecord } from "./model/checks";
import type { JevAdapter } from "./model/jev";
import { writeReport } from "./model/writer";
import { buildReachGraph, type ReachGraph, type WorkspacePlan } from "./reach/graph";
import { computeReputation, fetchGithubOwner, fetchWeeklyDownloads, type ReputationSignals } from "./reputation";
import { fetchGithubTarball, githubTreeSize, resolveGithub, verifyGithubArchive, type GithubResolution } from "./resolve/github";
import { SANDBOX_SIZES, sizeForRepo, type SandboxSize } from "./sandbox/resources";
import { fetchNpmTarball, npmCommitKey, resolveNpm, type NpmResolution } from "./resolve/npm";
import { fetchOperatorTarball } from "./resolve/tarball";
import { bootAnalysis, runAnalysisOn, type AnalysisResult } from "./sandbox/analyze";
import { buildRanSummary } from "./ran";
import { bootDetonation, runDetonation, type DetonationResult, type DetonationVm } from "./sandbox/detonate";
import { REGISTRY_ALLOW_OUT, SandboxCreateError, type BootedSandbox, type SandboxProvider } from "./sandbox/provider";
import { planInstall } from "./plan";
import { fetchRepoInVm, mapAndScanInVm, proveFenceInVm, writeDropBaseline, type VmMapStats } from "./sandbox/vmfetch";
import { SCORE_RULES, computeScore, deriveBehaviour, type DocsClaims, type ScoreResult } from "./score";
import { depsFromArchive, queryOsv, type OsvResult } from "./static/osv";
import { runHeuristics, type HeuristicResult } from "./static/heuristics";
import type { ScanStore, TargetKind } from "./store";
import {
  EngineError,
  type CheckFinding,
  type DependencyRef,
  type ErrorCode,
  type MaliciousDependency,
  type ReportPayload,
  type ScanEvent,
  type ScanOutcome,
  type ScanRequest,
  type StageName,
  type StaticFinding,
  type TaggedCheckFinding,
  type TaggedFinding,
} from "./types";

export interface EngineDeps {
  /** Jev: every model-judged check (AI Gateway, OIDC). */
  jev: JevAdapter;
  /** Luna: the one report call per fresh scan. */
  luna: ModelAdapter;
  sandbox: SandboxProvider;
  store: ScanStore;
  fetch: typeof fetch;
  now: () => number;
  config: EngineConfig;
  /** Run id factory (tests pin it); defaults to crypto.randomUUID. */
  newRunId?: () => string;
  /** Random bytes for canaries (tests pin it); defaults to crypto.randomBytes. */
  random?: (n: number) => Uint8Array;
}

export interface RunScanOptions {
  /**
   * Live event listener. There is deliberately no abort signal: a scan always
   * runs to its own deadline (scanMs) so a client disconnect can never cut OSV,
   * the Jev checks or the Luna report short and leave a degraded run behind.
   */
  onEvent?: (e: ScanEvent) => void;
  /**
   * Full-install scans only (ScanRequest.full): the viewer leaving stops the scan,
   * because nothing is earning for it. Every other scan has no abort signal.
   */
  stop?: AbortSignal;
  /**
   * When set, the work after the report is built (persist, budget charge, event
   * flush, run row) runs as this background task and `runScan` returns the
   * report at once. The caller keeps the process alive until the task settles
   * (Next's `after()`); the task never rejects. Without it the work is awaited.
   */
  background?: (task: Promise<void>) => void;
  /** Called once the report row is saved, with the persisted owner and repo (cache invalidation). */
  onPersisted?: (saved: { ownerLogin: string; repoName: string; kind: TargetKind }) => void;
}

/**
 * Stored under forensics.coverage on every 2.0 report. A run whose coverage is
 * not complete is persisted and shown, but never served as the SHA cache hit:
 * the next request runs a fresh scan.
 */
export interface RunCoverage {
  complete: boolean;
  failed: string[];
  /**
   * Phases that ran out of time. A timeout is not a coverage failure: the run is
   * cached and served as a hit, and this marks what did not finish (the report's
   * not_verified lines say the same in words).
   */
  timed_out: string[];
}

export function cachedCoverageComplete(report: { forensics?: unknown; score_rules?: unknown } | null | undefined): boolean {
  // A report scored under older rules is stale: the next request scores it again.
  if (report?.score_rules !== SCORE_RULES) return false;
  // Incomplete coverage is cached too: forensics.coverage.failed marks what did not run,
  // and the report's not_verified lines say it in words.
  const f = report?.forensics;
  if (typeof f !== "object" || f === null) return false;
  const c = (f as { coverage?: unknown }).coverage;
  return typeof c === "object" && c !== null && Array.isArray((c as { failed?: unknown }).failed);
}

/** libfaketime speed during install and entry (DESIGN.md section 3.3 step 8). */
export const FAKE_CLOCK_RATE = 30;

interface Resolved {
  kind: TargetKind;
  subject: string;
  display: string;
  ownerLogin: string;
  repoName: string;
  /** Cache key; for npm with a sha512 registry digest it is known before the fetch. */
  commitSha: string | null;
  github?: GithubResolution;
  npm?: NpmResolution;
}

function deadline(ms: number, outer: AbortSignal): AbortSignal {
  return AbortSignal.any([outer, AbortSignal.timeout(ms)]);
}

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function codeOf(err: unknown): ErrorCode {
  if (err instanceof EngineError) return err.code;
  if (err instanceof ArchiveError) return err.reason === "too_large" ? "too_large" : "integrity";
  if (err instanceof SandboxCreateError) return "capacity";
  if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") return "timeout";
  return "internal";
}

/** Listener gate: events are held until the run's path (cached or fresh) is known. */
function gate(onEvent?: (e: ScanEvent) => void) {
  let open = false;
  let held: ScanEvent[] = [];
  return {
    listener(e: ScanEvent) {
      if (!onEvent) return;
      if (open) onEvent(e);
      else held.push(e);
    },
    release() {
      open = true;
      if (onEvent) for (const e of held) onEvent(e);
      held = [];
    },
    drop() {
      held = [];
    },
  };
}

async function resolveTarget(req: ScanRequest, deps: EngineDeps, signal: AbortSignal): Promise<Resolved> {
  const t = req.target;
  const timeoutMs = deps.config.deadlines.resolveMs;
  if (t.kind === "github") {
    const r = await resolveGithub({ owner: t.owner, repo: t.repo, ...(t.ref ? { ref: t.ref } : {}) }, { fetch: deps.fetch, token: deps.config.githubToken, timeoutMs, signal });
    return { kind: "github", subject: `${r.owner}/${r.repo}`, display: `${r.owner}/${r.repo}`, ownerLogin: r.owner, repoName: r.repo, commitSha: r.sha, github: r };
  }
  if (t.kind === "npm") {
    const r = await resolveNpm({ name: t.name, ...(t.version ? { version: t.version } : {}) }, { fetch: deps.fetch, timeoutMs, maxPackumentBytes: deps.config.limits.maxPackumentBytes, signal });
    const sha512 = r.integrity && /^sha512-[A-Za-z0-9+/]+=*$/.test(r.integrity.trim()) ? r.integrity.trim() : null;
    return {
      kind: "npm",
      subject: `npm:${r.name}`,
      display: `npm:${r.name}@${r.version}`,
      ownerLogin: "npm",
      repoName: r.name,
      commitSha: sha512 ? npmCommitKey(r.version, sha512) : null,
      npm: r,
    };
  }
  if (!req.caller.operator) throw new EngineError("unauthorized", "tarball targets need the operator key");
  return { kind: "tarball", subject: `tarball:${t.label}`, display: t.label, ownerLogin: "tarball", repoName: t.label, commitSha: t.integrity.trim() };
}

interface Fetched {
  bytes: Uint8Array;
  archive: ParsedArchive;
  commitSha: string;
  /** Set when the whole repo was fetched and mapped inside the VMs (vmfetch.ts). */
  vm?: { graph: ReachGraph; heur: HeuristicResult; stats: VmMapStats; analysis: AnalysisResult };
}

/**
 * Who a known-malicious dependency reaches: its lockfile flags (dev, optional, os),
 * the `os` its own npm manifest declares, and whether this run's install pulled it in.
 */
async function scopeMalicious(
  mal: MaliciousDependency[],
  files: Map<string, Uint8Array>,
  installed: DependencyRef[],
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<MaliciousDependency[]> {
  if (mal.length === 0) return mal;
  const flags = new Map<string, { dev: boolean; optional: boolean; os: string[] }>();
  const lockText = new TextDecoder().decode(files.get("package-lock.json") ?? files.get("npm-shrinkwrap.json") ?? new Uint8Array());
  try {
    const lock = JSON.parse(lockText || "{}") as { packages?: Record<string, Record<string, unknown>>; dependencies?: Record<string, Record<string, unknown>> };
    for (const [key, v] of Object.entries(lock.packages ?? {})) {
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1 || typeof v.version !== "string") continue;
      const name = typeof v.name === "string" ? v.name : key.slice(idx + "node_modules/".length);
      flags.set(`${name}@${v.version}`, { dev: v.dev === true, optional: v.optional === true, os: Array.isArray(v.os) ? v.os.filter((x): x is string => typeof x === "string") : [] });
    }
    const walk = (deps: Record<string, Record<string, unknown>> | undefined) => {
      for (const [name, v] of Object.entries(deps ?? {})) {
        if (typeof v?.version === "string") flags.set(`${name}@${v.version}`, { dev: v.dev === true, optional: v.optional === true, os: [] });
        walk(v?.dependencies as Record<string, Record<string, unknown>> | undefined);
      }
    };
    walk(lock.dependencies);
  } catch {
    // No or unreadable lockfile: flags stay unknown (false), never guessed.
  }
  const inst = new Set(installed.map((d) => `${d.name}@${d.version}`));
  return Promise.all(
    mal.map(async (m) => {
      const f = flags.get(`${m.name}@${m.version}`);
      let os = f?.os ?? [];
      if (os.length === 0 && m.ecosystem === "npm" && /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(m.name)) {
        try {
          const res = await fetchFn(`https://registry.npmjs.org/${m.name}/${encodeURIComponent(m.version)}`, { signal: AbortSignal.timeout(3_000) });
          if (res.ok) {
            const j = (await res.json()) as { os?: unknown };
            if (Array.isArray(j.os)) os = j.os.filter((x): x is string => typeof x === "string" && !x.startsWith("!"));
          }
        } catch {
          // Unknown platform stays unstated.
        }
      }
      return { ...m, scope: { installed: inst.has(`${m.name}@${m.version}`), dev: f?.dev ?? false, optional: f?.optional ?? false, os } };
    }),
  );
}

/** The reputation section: facts with their sources and prominent warnings, separate from the code score. */
function reputationSection(rep: ReputationSignals, r: Resolved): { facts: Array<{ fact: string; source: string }>; warnings: string[] } {
  const gh = r.kind === "github" ? `https://api.github.com/repos/${r.github!.owner}/${r.github!.repo}` : null;
  const owner = `https://api.github.com/users/${r.ownerLogin}`;
  const npm = r.kind === "npm" ? `https://registry.npmjs.org/${r.npm!.name}` : null;
  const facts: Array<{ fact: string; source: string }> = [];
  const warnings: string[] = [];
  if (rep.ownerAgeDays !== null) facts.push({ fact: `Owner account age: ${rep.ownerAgeDays} days`, source: owner });
  if (rep.ownerEstablished !== null) facts.push({ fact: rep.ownerEstablished ? "Owner established (over a year, 3+ public repositories)" : "Owner not established", source: owner });
  if (rep.repoStars !== null && gh) facts.push({ fact: `Stars: ${rep.repoStars}`, source: gh });
  if (rep.weeklyDownloads !== null && npm) facts.push({ fact: `Weekly npm downloads: ${rep.weeklyDownloads}`, source: `https://api.npmjs.org/downloads/point/last-week/${r.npm!.name}` });
  if (rep.npmFirstPublishDays !== null && npm) facts.push({ fact: `First npm publish: ${rep.npmFirstPublishDays} days ago`, source: npm });
  if (rep.maintainerChangedWithin30d !== null && npm) facts.push({ fact: rep.maintainerChangedWithin30d ? "Maintainer set changed within 30 days" : "No maintainer change within 30 days", source: npm });
  for (const e of rep.evidence) facts.push({ fact: e, source: gh ?? npm ?? owner });
  if (rep.ownerAgeDays !== null && rep.ownerAgeDays < 60) warnings.push(`Warning: the owner account is only ${rep.ownerAgeDays} days old.`);
  if (rep.npmFirstPublishDays !== null && rep.npmFirstPublishDays < 30) warnings.push(`Warning: the package was first published ${rep.npmFirstPublishDays} days ago.`);
  if (rep.maintainerChangedWithin30d === true) warnings.push("Warning: the package's maintainers changed within the last 30 days.");
  if (rep.ownerEstablished === false) warnings.push("Warning: the owner has little public history.");
  for (const u of rep.unavailable) warnings.push(`Not checked: ${u}.`);
  if (warnings.length > 0) warnings.push("Reputation warnings are shown on their own and do not lower the code score.");
  return { facts, warnings };
}

/** The reach graph the VM built over the whole repo, rebuilt from its JSON. */
function graphFromVm(g: VmGraphJson): ReachGraph {
  return {
    install: new Set(g.install),
    import: new Set(g.import),
    entries: g.entries,
    inlineInstallCommands: g.inlineInstallCommands,
    unbounded: g.unbounded,
    unboundedFrom: g.unboundedFrom,
    ecosystems: g.ecosystems,
    workspace: g.workspace ?? null,
    classify: (path: string) => (g.classes[path] === 1 ? "install" : g.classes[path] === 2 ? "import" : "unreachable"),
  };
}

interface VmGraphJson {
  install: string[];
  import: string[];
  entries: ReachGraph["entries"];
  inlineInstallCommands: ReachGraph["inlineInstallCommands"];
  unbounded: boolean;
  unboundedFrom: string[];
  ecosystems: ReachGraph["ecosystems"];
  workspace?: WorkspacePlan | null;
  classes: Record<string, 1 | 2>;
}

/**
 * Huge repos (the 2 vCPU tier) get an install window sized to them: openclaw's pnpm
 * install did not finish in 60 s. The scan still ends inside maxDuration (300 s).
 */
const LARGE_INSTALL_MS = 60_000;
const LARGE_DETONATE_MS = 265_000;
const LARGE_SANDBOX_MS = 285_000;

/** Scanner window in the one-VM path: small repos finish in 3 to 5 s; openclaw (57k files) did not finish in 45 s nor in 90 s, so the longer window only bought cost. */
const VM_SCANNER_MS = 45_000;

/** The slice the models read is bounded; every scored fact comes from the whole repo in the VM. */
const VM_VIEW_LIMITS = { maxCompressedBytes: 64 * 1024 * 1024, maxExpandedBytes: 64 * 1024 * 1024, maxFiles: 50_000, maxPackumentBytes: 0, stripFirstComponent: true };
async function vmFetchAndMap(
  r: Resolved,
  dvm: DetonationVm,
  emitStage: (n: StageName, s: "start" | "done", d?: string) => void,
  check: (name: string, ok: boolean, detail: string) => void,
  onLine: (tool: "semgrep" | "guarddog" | "yara", stream: "stdout" | "stderr", text: string) => void,
  scannerTimeoutMs: number,
): Promise<Fetched> {
  const gh = r.github!;
  const ds = await dvm.vm.session();
  emitStage("fetch", "start");
  const d = await fetchRepoInVm(ds, gh, REGISTRY_ALLOW_OUT, "/root/in/target.tgz", 60_000);
  emitStage("fetch", "done", `${d.bytes} bytes fetched inside the VM from codeload.github.com in ${d.ms} ms; commit id verified; egress restored`);
  emitStage("verify", "start");
  const fence = await proveFenceInVm(ds);
  check("fence_after_fetch", fence.ok, fence.detail);
  if (!fence.ok) throw new EngineError("internal", "the containment check failed after the repo fetch, so no repo code ran");
  const { view, stats, graph, heur, analysis, ms } = await mapAndScanInVm(ds, "/root/in/target.tgz", 60_000, scannerTimeoutMs, onLine);
  const archive = await parseTarball(view, VM_VIEW_LIMITS);
  check("fence_baseline", true, `drop counters before the go file (harness traffic): ${await writeDropBaseline(ds)}`);
  emitStage(
    "verify",
    "done",
    `whole repo mapped and scanned in the VM before any repo code (extract ${ms.extract} ms, map ${ms.map} ms, scanners ${ms.scan} ms): ${stats.files} files (${stats.bytes} bytes), ${stats.reach.install} install / ${stats.reach.import} import reachable, ${stats.heuristic_findings} heuristic findings; models read ${archive.files.size} files (${stats.view_bytes} bytes)`,
  );
  return { bytes: new Uint8Array(0), archive, commitSha: gh.sha, vm: { graph: graphFromVm(graph as VmGraphJson), heur: heur as HeuristicResult, stats, analysis } };
}

async function fetchAndVerify(req: ScanRequest, r: Resolved, deps: EngineDeps, signal: AbortSignal, emitStage: (n: StageName, s: "start" | "done", d?: string) => void): Promise<Fetched> {
  const limits = deps.config.limits;
  const timeoutMs = deps.config.deadlines.fetchMs;
  let bytes: Uint8Array;
  let commitSha = r.commitSha;
  emitStage("fetch", "start");
  if (r.kind === "github") {
    bytes = await fetchGithubTarball(r.github!.owner, r.github!.repo, r.github!.sha, { fetch: deps.fetch, token: deps.config.githubToken, timeoutMs, signal }, limits.maxCompressedBytes);
  } else if (r.kind === "npm") {
    const v = await fetchNpmTarball(r.npm!, { fetch: deps.fetch, timeoutMs, maxPackumentBytes: limits.maxPackumentBytes, signal }, limits.maxCompressedBytes);
    bytes = v.bytes;
    commitSha = npmCommitKey(r.npm!.version, v.sha512);
  } else {
    const t = req.target as Extract<ScanRequest["target"], { kind: "tarball" }>;
    const v = await fetchOperatorTarball({ url: t.url, integrity: t.integrity, label: t.label }, { fetch: deps.fetch, timeoutMs, signal }, limits.maxCompressedBytes);
    bytes = v.bytes;
  }
  emitStage("fetch", "done", `${bytes.length} bytes`);
  emitStage("verify", "start");
  // Strip-1 for every target, exactly as npm (pacote) and the VM (`tar --strip-components=1`) unpack it.
  const archive = await parseTarball(bytes, { ...limits, stripFirstComponent: true });
  if (r.kind === "github") verifyGithubArchive(archive, r.github!.sha);
  emitStage("verify", "done", `${archive.files.size} files${archive.truncated ? `, truncated (${archive.truncatedReason})` : ""}`);
  return { bytes, archive, commitSha: commitSha! };
}

function tag(findings: StaticFinding[], graph: ReachGraph): TaggedFinding[] {
  return findings.map((f) => ({ ...f, reach: graph.classify(f.file) }));
}

function tagChecks(findings: CheckFinding[], graph: ReachGraph): TaggedCheckFinding[] {
  return findings.map((f) => ({ ...f, reach: graph.classify(f.file) }));
}

/** What the writer and the evidence list are allowed to say about the sandbox run. */
export function sandboxObservation(d: DetonationResult | null): "observed" | "partial" | "not_observed" {
  if (!d || d.install !== "completed" || d.forensics.coverage === "lost") return "not_observed";
  return d.forensics.coverage === "complete" ? "observed" : "partial";
}

function mergeMalicious(a: MaliciousDependency[], b: MaliciousDependency[]): MaliciousDependency[] {
  const m = new Map<string, MaliciousDependency>();
  for (const d of [...a, ...b]) m.set(`${d.ecosystem}:${d.name}@${d.version}`, d);
  return [...m.values()];
}

export async function runScan(req: ScanRequest, deps: EngineDeps, opts: RunScanOptions = {}): Promise<ScanOutcome> {
  const cfg = deps.config;
  const startedAt = deps.now();
  const runId = (deps.newRunId ?? randomUUID)();
  const outer = req.full && opts.stop ? AbortSignal.any([AbortSignal.timeout(cfg.deadlines.scanMs), opts.stop]) : AbortSignal.timeout(cfg.deadlines.scanMs);
  const g = gate(opts.onEvent);
  let claimed = false;
  let discard = false;
  const preclaim: ScanEvent[] = [];
  const bus: RunEventBus = createRunEventBus({
    runId,
    startedAt,
    now: deps.now,
    listeners: [(e) => g.listener(e)],
    persist: async (batch) => {
      if (discard) return;
      if (!claimed) {
        preclaim.push(...batch);
        return;
      }
      const all = preclaim.splice(0, preclaim.length).concat(batch);
      if (all.length > 0) await deps.store.appendEvents(all);
    },
    // A lost event batch breaks replay and the Realtime broadcast; say so in the runtime log.
    onPersistError: (err) => console.error("scan_events persist failed:", errMessage(err).slice(0, 300)),
  });
  const timings: Record<string, number> = {};
  const stageStart = new Map<StageName, number>();
  const emitStage = (name: StageName, status: "start" | "done" | "error" | "skipped", detail?: string) => {
    if (status === "start") stageStart.set(name, deps.now());
    bus.emit({ type: "stage", data: { name, status, ...(detail ? { detail: detail.slice(0, 500) } : {}) } });
    if (status === "done" || status === "error") {
      const ms = Math.round(deps.now() - (stageStart.get(name) ?? deps.now()));
      timings[name] = ms;
      bus.emit({ type: "timing", data: { name, ms } });
    }
  };
  const check = (name: string, ok: boolean, detail?: string) => bus.emit({ type: "check", data: { name, ok, ...(detail ? { detail: detail.slice(0, 500) } : {}) } });

  // Both VMs boot as soon as the run is claimed and under budget, so their boot
  // (and the forge, fence and containment probe in the detonation VM) overlaps
  // the fetch. Each VM is fresh for this scan and is killed when its work ends or
  // on any early exit; every kill is awaited before the run closes.
  let detVm: DetonationVm | null = null;
  let anaVm: BootedSandbox | null = null;
  const kills: Promise<void>[] = [];
  const sandboxMs: number[] = [];
  // A GitHub repo on a provider that can switch egress (E2B) is fetched, mapped and
  // scanned inside one VM (vmfetch.ts); other targets keep the two-VM path.
  const oneVm = () => resolved.kind === "github" && deps.sandbox.canSetEgress === true;
  // VM size: 1 vCPU, or 2 for a huge repo (resources.ts), decided before boot.
  let vmSize: SandboxSize = "small";
  const bootVms = () => {
    const bootedAt = deps.now();
    // A VM's billed time runs from its boot to the end of its kill.
    const trackKill = (p: Promise<void>) => {
      kills.push(p.then(() => void sandboxMs.push(deps.now() - bootedAt)));
    };
    const onKilled = (ok: boolean, detail: string) => check("sandbox_killed", ok, detail);
    detVm = bootDetonation(
      deps.sandbox,
      { runId, totalTimeoutMs: vmSize === "large" ? LARGE_DETONATE_MS : cfg.deadlines.detonateTotalMs, sandboxTimeoutMs: vmSize === "large" ? LARGE_SANDBOX_MS : cfg.deadlines.sandboxTimeoutMs, size: vmSize },
      { onLog: (stream, text) => bus.transcript("install", stream, text), onKilled, trackKill },
    );
    // One VM per GitHub scan on E2B: the scanners run in the detonation VM before any repo code.
    if (!oneVm()) anaVm = bootAnalysis(deps.sandbox, { runId, sandboxTimeoutMs: cfg.deadlines.sandboxTimeoutMs }, { onKilled, trackKill });
  };
  const releaseVms = async () => {
    const dv = detVm as DetonationVm | null;
    const av = anaVm as BootedSandbox | null;
    await Promise.allSettled([dv?.vm.release(), av?.release()]);
    await Promise.allSettled(kills);
  };

  const fail = async (err: unknown, stage: StageName | null): Promise<ScanOutcome> => {
    const code = codeOf(err);
    const message = errMessage(err).slice(0, 500);
    if (stage) emitStage(stage, "error", message);
    await releaseVms();
    g.release();
    if (claimed) {
      try {
        await deps.store.finishRun(runId, { status: "error", errorCode: code, timings });
      } catch (e) {
        check("persist_error_state", false, errMessage(e));
      }
    } else {
      discard = true;
    }
    await bus.close();
    return { kind: "error", runId: claimed ? runId : null, code, message };
  };

  // ---- resolve and cache --------------------------------------------------------
  // The budget check is a pure read (a zero charge) and needs no target, so it runs
  // alongside the resolve; its answer gates the VM boot below.
  const budgetP = deps.store.chargeBudget({ sandboxSeconds: 0, tokens: 0, capSeconds: cfg.dailySandboxSecondsCap, capTokens: cfg.dailyModelTokensCap });
  budgetP.catch(() => undefined);
  let resolved: Resolved;
  emitStage("resolve", "start");
  try {
    resolved = await resolveTarget(req, deps, deadline(cfg.deadlines.resolveMs, outer));
  } catch (err) {
    return fail(err, "resolve");
  }
  emitStage("resolve", "done", resolved.commitSha ? `${resolved.display} at ${resolved.commitSha.slice(0, 24)}` : resolved.display);

  let fetched: Fetched | null = null;
  if (resolved.commitSha === null) {
    // npm without a sha512 registry digest: the cache key is the sha512 of the bytes we verify.
    try {
      fetched = await fetchAndVerify(req, resolved, deps, deadline(cfg.deadlines.fetchMs, outer), emitStage);
    } catch (err) {
      return fail(err, "fetch");
    }
    resolved.commitSha = fetched.commitSha;
  }
  const commitSha = resolved.commitSha!;

  if (req.regenerate && req.caller.operator) {
    emitStage("cache", "skipped", "operator regenerate");
  } else {
    emitStage("cache", "start");
    try {
      const found = await deps.store.findCached(resolved.subject, commitSha);
      // A full-install request never gets a stored partial report: it plays back a stored full one or runs.
      const hit = found && cachedCoverageComplete(found.report) && !(req.full && found.report?.partial) ? found : null;
      if (found && !hit) emitStage("cache", "done", "miss: the stored run for this sha has incomplete coverage or older scoring rules, so it runs again");
      if (hit) {
        g.drop();
        discard = true;
        await bus.close();
        if (opts.onEvent) for (const e of hit.events) opts.onEvent({ ...e, replayed: true });
        return { kind: "cached", runId: hit.runId, report: hit.report };
      }
      if (!found) emitStage("cache", "done", "miss");
    } catch (err) {
      emitStage("cache", "error", errMessage(err));
      check("cache_lookup", false, errMessage(err));
    }
  }

  // Cache miss: boot both VMs now (when the budget allows), then claim the run while the
  // tarball downloads. No VM starts for a cache hit or over budget.
  const [budgetR, treeR] = await Promise.allSettled([
    budgetP,
    resolved.kind === "github"
      ? githubTreeSize(resolved.github!.owner, resolved.github!.repo, resolved.github!.sha, { fetch: deps.fetch, token: deps.config.githubToken, timeoutMs: 3_000, signal: outer })
      : Promise.resolve(null),
  ]);
  if (treeR.status === "fulfilled" && treeR.value) {
    vmSize = sizeForRepo(treeR.value.files, treeR.value.bytes, treeR.value.truncated);
    check("vm_size", true, `${treeR.value.files} files, ${treeR.value.bytes} bytes${treeR.value.truncated ? " (tree truncated)" : ""}: ${SANDBOX_SIZES[vmSize].cpuCount} vCPU`);
  } else if (treeR.status === "rejected") {
    check("vm_size", false, `tree size unavailable (${errMessage(treeR.reason)}); 1 vCPU`);
  }
  const underBudget = budgetR.status === "fulfilled" && budgetR.value === true;
  if (underBudget) bootVms();
  // A GitHub repo of any size is fetched and mapped inside the VMs when the provider
  // can switch egress (E2B); otherwise (test providers) the function fetches it.
  const vmCapable = oneVm() && detVm !== null;
  const fetchP: Promise<Fetched> | null = fetched
    ? null
    : vmCapable
      ? vmFetchAndMap(resolved, detVm!, emitStage, check, (tool, stream, text) => bus.transcript(tool, stream, text), VM_SCANNER_MS)
      : fetchAndVerify(req, resolved, deps, deadline(cfg.deadlines.fetchMs, outer), emitStage);
  fetchP?.catch(() => undefined);
  let claim;
  try {
    claim = await deps.store.claimRun({ runId, targetKind: resolved.kind, subject: resolved.subject, commitSha, modelId: deps.luna.modelId, template: deps.sandbox.template, userId: req.caller.userId });
  } catch (err) {
    return fail(new EngineError("internal", `could not record the run: ${errMessage(err)}`), null);
  }
  if (claim.status === "running") {
    await releaseVms();
    g.drop();
    discard = true;
    await bus.close();
    return { kind: "attached", runId: claim.runId };
  }
  claimed = true;
  g.release();

  if (budgetR.status === "rejected") {
    // Fail closed: without a working budget ledger no fresh sandbox or model spend starts.
    check("daily_budget", false, errMessage(budgetR.reason));
    return fail(new EngineError("capacity", "the scan budget ledger is unavailable; cached reports still serve, retry shortly"), null);
  }
  if (!underBudget) {
    check("daily_budget", false, "today's sandbox or model budget is spent; cached reports still serve");
    return fail(new EngineError("budget_exhausted", "the daily scan budget is spent; retry tomorrow or open a cached report"), null);
  }

  // ---- fetch, verify, reach ---------------------------------------------------------
  if (fetchP) {
    try {
      fetched = await fetchP;
    } catch (err) {
      return fail(err, stageStart.has("verify") ? "verify" : "fetch");
    }
  }
  const { archive, bytes } = fetched!;
  if (archive.rejected.length > 0) check("archive_entries_rejected", false, `${archive.rejected.length} unsafe entries dropped (${[...new Set(archive.rejected.map((r) => r.reason))].join(", ")})`);
  if (archive.truncated) check("archive_truncated", false, `archive cut at the ${archive.truncatedReason} cap`);

  emitStage("reach", "start");
  const graph = fetched!.vm ? fetched!.vm.graph : buildReachGraph(archive.files);
  const heur: HeuristicResult = fetched!.vm ? fetched!.vm.heur : runHeuristics(archive.files);
  emitStage("reach", "done", `${graph.install.size} install, ${graph.import.size} import${graph.unbounded ? ", unbounded" : ""}`);

  const meter = new CostMeter({ jevModel: deps.jev.modelId, lunaModel: deps.luna.modelId, fx: cfg.fx });
  const failedStages: string[] = [];
  const target = resolved.display;

  // ---- parallel fan-out -----------------------------------------------------------------
  emitStage("static", "start");
  const analysisP: Promise<AnalysisResult | null> = (async () => {
    try {
      const r = fetched!.vm ? fetched!.vm.analysis : await runAnalysisOn(
        anaVm!,
        { runId, files: archive.files, prefetched: Boolean(fetched!.vm), ecosystems: graph.ecosystems.length > 0 ? graph.ecosystems : ["npm"], sandboxTimeoutMs: cfg.deadlines.sandboxTimeoutMs, commandTimeoutMs: cfg.deadlines.analysisMs },
        { onLine: (tool, stream, text) => bus.transcript(tool, stream, text) },
      );
      for (const e of r.errors.slice(0, 10)) check("scanner_error", false, e);
      emitStage("static", r.complete ? "done" : "error", `${r.findings.length} scanner finding(s)${r.complete ? "" : "; coverage incomplete"}`);
      return r;
    } catch (err) {
      emitStage("static", "error", errMessage(err));
      return null;
    }
  })();

  emitStage("osv", "start");
  const lockDeps = depsFromArchive(archive.files);
  const osvP: Promise<OsvResult | null> = queryOsv(lockDeps, { fetch: deps.fetch, timeoutMs: cfg.deadlines.osvMs, signal: outer })
    .then((r) => {
      emitStage("osv", "done", `${r.queried} locked dependencies, ${r.malicious.length} malicious`);
      return r;
    })
    .catch((err: unknown) => {
      emitStage("osv", "error", errMessage(err));
      return null;
    });

  const repP: Promise<ReputationSignals> = (async () => {
    const t0 = deps.now();
    const ctx = { fetch: deps.fetch, timeoutMs: cfg.deadlines.resolveMs, token: cfg.githubToken, signal: outer };
    let rep: ReputationSignals;
    if (resolved.kind === "github") {
      const owner = await fetchGithubOwner(resolved.ownerLogin, ctx, deps.store.ownerCache);
      rep = computeReputation({ owner, ownerLookedUp: true, repoStars: resolved.github!.info.stars }, deps.now());
    } else if (resolved.kind === "npm") {
      const weekly = await fetchWeeklyDownloads(resolved.npm!.name, ctx);
      rep = computeReputation({ ownerLookedUp: false, npm: resolved.npm!, weeklyDownloads: weekly }, deps.now());
    } else {
      rep = computeReputation({ ownerLookedUp: false }, deps.now());
    }
    timings.reputation = Math.round(deps.now() - t0);
    return rep;
  })();

  // Jev checks: independent, so the install and docs checks start now and the
  // flagged check starts as soon as the scanner findings exist. Each failure
  // lowers coverage (score capped, not_verified line, no SHA cache); none is
  // retried with another credential.
  emitStage("checks", "start");
  const checkSignal = () => deadline(cfg.deadlines.checkMs, outer);
  let checksOk = true;
  const capabilitiesTagged = heur.capabilities.map((c) => ({ ...c, reach: graph.classify(c.file) }));
  const installCheckP = runInstallCheck(deps.jev, target, buildInstallSlice(archive.files, graph), graph.inlineInstallCommands.length > 0, checkSignal())
    .then((r) => {
      meter.recordJev("check.install", r.usage);
      bus.transcript("jev.install", "model", r.summary);
      return r;
    })
    .catch((err: unknown) => {
      checksOk = false;
      check("jev_install", false, errMessage(err));
      return null;
    });
  const docsCheckP = runDocsCheck(deps.jev, target, buildDocsSlice(archive.files, graph, heur.capabilities), archive.files, capabilitiesTagged, checkSignal())
    .then((r) => {
      meter.recordJev("check.docs", r.usage);
      bus.transcript("jev.docs", "model", r.summary);
      return r;
    })
    .catch((err: unknown) => {
      checksOk = false;
      check("jev_docs", false, errMessage(err));
      return null;
    });
  const flaggedCheckP = analysisP.then(async (analysis) => {
    const all = tag([...heur.findings, ...(analysis?.findings ?? [])], graph);
    const slice = buildFlaggedSlice(all, archive.files);
    if (slice.blocks.length === 0) return { findings: [] as CheckFinding[], answers: [] as CheckAnswerRecord[] };
    try {
      const r = await runFlaggedCheck(deps.jev, target, slice, checkSignal());
      meter.recordJev("check.flagged", r.usage);
      bus.transcript("jev.flagged", "model", r.summary);
      return { findings: r.findings, answers: r.answers };
    } catch (err) {
      checksOk = false;
      check("jev_flagged", false, errMessage(err));
      return null;
    }
  });

  emitStage("detonate", "start");
  const canaries: Canaries = makeCanaries(deps.random);
  // The install plan from registry metadata only (no package code), before the sandbox.
  const planP = resolved.kind === "github" ? planInstall(archive.files, (u, i) => deps.fetch(u, i), outer).catch(() => null) : Promise.resolve(null);
  const detonateP: Promise<DetonationResult | SandboxCreateError | Error> = (async () => {
    try {
      const plan = await planP;
      if (plan) check("install_plan", true, `${plan.source}: ${plan.devScripts.length} of ${plan.devTotal} dev packages have an install script`);
      const ws = resolved.kind === "github" ? (graph.workspace ?? null) : null;
      if (ws) check("workspace_plan", true, `installing the root and ${ws.selected.length} of ${ws.total} workspace packages`);
      return await runDetonation(detVm!, {
        plan,
        workspace: ws,
        runId,
        mode: resolved.kind === "npm" ? "npm-package" : "repo",
        packageName: resolved.kind === "npm" ? resolved.npm!.name : null,
        tarball: bytes,
        prefetched: Boolean(fetched!.vm),
        canaries,
        installTimeoutMs: vmSize === "large" ? Math.max(LARGE_INSTALL_MS, cfg.deadlines.installMs) : cfg.deadlines.installMs,
        entryTimeoutMs: cfg.deadlines.entryMs,
        totalTimeoutMs: vmSize === "large" ? LARGE_DETONATE_MS : cfg.deadlines.detonateTotalMs,
        sandboxTimeoutMs: vmSize === "large" ? LARGE_SANDBOX_MS : cfg.deadlines.sandboxTimeoutMs,
        fakeRate: FAKE_CLOCK_RATE,
      });
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  })();

  const [analysis, osv, rep, installCheck, docsCheck, flagged, det] = await Promise.all([analysisP, osvP, repP, installCheckP, docsCheckP, flaggedCheckP, detonateP]);
  emitStage("checks", checksOk ? "done" : "error");

  if (det instanceof SandboxCreateError) {
    return fail(new EngineError("capacity", "no sandbox capacity to run this scan; retry shortly"), "detonate");
  }
  let detonation: DetonationResult | null = null;
  if (det instanceof Error) {
    emitStage("detonate", "error", errMessage(det));
    failedStages.push("The detonation sandbox stopped before the run finished.");
  } else {
    detonation = det;
    // Evidence first: forged calls (canary hits leading), then files, then checks,
    // then processes, so the per-run event cap can only ever cut process noise.
    const calls = [...det.forgedCalls].sort((a, b) => b.canary_hits.length - a.canary_hits.length);
    for (const c of calls) bus.emit({ type: "forged_call", data: c });
    for (const f of det.files) bus.emit({ type: "file", data: f });
    for (const c of det.checks) check(c.name, c.ok, c.detail);
    for (const m of det.integrityMismatches) check("mirror_integrity_mismatch", false, `${m.host}${m.path ?? ""}`);
    for (const m of det.mirrorMetadata.slice(0, 20)) check("mirror_metadata_served", false, `${m.host}${m.path ?? ""} answered from mirror metadata; upstream did not answer`);
    if (det.forensics.coverage !== "complete") check("forensic_coverage", false, `${det.forensics.coverage}: ${det.forensics.gaps.join(" ").slice(0, 400)}`);
    for (const p of det.processes) bus.emit({ type: "process", data: p });
    if (det.stats.pthFiles.length > 0) check("pth_files_installed", true, det.stats.pthFiles.join(", ").slice(0, 400));
    // What of the dev tree ran, stated plainly on the report.
    const devScope = det.checks.find((c) => c.name === "dev_scope");
    if (devScope) failedStages.push(`Dev dependencies: ${devScope.detail}.`);
    for (const u of det.unattributedDrops ?? []) {
      check("fence_drop_unattributed", true, u);
      failedStages.push(`The fence dropped datagrams that no traced process sent (${u}); they are not counted as repo behaviour.`);
    }
    bus.transcript("install", "stdout", det.transcripts.install.stdout);
    bus.transcript("install", "stderr", det.transcripts.install.stderr);
    bus.transcript("entry", "stdout", det.transcripts.entry.stdout);
    bus.transcript("entry", "stderr", det.transcripts.entry.stderr);
    Object.assign(timings, det.timings);
    emitStage("detonate", "done", `install ${det.install}, entry ${det.entry}, ${det.forgedCalls.length} forged call(s)`);
  }

  // ---- OSV pass 2 on the installed tree ------------------------------------------------------
  let malicious: MaliciousDependency[] = osv?.malicious ?? [];
  let osvOk = osv !== null;
  const installed: DependencyRef[] = detonation?.installedDeps ?? [];
  const queried = new Set(lockDeps.map((d) => `${d.ecosystem}:${d.name}@${d.version}`));
  const fresh = installed.filter((d) => !queried.has(`${d.ecosystem}:${d.name}@${d.version}`));
  let osv2: OsvResult | null = null;
  if (fresh.length > 0) {
    try {
      osv2 = await queryOsv(fresh, { fetch: deps.fetch, timeoutMs: cfg.deadlines.osvMs, signal: outer });
      malicious = mergeMalicious(malicious, osv2.malicious);
      check("osv_installed_tree", true, `${osv2.queried} installed dependencies, ${osv2.malicious.length} malicious`);
    } catch (err) {
      osvOk = false;
      check("osv_installed_tree", false, errMessage(err));
    }
  }

  malicious = await scopeMalicious(malicious, archive.files, installed, (u, i) => deps.fetch(u, i));
  // Platform-only dev packages the plan did not run: stated, and still checked against OSV.
  for (const s of (await planP)?.platformSkipped ?? []) {
    const flagged = malicious.some((m) => m.name === s.name && m.version === s.version);
    failedStages.push(`${s.name} ${s.version}: ${s.label}, ${flagged ? "flagged from its malware record, " : ""}not run in this sandbox.`);
  }

  // ---- score ---------------------------------------------------------------------------------------
  emitStage("score", "start");
  // A capability pattern that matches what the project says it does (the Jev docs check
  // judged documentation and measured capabilities consistent, p >= 0.8) is not a deduction.
  const fit = (docsCheck?.answers ?? []).find((a) => a.question === "capability_fit");
  const docsConsistent = fit?.answer === "consistent" && (fit.probability ?? 0) >= 0.8;
  const CAPABILITY_RULE = /^heur\.(?:network|process|shell_fetch|fs)\./;
  const allStatic = tag([...heur.findings, ...(analysis?.findings ?? [])], graph);
  const documented = docsConsistent ? allStatic.filter((f) => CAPABILITY_RULE.test(f.rule)) : [];
  const staticFindings = documented.length > 0 ? allStatic.filter((f) => !documented.includes(f)) : allStatic;
  if (documented.length > 0) failedStages.push(`${documented.length} capability pattern hit(s) match the documented purpose (Jev docs check: consistent, p=${(fit!.probability ?? 0).toFixed(2)}) and are not deducted.`);
  const checkFindings = tagChecks([...(installCheck?.findings ?? []), ...(flagged?.findings ?? []), ...(docsCheck?.findings ?? [])], graph);
  const checkAnswers: CheckAnswerRecord[] = [...(installCheck?.answers ?? []), ...(flagged?.answers ?? []), ...(docsCheck?.answers ?? [])];
  const behaviour = deriveBehaviour({
    forgedCalls: detonation?.forgedCalls ?? [],
    files: detonation?.files ?? [],
    processes: detonation?.processes ?? [],
    canaryInFiles: detonation?.canaryInFiles ?? [],
    datagramEgress: detonation?.datagramEgress ?? [],
  });
  const docsClaims: DocsClaims | null = docsCheck?.claims ?? null;
  if (analysis === null) failedStages.push("The static scanner sandbox did not complete.");
  const result: ScoreResult = computeScore({
    behaviour,
    install: detonation?.install ?? "failed",
    entry: detonation?.entry ?? "skipped",
    archiveTruncated: archive.truncated,
    forensics: detonation?.forensics ?? { coverage: "lost", gaps: [] },
    coverage: { scanners: analysis?.complete ?? false, osv: osvOk, checks: checksOk },
    malicious,
    staticFindings,
    checkFindings,
    docs: docsClaims,
    capabilities: capabilitiesTagged,
    reputation: rep,
    failedStages,
  });
  emitStage("score", "done", `${result.score} ${result.verdict}`);

  // ---- report ----------------------------------------------------------------------------------------
  emitStage("report", "start");
  const written = await writeReport(
    deps.luna,
    {
      target,
      score: result.score,
      verdict: result.verdict,
      breakdown: result.breakdown,
      notVerified: result.notVerified,
      checkAnswers,
      sandbox: sandboxObservation(detonation),
      statedPurpose: statedPurpose(archive.files),
    },
    deadline(cfg.deadlines.writerMs, outer),
  );
  if (written.calls > 0) meter.recordLuna("report", written.usage);
  bus.transcript("luna.report", "model", `${written.headline}\n${written.summary}\n${written.report.what_ran}\n${written.report.what_matters}`);
  if (written.writer === "deterministic") check("writer_fallback", false, [...written.errors, ...written.rejections.map((r) => r.join("; "))].join(" | ").slice(0, 400) || "model output rejected");
  emitStage("report", "done", written.writer);

  const evidence = {
    behaviour: result.breakdown.filter((d) => d.group === "behaviour").flatMap((d) => [d.detail, ...(d.evidence ?? [])]).slice(0, 40),
    code: result.breakdown.filter((d) => d.group === "static" || d.group === "intel" || d.group === "docs").flatMap((d) => [d.detail, ...(d.evidence ?? [])]).slice(0, 40),
    reputation: [...rep.evidence, ...result.breakdown.filter((d) => d.group === "reputation").map((d) => d.detail)].slice(0, 20),
  };
  if (evidence.behaviour.length === 0) {
    const seen = sandboxObservation(detonation);
    if (seen === "observed") {
      evidence.behaviour.push(`Install ${detonation!.install} and entry ${detonation!.entry} in the sandbox; the forge answered ${detonation!.forgedCalls.length} call(s) and none reached a non-registry host.`);
    } else if (seen === "partial") {
      evidence.behaviour.push(`Install ${detonation!.install} and entry ${detonation!.entry} in the sandbox; in the recorded part of the run none of the forge's ${detonation!.forgedCalls.length} call(s) reached a non-registry host, and part of the record was cut.`);
    } else {
      evidence.behaviour.push("The sandbox run did not produce a complete forensic record; install-time and runtime behaviour were not observed.");
    }
  }
  const failedCoverage: string[] = [];
  if (!detonation) failedCoverage.push("detonation");
  else if (detonation.forensics.coverage !== "complete") failedCoverage.push(`forensics_${detonation.forensics.coverage}`);
  if (!(analysis?.complete ?? false)) failedCoverage.push("scanners");
  if (!osvOk) failedCoverage.push("osv");
  if (!checksOk) failedCoverage.push("checks");
  if (written.writer !== "model") failedCoverage.push("writer");
  const timedOut: string[] = [];
  if (detonation?.install === "timeout") timedOut.push("install");
  if (detonation?.entry === "timeout") timedOut.push("entry");
  const coverage: RunCoverage = { complete: failedCoverage.length === 0, failed: failedCoverage, timed_out: timedOut };
  // Both kills were issued when each VM's work ended; they finished during the
  // score and the report. Awaiting them here prices the real VM lifetimes.
  await Promise.allSettled(kills);
  timings.total = Math.round(deps.now() - startedAt);
  const sandboxSeconds = sandboxMs.reduce((s, x) => s + x, 0) / 1000;
  const cost: CostLedger = meter.ledger(sandboxSeconds, SANDBOX_SIZES[vmSize].cpuCount);
  const ran = buildRanSummary({ detonation, plan: await planP, files: archive.files });
  const report: ReportPayload = {
    run_id: runId,
    target,
    commit_sha: commitSha,
    score: result.score,
    verdict: result.verdict,
    band: result.band,
    summary: written.summary,
    luna_report: written.report,
    ...(result.partial ? { partial: true } : {}),
    ...(ran ? { ran } : {}),
    // A dependency danger with clean own code says so plainly, whatever the writer wrote.
    headline: result.label ? `${result.verdict}: ${result.label}` : written.headline,
    ...(result.label ? { label: result.label } : {}),
    reputation_section: reputationSection(rep, resolved),
    evidence,
    breakdown: result.breakdown,
    not_verified: result.notVerified,
    forensics: {
      version: 2,
      coverage,
      forensic_coverage: detonation?.forensics ?? { coverage: "lost", gaps: [] },
      install: detonation?.install ?? "failed",
      entry: detonation?.entry ?? "skipped",
      ecosystem: detonation?.ecosystem ?? "none",
      install_command: detonation?.installCommand ?? "",
      forged_calls: detonation?.forgedCalls ?? [],
      files: detonation?.files ?? [],
      processes: (detonation?.processes ?? []).slice(0, 100),
      canary_in_files: detonation?.canaryInFiles ?? [],
      datagram_egress: detonation?.datagramEgress ?? [],
      checks: detonation?.checks ?? [],
      stats: detonation?.stats ?? null,
      sandbox_id: detonation?.sandboxId ?? null,
      analysis_sandbox_id: analysis?.sandboxId ?? null,
      scanners: analysis?.tools ?? {},
      reach: { install: graph.install.size, import: graph.import.size, unbounded: graph.unbounded, entries: graph.entries.slice(0, 50) },
      archive: { files: archive.files.size, truncated: archive.truncated, rejected: archive.rejected.length },
    },
    packages: {
      locked: lockDeps.length,
      installed: installed.slice(0, 500),
      malicious,
      advisories: [...(osv?.advisories ?? []), ...(osv2?.advisories ?? [])].slice(0, 200),
    },
    model_id: deps.luna.modelId,
    jev_model_id: deps.jev.modelId,
    score_rules: SCORE_RULES,
    template: deps.sandbox.template,
    timings,
    writer: written.writer,
    cost,
  };

  // ---- persist ----------------------------------------------------------------------------------------
  const finish = async (): Promise<void> => {
    emitStage("persist", "start");
    const save = (async () => {
      try {
        await deps.store.saveReport({
          runId,
          targetKind: resolved.kind,
          subject: resolved.subject,
          ownerLogin: resolved.ownerLogin,
          repoName: resolved.repoName,
          commitSha,
          report,
          packages: report.packages,
          risky: [...staticFindings.filter((f) => f.reach !== "unreachable").slice(0, 100), ...checkFindings.slice(0, 36)],
          logs: Object.entries(timings).map(([name, ms]) => ({ name, ms })),
          stats: { files: archive.files.size, forged_calls: detonation?.forgedCalls.length ?? 0, processes: detonation?.processes.length ?? 0 },
        });
        emitStage("persist", "done");
        try {
          opts.onPersisted?.({ ownerLogin: resolved.ownerLogin, repoName: resolved.repoName, kind: resolved.kind });
        } catch (err) {
          console.error("onPersisted failed:", errMessage(err).slice(0, 200));
        }
      } catch (err) {
        emitStage("persist", "error", errMessage(err));
      }
    })();
    const charge = (async () => {
      try {
        await deps.store.chargeBudget({ sandboxSeconds: Math.ceil(sandboxSeconds), tokens: meter.totalTokens(), capSeconds: cfg.dailySandboxSecondsCap, capTokens: cfg.dailyModelTokensCap });
      } catch (err) {
        check("budget_charge", false, errMessage(err));
      }
    })();
    await Promise.all([save, charge]);
    await bus.close();
    try {
      await deps.store.finishRun(runId, { status: "done", timings, cost });
    } catch (err) {
      // The report row is already written; a stale running row expires (expire_stale_runs).
      void err;
    }
  };
  if (opts.background) {
    // The caller already has the report; this keeps running until the rows are written.
    opts.background(finish().catch((err: unknown) => console.error("scan finish failed:", errMessage(err).slice(0, 300))));
  } else {
    await finish();
  }
  return { kind: "fresh", runId, report };
}
