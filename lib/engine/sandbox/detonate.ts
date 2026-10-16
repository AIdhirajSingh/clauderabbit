/**
 * Drive one detonation (DESIGN.md section 3): a fresh VM from the template,
 * the verified tarball and per-run canaries written as root, cr-detonate.sh
 * run as root (forge up, inner fence, containment probe, install and entry as
 * uid 1001 under strace and the fake clock), the forensic bundle read back, and
 * the VM killed in `finally`. Parsing happens here, in the function, never in
 * the VM.
 */

import { parseTarball, textOf } from "../archive";
import { canaryEnvFile, canaryMatcher, canaryPatternsFile, parseCapture, summarizeCapture, type Canaries } from "../forensics/capture";
import { parseStrace } from "../forensics/strace";
import type { PhaseOutcome } from "../score";
import { depsFromNpmLs, depsFromUvPipList } from "../static/osv";
import type { CheckEventData, DependencyRef, FileEventData, ForgedCallData, ProcessEventData } from "../types";
import { withSandbox, type SandboxProvider } from "./provider";

export const DETONATE_SCRIPT = "/opt/cr/bin/cr-detonate.sh";
export const OUT_ARCHIVE = "/root/out.tgz";
/** Exit code cr-detonate.sh uses when the containment probe fails (no repo code ran). */
export const EXIT_NOT_CONTAINED = 4;

export interface DetonationInput {
  runId: string;
  /** `npm-package`: install the tarball as a dependency. `repo`: extract and install the tree. */
  mode: "npm-package" | "repo";
  packageName: string | null;
  tarball: Uint8Array;
  canaries: Canaries;
  installTimeoutMs: number;
  entryTimeoutMs: number;
  totalTimeoutMs: number;
  sandboxTimeoutMs: number;
  fakeRate: number;
}

export interface DetonationHooks {
  onLog?: (stream: "stdout" | "stderr", text: string) => void;
  onKilled?: (ok: boolean, detail: string) => void;
}

export interface DetonationResult {
  sandboxId: string;
  harnessExit: number;
  install: PhaseOutcome;
  entry: PhaseOutcome;
  ecosystem: "npm" | "python" | "none";
  installCommand: string;
  forgedCalls: ForgedCallData[];
  files: FileEventData[];
  processes: ProcessEventData[];
  canaryInFiles: string[];
  checks: CheckEventData[];
  installedDeps: DependencyRef[] | null;
  transcripts: { install: { stdout: string; stderr: string }; entry: { stdout: string; stderr: string } };
  timings: Record<string, number>;
  integrityMismatches: Array<{ host: string; path: string | null }>;
  stats: { captureRecords: number; captureInvalid: number; harnessRecords: number; traceLines: number; traceUnparsed: number; dropped: number; writtenFiles: number; pthFiles: string[] };
}

