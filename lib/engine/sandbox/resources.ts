/**
 * The E2B template's compute size. One definition used by the template build
 * (sandbox/e2b/build.ts) and by the cost ledger (lib/engine/cost.ts), so the
 * ledger always prices the size the sandboxes really run at.
 */

export const SANDBOX_CPU_COUNT = 2;
export const SANDBOX_MEMORY_MB = 4096;
