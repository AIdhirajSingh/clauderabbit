/**
 * E2B implementation of the sandbox seam (DESIGN.md section 3.2), e2b@2.56.0.
 *
 * Every scan gets a fresh VM from the pinned template. The detonation VM's outer
 * fence denies all egress except the three registry hostnames (the forge inside
 * the VM is the only process that uses them); the analysis VM gets no egress at
 * all. `timeoutMs` makes E2B reap the VM even if this function dies, and the
 * engine kills it in `finally` (see `withSandbox`).
 */

import { CommandExitError, Sandbox } from "e2b";
import { REGISTRY_ALLOW_OUT, type CommandResult, type RunOptions, type SandboxCreateOptions, type SandboxProvider, type SandboxSession } from "./provider";

export interface E2BProviderOptions {
  apiKey: string;
  template: string;
}

/** The exact `Sandbox.create` options for a purpose (exported for tests). */
export function e2bCreateOptions(opts: SandboxCreateOptions, apiKey: string) {
  const base = {
    apiKey,
    timeoutMs: opts.timeoutMs,
    metadata: { runId: opts.runId, purpose: opts.purpose },
  };
  // allowPublicTraffic false: the sandbox's port URLs (<port>-<id>.e2b.app) need E2B's
  // traffic token, so nothing outside can reach the forge or any listener in the VM
  // (E2B also re-exposes loopback listeners on the VM address through socat).
  if (opts.network === "none") {
    return { ...base, allowInternetAccess: false, network: { allowPublicTraffic: false } };
  }
  return {
    ...base,
    allowInternetAccess: true,
    network: { denyOut: ["0.0.0.0/0"], allowOut: [...REGISTRY_ALLOW_OUT], allowPublicTraffic: false },
  };
}

class E2BSession implements SandboxSession {
  readonly id: string;
  #sbx: Sandbox;
  #killed = false;

  constructor(sbx: Sandbox) {
    this.#sbx = sbx;
    this.id = sbx.sandboxId;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const body = typeof data === "string" ? data : (data.slice().buffer as ArrayBuffer);
    await this.#sbx.files.write(path, body, { user: "root" });
  }

  async run(cmd: string, opts: RunOptions): Promise<CommandResult> {
    try {
      const r = await this.#sbx.commands.run(cmd, {
        user: "root",
        timeoutMs: opts.timeoutMs,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      if (err instanceof CommandExitError) {
        return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
      }
      throw err;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.#sbx.files.read(path, { user: "root", format: "bytes" });
  }

  /** The VM's public URL for a port (used by the operator smoke to prove it is closed). */
  publicUrl(port: number): string {
    return `https://${this.#sbx.getHost(port)}`;
  }

  async kill(): Promise<void> {
    if (this.#killed) return;
    this.#killed = true;
    await this.#sbx.kill();
  }
}

export class E2BProvider implements SandboxProvider {
  readonly template: string;
  #apiKey: string;

  constructor(opts: E2BProviderOptions) {
    if (!opts.apiKey) throw new Error("E2B_API_KEY is required for the E2B provider");
    this.#apiKey = opts.apiKey;
    this.template = opts.template;
  }

  async create(opts: SandboxCreateOptions): Promise<SandboxSession> {
    const sbx = await Sandbox.create(this.template, e2bCreateOptions(opts, this.#apiKey));
    return new E2BSession(sbx);
  }
}
