/**
 * The scan runner: the whole scan pipeline in its own E2B sandbox (lib/server/runner.ts
 * starts it), so no Vercel request limit ends a scan. It is never the scan VM that runs
 * the target's code; that VM is started from here like any other scan.
 *
 * Input: the request file named on the command line (run id, target, caller, flags).
 * Keys: process environment only, set by the starter for this one process; never on disk.
 * Output: one NDJSON line per scan event, then {"type":"final","final":<FinalLine>}.
 * Every event and the report are written to Supabase as the scan goes (the v2 store),
 * so a page that lost the starter's stream follows the run through Realtime.
 */

import { readFileSync } from "node:fs";
import { loadEngineConfig } from "../engine/config";
import { eventLine, ndjsonLine } from "../engine/events";
import { createV2Store } from "../engine/store";
import type { ScanCaller, ScanTarget } from "../engine/types";
import { executeScan } from "./scan-service";

interface RunnerRequest {
  runId: string;
  /** This runner's own sandbox, removed when the scan is done. */
  sandboxId: string;
  /** When the starter created this runner's sandbox (epoch ms), for the scan's ledger. */
  createdAt: number;
  target: ScanTarget;
  caller: ScanCaller;
  full: boolean;
  fresh?: boolean;
  heartbeat: boolean;
  testInstallMs?: number;
}

async function main(): Promise<void> {
  const req = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as RunnerRequest;
  const base = loadEngineConfig(process.env);
  const deadlines = req.testInstallMs ? { ...base.deadlines, installMs: req.testInstallMs } : base.deadlines;
  const config = { ...base, deadlines, runner: true, runnerStartedAt: req.createdAt, heartbeatSandboxes: req.heartbeat };
  const store = createV2Store(config);
  const out = (line: string) => process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
  const pending: Promise<void>[] = [];
  const final = await executeScan({ config, store, identity: null, caller: req.caller }, req.target, false, {
    ...(req.full ? { full: true } : {}),
    ...(req.fresh ? { fresh: true } : {}),
    runId: req.runId,
    onEvent: (e) => out(eventLine(e)),
    background: (task) => void pending.push(task),
  });
  // The rows are written before the final line, so the stored report exists when the page asks.
  await Promise.allSettled(pending);
  out(ndjsonLine({ type: "final", final }));
  // The runner's work is done: its own sandbox goes now, not at its timeout.
  try {
    const { Sandbox } = await import("e2b");
    await Sandbox.kill(req.sandboxId, { apiKey: config.e2bApiKey! });
  } catch {
    // The sandbox's own timeout removes it.
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(`${JSON.stringify({ type: "final", final: { type: "error", code: "internal", message: err instanceof Error ? err.message.slice(0, 300) : "runner failed", run_id: null, ad: null } })}\n`);
    process.exit(1);
  },
);
