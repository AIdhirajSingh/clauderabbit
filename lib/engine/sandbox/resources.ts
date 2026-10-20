/**
 * The E2B templates' compute sizes. One definition used by the template build
 * (sandbox/e2b/build.ts), the provider (which template a scan boots) and the cost
 * ledger (lib/engine/cost.ts), so the ledger prices the size a scan really ran at.
 *
 * Every scan boots `small` (1 vCPU); a huge repo (over 10,000 files, or more than
 * 50 MB of file content at the pinned commit) boots `large` (2 vCPU).
 */

export type SandboxSize = "small" | "large";

export const SANDBOX_SIZES: Readonly<Record<SandboxSize, { cpuCount: number; memoryMB: number; suffix: string }>> = {
  small: { cpuCount: 1, memoryMB: 2048, suffix: "" },
  large: { cpuCount: 2, memoryMB: 2048, suffix: "-2cpu" },
};

/** The default (small) size, for callers that price or check the default template. */
export const SANDBOX_CPU_COUNT = SANDBOX_SIZES.small.cpuCount;
export const SANDBOX_MEMORY_MB = SANDBOX_SIZES.small.memoryMB;

export const HUGE_REPO_FILES = 10_000;
export const HUGE_REPO_BYTES = 50 * 1024 * 1024;

export function sizeForRepo(files: number, bytes: number, truncated: boolean): SandboxSize {
  return truncated || files > HUGE_REPO_FILES || bytes > HUGE_REPO_BYTES ? "large" : "small";
}
