/**
 * Drive one detonation (DESIGN.md section 3): a fresh VM from the template,
 * cr-detonate.sh run as root, the verified tarball and per-run canaries written
 * as root, the forensic bundle read back, and the VM killed in `finally`.
 * Parsing happens here, in the function, never in the VM.
 *
 * Two steps, so the slow part of the harness overlaps the rest of the scan:
 * `bootDetonation` creates the VM and starts cr-detonate.sh at once. The harness
 * builds the per-VM CA, loads the inner fence, starts the forge and runs the
 * containment probe while the function is still resolving and fetching the
 * target; then it waits for /root/in/go. `runDetonation` writes the tarball,
 * run.json and the canaries, then the go file, and the harness continues with
 * the decoys, extraction, install and entry as uid 1001 under strace and the
 * fake clock. No repo byte reaches the VM before the probe has proven the forge
 * and the fence, and the probe still gates every line of repo code.
 */

import { parseTarball, textOf } from "../archive";
import { canaryEnvFile, canaryMatcher, canaryPatternsFile, parseCapture, summarizeCapture, type Canaries } from "../forensics/capture";
import { parseStrace } from "../forensics/strace";
import type { ForensicCoverage, PhaseOutcome } from "../score";
import { depsFromNpmLs, depsFromUvPipList } from "../static/osv";
import type { CheckEventData, DependencyRef, FileEventData, ForgedCallData, ProcessEventData } from "../types";
import { SALVAGE_BUDGET_MS } from "../config";
import { bootSandbox, runOnBooted, type BootedSandbox, type CommandResult, type KillHooks, type SandboxProvider } from "./provider";

export const DETONATE_SCRIPT = "/opt/cr/bin/cr-detonate.sh";
/** The harness command, started as root the moment the VM exists. */
export const HARNESS_COMMAND = `bash ${DETONATE_SCRIPT}`;
/** Written last, after every per-run input: the harness waits for it before any repo step. */
export const GO_FILE = "/root/in/go";
export const OUT_ARCHIVE = "/root/out.tgz";
/** Exit code cr-detonate.sh uses when the containment probe fails (no repo code ran). */
export const EXIT_NOT_CONTAINED = 4;
/** Partial bundle packed by SALVAGE_COMMAND when the harness never wrote OUT_ARCHIVE. */
export const SALVAGE_ARCHIVE = "/root/out.partial.tgz";
/** Wall-clock budget for the salvage command. */
export const SALVAGE_MS = SALVAGE_BUDGET_MS;
/**
 * Run as root when /root/out.tgz is missing (harness overran, crashed or exited
 * early): stop the harness and every uid 1001 process, cap the live forensic
 * files, and pack whatever /root/out holds. The bracket in the pattern keeps
 * pkill from matching this command's own shell.
 */
export const SALVAGE_COMMAND = [
  "pkill -KILL -f 'cr-detonat[e].sh'",
  "pkill -KILL -u 1001",
  "for f in /root/out/capture.jsonl /root/out/trace.install /root/out/trace.entry; do [ -f \"$f\" ] && truncate -s '<8M' \"$f\"; done",
  `timeout 5 tar -czf ${SALVAGE_ARCHIVE} -C /root out`,
].join("; ");

export interface DetonationInput {
  runId: string;
  /** `npm-package`: install the tarball as a dependency. `repo`: extract and install the tree. */
  mode: "npm-package" | "repo";
  packageName: string | null;
  tarball: Uint8Array;
  /** The whole repo was fetched into this VM by vmfetch.ts; `tarball` is not uploaded. */
  prefetched?: boolean;
  /** The server's install plan (lib/engine/plan.ts): dev packages with an install script. */
  plan?: import("../plan").InstallPlan | null;
  /** Install only what runs: the workspace plan (lib/engine/reach/graph.ts planWorkspace). */
  workspace?: import("../reach/graph").WorkspacePlan | null;
  canaries: Canaries;
  installTimeoutMs: number;
  entryTimeoutMs: number;
  totalTimeoutMs: number;
  sandboxTimeoutMs: number;
  fakeRate: number;
}