interface HarnessResult {
  ecosystem?: string;
  deps_kind?: string;
  install?: { status?: string; exit_code?: number | null; ms?: number; command?: string };
  entry?: { status?: string; exit_code?: number | null; ms?: number };
  clock?: { real_ms?: number; fake_ms?: number };
  total_ms?: number;
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
  const eco = result.ecosystem === "npm" || result.ecosystem === "python" ? result.ecosystem : "none";
  return {
    install: rtext ? outcome(result.install?.status) : "failed",
    entry: rtext ? outcome(result.entry?.status) : "skipped",
    ecosystem: eco,
    installCommand: result.install?.command ?? "",
    forgedCalls: summary.forgedCalls,
    files: [...ti.files, ...te.files],
    processes: [...ti.processes, ...te.processes],
    canaryInFiles: lines(f("canary_files.txt")).slice(0, 100),
    checks,
    installedDeps,
    transcripts: {
      install: { stdout: f("install.out") ?? "", stderr: f("install.err") ?? "" },
      entry: { stdout: f("entry.out") ?? "", stderr: f("entry.err") ?? "" },
    },
    timings,
    integrityMismatches: summary.integrityMismatches,
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

export async function detonate(provider: SandboxProvider, input: DetonationInput, hooks: DetonationHooks = {}): Promise<DetonationResult> {
  return withSandbox(
    provider,
    { purpose: "detonate", runId: input.runId, timeoutMs: input.sandboxTimeoutMs, network: "registry-only" },
    async (s) => {
      const t0 = Date.now();
      await s.writeFile("/root/in/target.tgz", input.tarball);
      await s.writeFile(
        "/root/in/run.json",
        JSON.stringify({
          mode: input.mode,
          name: input.packageName,
          install_timeout_s: Math.max(1, Math.round(input.installTimeoutMs / 1000)),
          entry_timeout_s: Math.max(1, Math.round(input.entryTimeoutMs / 1000)),
          fake_rate: input.fakeRate,
        }),
      );
      await s.writeFile("/root/.cr/canary.env", canaryEnvFile(input.canaries));
      await s.writeFile("/root/.cr/canary-patterns.txt", canaryPatternsFile(input.canaries));
      const upload = Date.now() - t0;
      let run: { exitCode: number; stdout: string; stderr: string };
      let timedOut = false;
      try {
        run = await s.run(`chmod 0700 /root/.cr && chmod 0600 /root/.cr/canary.env /root/.cr/canary-patterns.txt && bash ${DETONATE_SCRIPT}`, {
          timeoutMs: input.totalTimeoutMs,
          onStdout: (t) => hooks.onLog?.("stdout", t),
          onStderr: (t) => hooks.onLog?.("stderr", t),
        });
      } catch (err) {
        // The command deadline passed (or the VM stopped answering): keep whatever was collected.
        timedOut = true;
        run = { exitCode: 124, stdout: "", stderr: (err as Error).message ?? String(err) };
      }
      let bytes: Uint8Array | null = null;
      try {
        bytes = await s.readFile(OUT_ARCHIVE);
      } catch {
        bytes = null;
      }
      const base = bytes
        ? await parseForensicBundle(bytes, input.canaries)
        : null;
      const checks = base?.checks ?? [];
      if (!bytes) {
        checks.push({ name: "forensics_collected", ok: false, detail: timedOut ? `harness passed the ${input.totalTimeoutMs} ms deadline` : `harness exited ${run.exitCode} without a forensic bundle` });
      }
      if (run.exitCode === EXIT_NOT_CONTAINED && !checks.some((c) => c.name === "egress_contained")) {
        checks.push({ name: "egress_contained", ok: false, detail: "containment probe failed; no repo code ran" });
      }
      const empty = { stdout: "", stderr: run.stderr.slice(-4000) };
      return {
        sandboxId: s.id,
        harnessExit: run.exitCode,
        install: base?.install ?? (timedOut ? "timeout" : run.exitCode === EXIT_NOT_CONTAINED ? "skipped" : "failed"),
        entry: base?.entry ?? "skipped",
        ecosystem: base?.ecosystem ?? "none",
        installCommand: base?.installCommand ?? "",
        forgedCalls: base?.forgedCalls ?? [],
        files: base?.files ?? [],
        processes: base?.processes ?? [],
        canaryInFiles: base?.canaryInFiles ?? [],
        checks,
        installedDeps: base?.installedDeps ?? null,
        transcripts: base?.transcripts ?? { install: empty, entry: { stdout: "", stderr: "" } },
        timings: { ...(base?.timings ?? {}), "detonate.upload": upload, "detonate.total": Date.now() - t0 },
        integrityMismatches: base?.integrityMismatches ?? [],
        stats: base?.stats ?? { captureRecords: 0, captureInvalid: 0, harnessRecords: 0, traceLines: 0, traceUnparsed: 0, dropped: 0, writtenFiles: 0, pthFiles: [] },
      };
    },
    hooks.onKilled,
  );
}
