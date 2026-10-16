/**
 * Drive the analysis sandbox (DESIGN.md section 2.1): a fresh VM with no
 * network, the normalized repack of the verified archive, and
 * /opt/cr/bin/cr-analyze.sh running Semgrep, GuardDog and YARA. The VM never
 * runs repo code, so the detonation cannot tamper with these results. Killed in
 * `finally` like every other session.
 */

import { parseCrYara, parseGuardDog, parseSemgrep } from "../static/scanners";
import type { StaticFinding } from "../types";
import { packFiles } from "./pack";
import { withSandbox, type SandboxProvider, type SandboxSession } from "./provider";

export const ANALYZE_SCRIPT = "/opt/cr/bin/cr-analyze.sh";

export type AnalysisTool = "semgrep" | "guarddog-npm" | "guarddog-pypi" | "yara";

export interface AnalysisInput {
  runId: string;
  files: Map<string, Uint8Array>;
  ecosystems: Array<"npm" | "python">;
  sandboxTimeoutMs: number;
  commandTimeoutMs: number;
}

export interface AnalysisResult {
  findings: StaticFinding[];
  errors: string[];
  /** True when every expected tool exited 0 and its output parsed. */
  complete: boolean;
  tools: Partial<Record<AnalysisTool, { exit: number; ms: number; parsed: boolean }>>;
  sandboxId: string;
}

export interface AnalysisHooks {
  onLine?: (tool: "semgrep" | "guarddog" | "yara", stream: "stdout" | "stderr", text: string) => void;
  onKilled?: (ok: boolean, detail: string) => void;
}

const dec = new TextDecoder();

async function readText(s: SandboxSession, path: string): Promise<string | null> {
  try {
    return dec.decode(await s.readFile(path));
  } catch {
    return null;
  }
}

export function expectedTools(ecosystems: Array<"npm" | "python">): AnalysisTool[] {
  const tools: AnalysisTool[] = ["semgrep", "yara"];
  if (ecosystems.includes("npm")) tools.push("guarddog-npm");
  if (ecosystems.includes("python")) tools.push("guarddog-pypi");
  return tools;
}

const PARSERS: Record<AnalysisTool, (text: string) => { findings: StaticFinding[]; errors: string[] }> = {
  semgrep: (t) => parseSemgrep(t),
  yara: (t) => parseCrYara(t),
  "guarddog-npm": (t) => parseGuardDog(t),
  "guarddog-pypi": (t) => parseGuardDog(t),
};

export async function runAnalysis(provider: SandboxProvider, input: AnalysisInput, hooks: AnalysisHooks = {}): Promise<AnalysisResult> {
  return withSandbox(
    provider,
    { purpose: "analyze", runId: input.runId, timeoutMs: input.sandboxTimeoutMs, network: "none" },
    async (s) => {
      await s.writeFile("/root/in/src.tgz", packFiles(input.files));
      const toolTimeoutS = Math.max(4, Math.floor(input.commandTimeoutMs / 1000) - 2);
      await s.writeFile("/root/in/analyze.json", JSON.stringify({ ecosystems: input.ecosystems, tool_timeout_s: toolTimeoutS }));
      const run = await s.run(`bash ${ANALYZE_SCRIPT}`, { timeoutMs: input.commandTimeoutMs });
      const errors: string[] = [];
      if (run.exitCode !== 0) errors.push(`cr-analyze.sh exited ${run.exitCode}: ${run.stderr.slice(-400)}`);
      const statusText = await readText(s, "/root/out/status.json");
      let status: Record<string, { exit?: number; ms?: number }> = {};
      if (statusText) {
        try {
          status = JSON.parse(statusText) as typeof status;
        } catch {
          errors.push("status.json is not valid JSON");
        }
      }
      const findings: StaticFinding[] = [];
      const tools: AnalysisResult["tools"] = {};
      let complete = run.exitCode === 0;
      for (const tool of expectedTools(input.ecosystems)) {
        const st = status[tool];
        const exit = typeof st?.exit === "number" ? st.exit : -1;
        const ms = typeof st?.ms === "number" ? st.ms : 0;
        const text = await readText(s, `/root/out/${tool}.json`);
        const errText = await readText(s, `/root/out/${tool}.err`);
        const family = tool.startsWith("guarddog") ? "guarddog" : (tool as "semgrep" | "yara");
        if (errText && errText.trim()) hooks.onLine?.(family, "stderr", errText.slice(-4000));
        let parsed = false;
        if (text !== null && text.trim()) {
          try {
            const p = PARSERS[tool](text);
            findings.push(...p.findings);
            errors.push(...p.errors.map((e) => `${tool}: ${e}`));
            parsed = true;
            hooks.onLine?.(family, "stdout", `${tool}: ${p.findings.length} finding(s)`);
          } catch (err) {
            errors.push(`${tool}: ${(err as Error).message}`);
          }
        } else {
          errors.push(`${tool}: no output`);
        }
        // Semgrep exits 0 with findings; a non-zero exit or an unparsed output is incomplete coverage.
        if (exit !== 0 || !parsed) complete = false;
        tools[tool] = { exit, ms, parsed };
      }
      return { findings, errors, complete, tools, sandboxId: s.id };
    },
    hooks.onKilled,
  );
}
