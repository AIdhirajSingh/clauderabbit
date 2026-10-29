/**
 * E2B implementation of the sandbox seam (DESIGN.md section 3.2), e2b@2.56.0.
 *
 * Every scan gets a fresh VM from the pinned template. The detonation VM's outer
 * fence denies all egress except the three registry hostnames (the forge inside
 * the VM is the only process that uses them); the analysis VM gets no egress at
 * all. `timeoutMs` makes E2B reap the VM even if this function dies, and the
 * engine kills it in `finally` (see `withSandbox`).
 */

import { CommandExitError, NotFoundError, Sandbox, SandboxNotRunningError } from "e2b";
import { HEARTBEAT_GRACE_MS } from "../config";
import { SANDBOX_SIZES } from "./resources";
import { REGISTRY_ALLOW_OUT, type CommandResult, type RunOptions, type SandboxCreateOptions, type SandboxProvider, type SandboxSession } from "./provider";

export interface E2BProviderOptions {
  apiKey: string;
  template: string;
  /** Full-install scans: VMs live HEARTBEAT_GRACE_MS and are tagged so the heartbeat route can extend them. */
  heartbeat?: boolean;
}

/**
 * Extends every heartbeat-kept VM of a run by HEARTBEAT_GRACE_MS. Returns how many
 * were extended. Called by POST /api/scan/<id>/heartbeat.
 */
export async function extendRunSandboxes(apiKey: string, runId: string, graceMs: number, sdk: Pick<typeof Sandbox, "list" | "setTimeout"> = Sandbox): Promise<number> {
  // Running sandboxes only, each extended on its own: a scan VM that ended between the
  // list and its setTimeout (NotFound) must not fail the heartbeat or stop the runner and
  // the other VMs from being extended, or the runner times out mid-scan.
  const pages = sdk.list({ apiKey, query: { metadata: { runId, heartbeat: "1" }, state: ["running"] } });
  const ids: string[] = [];
  while (pages.hasNext) for (const s of await pages.nextItems()) ids.push(s.sandboxId);
  const results = await Promise.allSettled(ids.map((id) => sdk.setTimeout(id, graceMs, { apiKey })));
  const failed = results.flatMap((r) => (r.status === "rejected" && !(r.reason instanceof NotFoundError || r.reason instanceof SandboxNotRunningError) ? [r.reason] : []));
  // Anything but an ended sandbox (auth, E2B down) is a real failure the caller reports.
  if (failed.length > 0) throw failed[0];
  return results.filter((r) => r.status === "fulfilled").length;
}

/** How many of a run's sandboxes (runner and scan VMs) are still running. Extends nothing. */
export async function countRunSandboxes(apiKey: string, runId: string): Promise<{ total: number; byPurpose: Record<string, number> }> {
  const pages = Sandbox.list({ apiKey, query: { metadata: { runId }, state: ["running"] } });
  const byPurpose: Record<string, number> = {};
  let total = 0;
  while (pages.hasNext) {
    for (const s of await pages.nextItems()) {
      const p = String((s.metadata as Record<string, string> | undefined)?.purpose ?? "unknown");
      byPurpose[p] = (byPurpose[p] ?? 0) + 1;
      total += 1;
    }
  }
  return { total, byPurpose };
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
    // Deny all egress through the egress rules (the same isolation as
    // allowInternetAccess false), so updateNetwork can open codeload for the one
    // repo fetch and close it again.
    return { ...base, allowInternetAccess: true, network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } };
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
  async setEgress(allowOut: readonly string[]): Promise<void> {
    await this.#sbx.updateNetwork({ denyOut: ["0.0.0.0/0"], allowOut: [...allowOut] });
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
  readonly canSetEgress = true;
  #apiKey: string;
  #heartbeat: boolean;

  constructor(opts: E2BProviderOptions) {
    if (!opts.apiKey) throw new Error("E2B_API_KEY is required for the E2B provider");
    this.#apiKey = opts.apiKey;
    this.template = opts.template;
    this.#heartbeat = opts.heartbeat === true;
  }

  async create(opts: SandboxCreateOptions): Promise<SandboxSession> {
    const base = e2bCreateOptions(opts, this.#apiKey);
    const create = this.#heartbeat ? { ...base, timeoutMs: HEARTBEAT_GRACE_MS, metadata: { ...base.metadata, heartbeat: "1" } } : base;
    const sbx = await Sandbox.create(`${this.template}${SANDBOX_SIZES[opts.size ?? "small"].suffix}`, create);
    return new E2BSession(sbx);
  }
}

/**
 * Tells a run's running install to keep going: writes /root/in/keep-installing (a
 * root-only path the repo's code cannot write) into the run's detonation VM, which
 * the harness checks while it asks at the install limit. Returns how many VMs got it.
 */
export async function continueRunInstall(apiKey: string, runId: string, answer: "yes" | "no" = "yes"): Promise<number> {
  const pages = Sandbox.list({ apiKey, query: { metadata: { runId, purpose: "detonate" } } });
  let n = 0;
  while (pages.hasNext) {
    for (const s of await pages.nextItems()) {
      const sbx = await Sandbox.connect(s.sandboxId, { apiKey });
      await sbx.files.write(answer === "yes" ? "/root/in/keep-installing" : "/root/in/stop-installing", "1", { user: "root" });
      n += 1;
    }
  }
  return n;
}
