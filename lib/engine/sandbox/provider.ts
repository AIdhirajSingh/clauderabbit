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
  /** VM size (lib/engine/sandbox/resources.ts); small when omitted. */
  size?: import("./resources").SandboxSize;
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
  /**
   * Replace the VM's outer egress allow list (deny everything else). Used only to
   * open codeload.github.com for the one root fetch of the repo tarball and to
   * restore the list before any repo code runs (lib/engine/sandbox/vmfetch.ts).
   */
  setEgress?(allowOut: readonly string[]): Promise<void>;
  /** Destroy the VM. Idempotent. */
  kill(): Promise<void>;
}

export interface SandboxProvider {
  /** Template identity recorded on the report (e.g. the E2B template name). */
  readonly template: string;
  /** True when sessions implement setEgress (E2B): GitHub repos are then fetched inside the VMs. */
  readonly canSetEgress?: boolean;
  create(opts: SandboxCreateOptions): Promise<SandboxSession>;
}

/** Hosts the detonation VM's outer fence allows (DESIGN.md section 3.2). */
export const REGISTRY_ALLOW_OUT = ["registry.npmjs.org", "registry.yarnpkg.com", "npm.jsr.io", "pypi.org", "files.pythonhosted.org"] as const;

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
 * What to do with a session's kill. `onKilled` reports whether the kill call
 * succeeded. With `trackKill`, the kill is still issued at once (in `finally`),
 * but its promise is handed to the caller instead of being awaited, so the VM's
 * teardown round trip stays off the scan's critical path; the caller awaits
 * every tracked kill before it closes the run.
 */
export interface KillHooks {
  onKilled?: (ok: boolean, detail: string) => void;
  trackKill?: (kill: Promise<void>) => void;
}

/** Destroy one session and report it. Never throws. */
export function killSession(session: SandboxSession, purpose: SandboxPurpose, hooks: KillHooks = {}): Promise<void> {
  let killP: Promise<void>;
  try {
    killP = session.kill();
  } catch (err) {
    killP = Promise.reject(err);
  }
  const p = killP.then(
    () => hooks.onKilled?.(true, `${purpose} sandbox ${session.id} destroyed`),
    (err: unknown) => hooks.onKilled?.(false, `${purpose} sandbox ${session.id} kill failed: ${(err as Error)?.message ?? String(err)}`),
  );
  hooks.trackKill?.(p);
  return p;
}

/**
 * A VM booted ahead of its work: `create()` starts at once, so the boot overlaps
 * whatever the scan does before the VM is needed. Still one fresh VM for one
 * purpose in one scan: `release()` kills it (idempotent), whether or not it was
 * ever used, and the engine calls it in `finally` and on every early exit.
 */
export interface BootedSandbox {
  readonly purpose: SandboxPurpose;
  /** True when the kill's promise is handed to `trackKill` instead of being awaited by the user of the VM. */
  readonly killTracked: boolean;
  /** The session, or a SandboxCreateError when the provider could not start it. */
  session(): Promise<SandboxSession>;
  /** Kill the VM once; resolves when the kill finished (or at once when the VM never started). */
  release(): Promise<void>;
}

export function bootSandbox(provider: SandboxProvider, opts: SandboxCreateOptions, hooks: KillHooks = {}): BootedSandbox {
  const created: Promise<SandboxSession> = (async () => {
    try {
      return await provider.create(opts);
    } catch (err) {
      throw new SandboxCreateError(opts.purpose, err);
    }
  })();
  // The failure is surfaced by session(); never as an unhandled rejection.
  created.catch(() => undefined);
  let released: Promise<void> | null = null;
  return {
    purpose: opts.purpose,
    killTracked: Boolean(hooks.trackKill),
    session: () => created,
    release() {
      if (!released) released = created.then((s) => killSession(s, opts.purpose, hooks), () => undefined);
      return released;
    },
  };
}

/**
 * Create a session, run `fn`, and kill the session in `finally` no matter how
 * `fn` ends. The kill is awaited unless `hooks.trackKill` takes it over.
 */
export async function withSandbox<T>(
  provider: SandboxProvider,
  opts: SandboxCreateOptions,
  fn: (s: SandboxSession) => Promise<T>,
  hooks?: ((ok: boolean, detail: string) => void) | KillHooks,
): Promise<T> {
  const kh: KillHooks = typeof hooks === "function" ? { onKilled: hooks } : (hooks ?? {});
  return runOnBooted(bootSandbox(provider, opts, kh), fn);
}

/** Run `fn` on a booted VM and release it in `finally`; the kill is awaited unless tracked. */
export async function runOnBooted<T>(vm: BootedSandbox, fn: (s: SandboxSession) => Promise<T>): Promise<T> {
  const session = await vm.session();
  try {
    return await fn(session);
  } finally {
    const kill = vm.release();
    if (!vm.killTracked) await kill;
  }
}
