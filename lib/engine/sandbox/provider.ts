/**
 * Sandbox provider seam (DESIGN.md section 4).
 *
 * One `SandboxSession` is one fresh VM for one purpose in one scan. The engine
 * never reuses a session: `create()` is called per scan and `kill()` runs in a
 * `finally` (see `withSandbox`), so a caught attack lands in an empty room that
 * is demolished right after. Every operation runs as root inside the VM; repo
 * code is dropped to uid 1001 by the guest harness, never by this layer.
 */

export type SandboxPurpose = "detonate" | "analyze";

/** `registry-only`: outer fence allows only the package registries. `none`: no egress at all. */
export type SandboxNetwork = "registry-only" | "none";

export interface SandboxCreateOptions {
  purpose: SandboxPurpose;
  runId: string;
  timeoutMs: number;
  network: SandboxNetwork;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  onStdout?: (s: string) => void;
  onStderr?: (s: string) => void;
}

export interface SandboxSession {
  readonly id: string;
  /** Write a file as root (parent directories are created). */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Run a command as root. A non-zero exit is returned, never thrown. */
  run(cmd: string, opts: RunOptions): Promise<CommandResult>;
  /** Read a file as root. */
  readFile(path: string): Promise<Uint8Array>;
  /** Destroy the VM. Idempotent. */
  kill(): Promise<void>;
}

export interface SandboxProvider {
  /** Template identity recorded on the report (e.g. the E2B template name). */
  readonly template: string;
  create(opts: SandboxCreateOptions): Promise<SandboxSession>;
}

/** Hosts the detonation VM's outer fence allows (DESIGN.md section 3.2). */
export const REGISTRY_ALLOW_OUT = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"] as const;

/** The provider could not start a VM (quota, concurrency, outage). Nothing ran. */
export class SandboxCreateError extends Error {
  readonly purpose: SandboxPurpose;
  constructor(purpose: SandboxPurpose, cause: unknown) {
    super(`could not start the ${purpose} sandbox: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "SandboxCreateError";
    this.purpose = purpose;
  }
}

/**
 * Create a session, run `fn`, and kill the session in `finally` no matter how
 * `fn` ends. `onKilled` reports whether the kill call succeeded.
 */
export async function withSandbox<T>(
  provider: SandboxProvider,
  opts: SandboxCreateOptions,
  fn: (s: SandboxSession) => Promise<T>,
  onKilled?: (ok: boolean, detail: string) => void,
): Promise<T> {
  let session: SandboxSession;
  try {
    session = await provider.create(opts);
  } catch (err) {
    throw new SandboxCreateError(opts.purpose, err);
  }
  try {
    return await fn(session);
  } finally {
    try {
      await session.kill();
      onKilled?.(true, `${opts.purpose} sandbox ${session.id} destroyed`);
    } catch (err) {
      onKilled?.(false, `${opts.purpose} sandbox ${session.id} kill failed: ${(err as Error).message ?? String(err)}`);
    }
  }
}
