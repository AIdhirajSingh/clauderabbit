/**
 * The E2B templates' compute sizes. One definition used by the template build
 * (sandbox/e2b/build.ts), the provider (which template a scan boots) and the cost
 * ledger (lib/engine/cost.ts), so the ledger prices the size a scan really ran at.
 *
 * Every scan boots `small` (1 vCPU) unless the repo is huge (over 10,000 files, or
 * more than 50 MB of file content at the pinned commit) or its build is heavy (a
 * compiled build, go.mod or Cargo.toml, or a lockfile over HEAVY_LOCKFILE_BYTES): those
 * boot `large` (4 vCPU). A Go compile of a thousand module packages or a yarn install
 * of two thousand packages is bound by CPU; on 1 vCPU, traced, it ran past 11 minutes.
 */

export type SandboxSize = "small" | "large";

export const SANDBOX_SIZES: Readonly<Record<SandboxSize, { cpuCount: number; memoryMB: number; suffix: string }>> = {
  small: { cpuCount: 1, memoryMB: 2048, suffix: "" },
  large: { cpuCount: 4, memoryMB: 4096, suffix: "-4cpu" },
};

/** The default (small) size, for callers that price or check the default template. */
export const SANDBOX_CPU_COUNT = SANDBOX_SIZES.small.cpuCount;
export const SANDBOX_MEMORY_MB = SANDBOX_SIZES.small.memoryMB;

export const HUGE_REPO_FILES = 10_000;
export const HUGE_REPO_BYTES = 50 * 1024 * 1024;

/** A lockfile this large lists a dependency tree whose install is bound by CPU. */
export const HEAVY_LOCKFILE_BYTES = 256 * 1024;

export function sizeForRepo(files: number, bytes: number, truncated: boolean, heavyBuild = false): SandboxSize {
  return truncated || heavyBuild || files > HUGE_REPO_FILES || bytes > HUGE_REPO_BYTES ? "large" : "small";
}

/** A tree path that marks a heavy build: a compiled build's manifest, a make build at the root, or a large lockfile (root or up to two folders down). */
export function isHeavyBuildPath(path: string, size: number): boolean {
  if (path.split("/").length > 3 || /(^|\/)(node_modules|vendor|test|tests|testdata|fixtures?|examples?|docs?)\//.test(path)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "go.mod" || base === "Cargo.toml") return true;
  // A make build at the repo root (C and C++ projects): the harness builds it with make.
  if (!path.includes("/") && ["Makefile", "GNUmakefile", "makefile", "configure"].includes(base)) return true;
  return ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "uv.lock", "poetry.lock", "Cargo.lock"].includes(base) && size > HEAVY_LOCKFILE_BYTES;
}
