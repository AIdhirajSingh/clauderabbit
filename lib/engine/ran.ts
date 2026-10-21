/**
 * The `ran` summary on a report: what the sandbox actually did, built in code
 * from the run's own facts (the harness result, the install plan, the lockfile,
 * the trace and the forge capture). A field the run did not establish is null;
 * nothing here is estimated or filled in.
 */

import { isRegistryCall } from "./forensics/capture";
import type { InstallPlan } from "./plan";
import type { DetonationResult } from "./sandbox/detonate";
import type { DependencyRef, ReportPayload } from "./types";

export type RanSummary = NonNullable<ReportPayload["ran"]>;

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "pip", "pip3"]);
const INSTALL_SCRIPT_NAMES = ["preinstall", "install", "postinstall"] as const;
const MAX_COMMAND_CHARS = 300;

/** The package manager the harness's install command invoked, or null when it ran none. */
export function packageManagerOf(installCommand: string): string | null {
  const first = installCommand.trim().split(/\s+/)[0] ?? "";
  return PACKAGE_MANAGERS.has(first) ? (first === "pip3" ? "pip" : first) : null;
}

/**
 * Registry-only traffic, N non-registry calls the forge answered, or no calls.
 * Null when the forensic record was lost. With a partial record only a forged
 * count stands (as observed); "registry only" and "none" need the whole record.
 */
export function classifyNetwork(d: Pick<DetonationResult, "forgedCalls" | "forensics">): RanSummary["network"] {
  if (d.forensics.coverage === "lost") return null;
  const forged = d.forgedCalls.filter((c) => !isRegistryCall(c)).length;
  if (forged > 0) return { kind: "forged", calls: forged };
  if (d.forensics.coverage !== "complete") return null;
  return d.forgedCalls.length > 0 ? { kind: "registry_only" } : { kind: "none" };
}

/** The first command the entry script ran (the trace's first entry-phase exec past the wrapper shell). */
export function entryCommandOf(processes: DetonationResult["processes"]): string | null {
  for (const p of processes) {
    if (p.phase !== "entry" || p.argv.length === 0) continue;
    const a0 = p.argv[0]!.split("/").pop() ?? "";
    if ((a0 === "bash" || a0 === "sh") && p.argv.some((a) => a.endsWith("entry.sh"))) continue;
    return p.argv.join(" ").slice(0, MAX_COMMAND_CHARS);
  }
  return null;
}

/**
 * Install scripts in the installed npm tree: lockfile packages marked
 * `hasInstallScript` that this run installed, plus the repo's own
 * preinstall/install/postinstall. Null without an npm lockfile or an installed tree.
 */
export function installScriptsOf(files: Map<string, Uint8Array>, installed: DependencyRef[] | null): number | null {
  if (!installed) return null;
  const lockBytes = files.get("package-lock.json") ?? files.get("npm-shrinkwrap.json");
  if (!lockBytes) return null;
  let lock: { packages?: Record<string, Record<string, unknown>> };
  try {
    lock = JSON.parse(new TextDecoder().decode(lockBytes)) as typeof lock;
  } catch {
    return null;
  }
  if (!lock.packages || typeof lock.packages !== "object") return null;
  const have = new Set(installed.filter((d) => d.ecosystem === "npm").map((d) => `${d.name}@${d.version}`));
  let n = 0;
  for (const [key, v] of Object.entries(lock.packages)) {
    const idx = key.lastIndexOf("node_modules/");
    if (idx === -1 || v?.hasInstallScript !== true || typeof v.version !== "string") continue;
    const name = typeof v.name === "string" ? v.name : key.slice(idx + "node_modules/".length);
    if (have.has(`${name}@${v.version}`)) n++;
  }
  const pkg = files.get("package.json");
  if (pkg) {
    try {
      const scripts = (JSON.parse(new TextDecoder().decode(pkg)) as { scripts?: Record<string, unknown> }).scripts ?? {};
      if (INSTALL_SCRIPT_NAMES.some((s) => typeof scripts[s] === "string" && scripts[s])) n++;
    } catch {
      return null;
    }
  }
  return n;
}

export interface RanInputs {
  detonation: DetonationResult | null;
  plan: InstallPlan | null;
  files: Map<string, Uint8Array>;
}

/** The `ran` summary of a run, or undefined when no detonation result came back. */
export function buildRanSummary({ detonation: d, plan, files }: RanInputs): RanSummary | undefined {
  if (!d) return undefined;
  const ran = d.install !== "skipped";
  const completed = d.install === "completed";
  const installMs = d.timings["detonate.install"];
  const command = d.entry === "skipped" ? null : entryCommandOf(d.processes);
  return {
    package_manager: ran ? packageManagerOf(d.installCommand) : null,
    installed: completed && d.installedDeps ? d.installedDeps.length : null,
    // The plan installs only the dev packages with an install script; the rest of the dev tree is not run.
    skipped: completed && plan && d.ecosystem === "npm" ? Math.max(0, plan.devTotal - plan.devScripts.length) : null,
    install_ms: ran && typeof installMs === "number" && Number.isFinite(installMs) ? installMs : null,
    install_scripts: completed && d.ecosystem === "npm" ? installScriptsOf(files, d.installedDeps) : null,
    network: classifyNetwork(d),
    entry_point: command ? { command, exit_code: typeof d.entryExitCode === "number" ? d.entryExitCode : null } : null,
  };
}

const nullableNum = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));

/** A stored `ran` summary, or null when the row predates it or it is malformed. */
export function ranFrom(v: unknown): RanSummary | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!(o.package_manager === null || typeof o.package_manager === "string")) return null;
  if (!nullableNum(o.installed) || !nullableNum(o.skipped) || !nullableNum(o.install_ms) || !nullableNum(o.install_scripts)) return null;
  let network: RanSummary["network"] = null;
  if (o.network !== null) {
    const n = o.network as Record<string, unknown> | undefined;
    if (!n || typeof n !== "object") return null;
    if (n.kind === "registry_only" || n.kind === "none") network = { kind: n.kind };
    else if (n.kind === "forged" && typeof n.calls === "number" && Number.isSafeInteger(n.calls) && n.calls >= 0) network = { kind: "forged", calls: n.calls };
    else return null;
  }
  let entry: RanSummary["entry_point"] = null;
  if (o.entry_point !== null) {
    const e = o.entry_point as Record<string, unknown> | undefined;
    if (!e || typeof e !== "object" || typeof e.command !== "string" || !nullableNum(e.exit_code)) return null;
    entry = { command: e.command, exit_code: e.exit_code };
  }
  return {
    package_manager: o.package_manager,
    installed: o.installed,
    skipped: o.skipped,
    install_ms: o.install_ms,
    install_scripts: o.install_scripts,
    network,
    entry_point: entry,
  };
}