export interface DetonationHooks extends KillHooks {
  onLog?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface DetonationResult {
  sandboxId: string;
  harnessExit: number;
  install: PhaseOutcome;
  entry: PhaseOutcome;
  /** The entry command's exit code from the harness result; null when entry did not run or was not recorded. */
  entryExitCode?: number | null;
  ecosystem: "npm" | "python" | "none";
  installCommand: string;
  forgedCalls: ForgedCallData[];
  files: FileEventData[];
  processes: ProcessEventData[];
  canaryInFiles: string[];
  /** Non-DNS UDP and ICMP egress attempts the fence dropped. */
  datagramEgress: string[];
  /** UDP drops the fence counted that no traced process sent: stated, not attributed to the repo. */
  unattributedDrops: string[];
  checks: CheckEventData[];
  installedDeps: DependencyRef[] | null;
  transcripts: { install: { stdout: string; stderr: string }; entry: { stdout: string; stderr: string } };
  timings: Record<string, number>;
  integrityMismatches: Array<{ host: string; path: string | null }>;
  /** Registry metadata the forge served from the seeded mirror because upstream did not answer. */
  mirrorMetadata: Array<{ host: string; path: string | null }>;
  /** How much of the forensic record reached the scorer, and why any part is missing. */
  forensics: { coverage: ForensicCoverage; gaps: string[] };
  stats: { captureRecords: number; captureInvalid: number; harnessRecords: number; traceLines: number; traceUnparsed: number; dropped: number; writtenFiles: number; pthFiles: string[] };
}

interface HarnessResult {
  ecosystem?: string;
  deps_kind?: string;
  install?: { status?: string; exit_code?: number | null; ms?: number; command?: string };
  entry?: { status?: string; exit_code?: number | null; ms?: number };
  clock?: { real_ms?: number; fake_ms?: number };
  total_ms?: number;
  /** Milliseconds from harness start: forge up, probe done, inputs arrived, install start, collect start. */
  phases?: { ca_ms?: number; fence_ms?: number; forge_ms?: number; probe_ms?: number; contained_ms?: number; inputs_ms?: number; install_start_ms?: number; collect_start_ms?: number };
}

function outcome(v: string | undefined): PhaseOutcome {
  return v === "completed" || v === "failed" || v === "timeout" || v === "skipped" ? v : "failed";
}

function lines(text: string | null): string[] {
  return (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Parse the harness's /root/out bundle (exported for tests and the mock sandbox). */
export async function parseForensicBundle(
  bytes: Uint8Array,
  canaries: Canaries,
): Promise<Omit<DetonationResult, "sandboxId" | "harnessExit">> {
  const archive = await parseTarball(bytes, { maxCompressedBytes: 25 * 1024 * 1024, maxExpandedBytes: 120 * 1024 * 1024, maxFiles: 200 });
  const f = (name: string) => textOf(archive.files.get(name));
  let result: HarnessResult = {};
  const rtext = f("result.json");
  if (rtext) {
    try {
      result = JSON.parse(rtext) as HarnessResult;
    } catch {
      result = {};
    }
  }
  const checks: CheckEventData[] = [];
  for (const l of lines(f("checks.jsonl"))) {
    try {
      const c = JSON.parse(l) as { name?: unknown; ok?: unknown; detail?: unknown };
      if (typeof c.name === "string" && typeof c.ok === "boolean") {
        checks.push({ name: c.name, ok: c.ok, ...(typeof c.detail === "string" ? { detail: c.detail.slice(0, 500) } : {}) });
      }
    } catch {
      // A malformed check line is skipped; the result.json phases still stand.
    }
  }
  const matcher = canaryMatcher(canaries);
  const cap = parseCapture(f("capture.jsonl") ?? "");
  const summary = summarizeCapture(cap.records, matcher);
  const initialCwd = result.ecosystem === "npm" && (result.install?.command ?? "").includes("/work/pkg.tgz") ? "/work/app" : "/work/src";
  const ti = parseStrace(f("trace.install") ?? "", { phase: "install", initialCwd });
  const te = parseStrace(f("trace.entry") ?? "", { phase: "entry", initialCwd });
  let installedDeps: DependencyRef[] | null = null;
  const deps = f("deps.json");
  if (deps && deps.trim()) {
    try {
      installedDeps = result.deps_kind === "uv-pip-list" ? depsFromUvPipList(deps) : depsFromNpmLs(deps);
    } catch {
      installedDeps = null;
    }
  }
  const timings: Record<string, number> = {};
  if (typeof result.install?.ms === "number") timings["detonate.install"] = result.install.ms;
  if (typeof result.entry?.ms === "number") timings["detonate.entry"] = result.entry.ms;
  if (typeof result.total_ms === "number") timings["detonate.harness"] = result.total_ms;
  if (typeof result.clock?.real_ms === "number") timings["detonate.clock_real"] = result.clock.real_ms;
  if (typeof result.clock?.fake_ms === "number") timings["detonate.clock_fake"] = result.clock.fake_ms;
  const ph = result.phases ?? {};
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (num(ph.contained_ms)) timings["detonate.prepare"] = ph.contained_ms;
  // Prepare split: CA, fence, forge start, probes (each from the previous mark).
  if (num(ph.ca_ms)) timings["detonate.prepare.ca"] = ph.ca_ms;
  if (num(ph.ca_ms) && num(ph.fence_ms)) timings["detonate.prepare.fence"] = Math.max(0, ph.fence_ms - ph.ca_ms);
  if (num(ph.fence_ms) && num(ph.forge_ms)) timings["detonate.prepare.forge"] = Math.max(0, ph.forge_ms - ph.fence_ms);
  if (num(ph.forge_ms) && num(ph.probe_ms)) timings["detonate.prepare.probe"] = Math.max(0, ph.probe_ms - ph.forge_ms);
  if (num(ph.contained_ms) && num(ph.inputs_ms)) timings["detonate.wait"] = Math.max(0, ph.inputs_ms - ph.contained_ms);
  if (num(ph.collect_start_ms) && num(result.total_ms)) timings["detonate.collect"] = Math.max(0, result.total_ms - ph.collect_start_ms);
  const eco = result.ecosystem === "npm" || result.ecosystem === "python" ? result.ecosystem : "none";
  const datagramEgress = [...new Set([...ti.datagrams, ...te.datagrams])].sort();
  let drops: { udp?: unknown; icmp?: unknown; other?: unknown } = {};
  try {
    drops = JSON.parse(f("egress_drops.json") ?? "{}") as typeof drops;
  } catch {
    drops = {};
  }
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
  // A UDP drop counts as repo behaviour when the trace shows the repo process that sent
  // it (it is then in datagramEgress with its destination). A counter rise that no traced
  // process explains is stated as not verified instead of taking points off.
  const unattributedDrops: string[] = [];
  if (count(drops.udp) > 0 && !datagramEgress.some((d) => d.startsWith("udp "))) unattributedDrops.push(`udp: ${count(drops.udp)} packet(s) dropped by the fence`);
  if (count(drops.icmp) > 0) datagramEgress.push(`icmp: ${count(drops.icmp)} packet(s) dropped by the fence`);
  if (count(drops.other) > 0) datagramEgress.push(`non-tcp: ${count(drops.other)} packet(s) dropped by the fence`);
  const gaps: string[] = [];
  let coverage: ForensicCoverage = "complete";
  if (!rtext) {
    coverage = "lost";
    gaps.push("The harness did not write its result record, so the phase outcomes were not observed.");
  }
  for (const c of checks) {
    if (c.ok) continue;
    if (c.name === "root_script") {
      // The dependencies and their scripts ran and are scored; only the repo's own
      // lifecycle script failed, so coverage is not reduced.
      gaps.push(`The repo's own install script failed after its dependencies installed (${c.detail ?? "unspecified"}); what ran before it was observed and scored.`);
      continue;
    }
    if (c.name === "forensics_truncated") gaps.push(`Forensic files were cut at the size cap (${c.detail ?? "unspecified"}), so records past the cut were not observed.`);
    else if (c.name === "canary_file_scan") gaps.push(`The canary search of written files did not finish (${c.detail ?? "unspecified"}).`);
    else if (c.name === "forensics_collected") gaps.push(`The forensic bundle was incomplete (${c.detail ?? "unspecified"}).`);
    else if (c.name === "extract_complete") gaps.push(`The repository was not fully extracted in the sandbox (${c.detail ?? "unspecified"}).`);
    else continue;
    if (coverage === "complete") coverage = "partial";
  }
  if (summary.mirrorMetadata.length > 0) {
    gaps.push(`${summary.mirrorMetadata.length} registry request(s) were answered from mirror metadata because the upstream registry did not answer, so those files were checked only against the mirror.`);
    if (coverage === "complete") coverage = "partial";
  }
  if (cap.invalid > 0 && coverage === "complete") {
    coverage = "partial";
    gaps.push(`${cap.invalid} forge capture record(s) were unreadable.`);
  }
  return {
    install: rtext ? outcome(result.install?.status) : "failed",
    entry: rtext ? outcome(result.entry?.status) : "skipped",
    entryExitCode: rtext && typeof result.entry?.exit_code === "number" && Number.isSafeInteger(result.entry.exit_code) ? result.entry.exit_code : null,
    ecosystem: eco,
    installCommand: result.install?.command ?? "",
    forgedCalls: summary.forgedCalls,
    files: [...ti.files, ...te.files],
    processes: [...ti.processes, ...te.processes],
    canaryInFiles: lines(f("canary_files.txt")).slice(0, 100),
    datagramEgress,
    unattributedDrops,
    checks,
    installedDeps,
    transcripts: {
      install: { stdout: f("install.out") ?? "", stderr: f("install.err") ?? "" },
      entry: { stdout: f("entry.out") ?? "", stderr: f("entry.err") ?? "" },
    },
    timings,
    integrityMismatches: summary.integrityMismatches,
    mirrorMetadata: summary.mirrorMetadata,
    forensics: { coverage, gaps },
    stats: {
      captureRecords: cap.records.length,
      captureInvalid: cap.invalid,
      harnessRecords: summary.harnessRecords,
      traceLines: ti.stats.lines + te.stats.lines,
      traceUnparsed: ti.stats.unparsed + te.stats.unparsed,
      dropped: summary.droppedForgedCalls + ti.stats.droppedFiles + ti.stats.droppedProcesses + te.stats.droppedFiles + te.stats.droppedProcesses,
      writtenFiles: lines(f("written.txt")).length,
      pthFiles: lines(f("pth.txt")).slice(0, 50),
    },
  };
}

/** A detonation VM booted ahead of its inputs, with the harness already running. */
export interface DetonationVm {
  vm: BootedSandbox;
  /** The harness command's outcome: its result, or a deadline / lost VM. */
  harness: Promise<{ run: CommandResult; timedOut: boolean }>;
  /** Wall clock (Date.now) when the boot started. */
  bootedAt: number;
}

export interface DetonationBoot {
  runId: string;
  totalTimeoutMs: number;
  sandboxTimeoutMs: number;
  /** VM size for this scan (small unless the repo is huge). */
  size?: import("./resources").SandboxSize;
}

/**
 * Create the detonation VM (outer fence: registries only) and start the harness
 * at once. The harness command deadline counts from here, so it covers the
 * wait for inputs too (the harness gives up on its own after GO_WAIT_S).
 */
export function bootDetonation(provider: SandboxProvider, boot: DetonationBoot, hooks: DetonationHooks = {}): DetonationVm {
  const bootedAt = Date.now();
  const vm = bootSandbox(provider, { purpose: "detonate", runId: boot.runId, timeoutMs: boot.sandboxTimeoutMs, network: "registry-only", ...(boot.size ? { size: boot.size } : {}) }, hooks);
  const harness = vm.session().then(async (s) => {
    try {
      const run = await s.run(HARNESS_COMMAND, {
        timeoutMs: boot.totalTimeoutMs,
        onStdout: (t) => hooks.onLog?.("stdout", t),
        onStderr: (t) => hooks.onLog?.("stderr", t),
      });
      return { run, timedOut: false };
    } catch (err) {
      // The command deadline passed or the VM stopped answering. The forge and
      // strace write /root/out live, so the salvage step packs what exists.
      return { run: { exitCode: 124, stdout: "", stderr: (err as Error).message ?? String(err) }, timedOut: true };
    }
  });
  harness.catch(() => undefined);
  return { vm, harness, bootedAt };
}

export async function detonate(provider: SandboxProvider, input: DetonationInput, hooks: DetonationHooks = {}): Promise<DetonationResult> {
  return runDetonation(bootDetonation(provider, input, hooks), input);
}

/**
 * Hand the booted VM its inputs, wait for the harness, read the bundle back.
 * The VM is released (killed) in `finally`.
 */
export async function runDetonation(dvm: DetonationVm, input: DetonationInput): Promise<DetonationResult> {
  return runOnBooted(dvm.vm, async (s) => {
    const t0 = Date.now();
    await Promise.all([
      // A VM-fetched repo is already at /root/in/target.tgz (whole repo, vmfetch.ts).
      ...(input.prefetched ? [] : [s.writeFile("/root/in/target.tgz", input.tarball)]),
      s.writeFile(
        "/root/in/run.json",
        JSON.stringify({
          mode: input.mode,
          name: input.packageName,
          install_timeout_s: Math.max(1, Math.round(input.installTimeoutMs / 1000)),
          entry_timeout_s: Math.max(1, Math.round(input.entryTimeoutMs / 1000)),
          fake_rate: input.fakeRate,
          ...(input.plan ? { dev_scripts: input.plan.devScripts, dev_total: input.plan.devTotal, plan_source: input.plan.source } : {}),
          ...(input.workspace ? { ws_root: input.workspace.root, ws_selected: input.workspace.selected, ws_total: input.workspace.total } : {}),
        }),
      ),
      s.writeFile("/root/.cr/canary.env", canaryEnvFile(input.canaries)),
      s.writeFile("/root/.cr/canary-patterns.txt", canaryPatternsFile(input.canaries)),
    ]);
    // Only after every input is in place.
    await s.writeFile(GO_FILE, "go\n");
    const upload = Date.now() - t0;
    const { run, timedOut } = await dvm.harness;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await s.readFile(OUT_ARCHIVE);
    } catch {
      bytes = null;
    }
    let salvaged = false;
    if (!bytes) {
      try {
        await s.run(SALVAGE_COMMAND, { timeoutMs: SALVAGE_MS });
        bytes = await s.readFile(SALVAGE_ARCHIVE);
        salvaged = true;
      } catch {
        bytes = null;
      }
    }
    let base: Omit<DetonationResult, "sandboxId" | "harnessExit"> | null = null;
    if (bytes) {
      try {
        base = await parseForensicBundle(bytes, input.canaries);
      } catch {
        base = null;
      }
    }
    const checks = base?.checks ?? [];
    const why = timedOut
      ? `harness passed the ${input.totalTimeoutMs} ms deadline`
      : run.exitCode === EXIT_NOT_CONTAINED
        ? "containment probe failed, so no repo code ran"
        : `harness exited ${run.exitCode} without a forensic bundle`;
    const complete = Boolean(base) && !salvaged;
    if (!complete) {
      checks.push({ name: "forensics_collected", ok: false, detail: salvaged ? `${why}; partial record salvaged from the live forensic files` : why });
    }
    if (run.exitCode === EXIT_NOT_CONTAINED && !checks.some((c) => c.name === "egress_contained")) {
      checks.push({ name: "egress_contained", ok: false, detail: "containment probe failed; no repo code ran" });
    }
    // Without the harness's own bundle the phase outcomes come from how the run ended,
    // and behaviour counts as not observed even when a salvaged record shows some of it.
    const install: PhaseOutcome = complete ? base!.install : timedOut ? "timeout" : run.exitCode === EXIT_NOT_CONTAINED ? "skipped" : "failed";
    const entry: PhaseOutcome = complete ? base!.entry : "skipped";
    const forensics: DetonationResult["forensics"] = complete
      ? base!.forensics
      : { coverage: "lost", gaps: [`The sandbox run did not finish its forensic record (${why}).`, ...(base?.forensics.gaps ?? [])] };
    const empty = { stdout: "", stderr: run.stderr.slice(-4000) };
    return {
      sandboxId: s.id,
      harnessExit: run.exitCode,
      install,
      entry,
      ecosystem: base?.ecosystem ?? "none",
      installCommand: base?.installCommand ?? "",
      forgedCalls: base?.forgedCalls ?? [],
      files: base?.files ?? [],
      processes: base?.processes ?? [],
      canaryInFiles: base?.canaryInFiles ?? [],
      datagramEgress: base?.datagramEgress ?? [],
      unattributedDrops: base?.unattributedDrops ?? [],
      checks,
      installedDeps: base?.installedDeps ?? null,
      transcripts: base?.transcripts ?? { install: empty, entry: { stdout: "", stderr: "" } },
      timings: { ...(base?.timings ?? {}), "detonate.upload": upload, "detonate.total": Date.now() - t0, "detonate.vm": Date.now() - dvm.bootedAt },
      integrityMismatches: base?.integrityMismatches ?? [],
      mirrorMetadata: base?.mirrorMetadata ?? [],
      forensics,
      stats: base?.stats ?? { captureRecords: 0, captureInvalid: 0, harnessRecords: 0, traceLines: 0, traceUnparsed: 0, dropped: 0, writtenFiles: 0, pthFiles: [] },
    };
  });
}
