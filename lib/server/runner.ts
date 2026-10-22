/**
 * Start a scan in its own runner sandbox (lib/server/runner-main.ts) and relay its
 * lines while this request lives. The runner is a fresh E2B sandbox from the scan
 * template, separate from the scan VM, that runs the bundled scan pipeline. The keys
 * a scan needs go to that one process as environment at start, never to disk, and
 * never reach the scan VM (the pipeline gives that VM none, as before).
 *
 * Web scans: the runner and its scan VMs live HEARTBEAT_GRACE_MS unless the page's
 * heartbeat (POST /api/scan/<id>/heartbeat every 10 s) extends them, so a closed tab
 * stops the whole scan within 30 s. Other surfaces have no page: the runner lives
 * RUNNER_UNATTENDED_MS.
 *
 * When this request nears its own limit it ends the stream without a final line; the
 * page then follows the run from Supabase (stored events and Realtime), as it does
 * after any dropped stream.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getVercelOidcToken } from "@vercel/oidc";
import { HEARTBEAT_GRACE_MS, type EngineConfig } from "../engine/config";
import type { ScanCaller, ScanTarget } from "../engine/types";
import type { FinalLine } from "./scan-service";

/** A scan with no page to keep it alive (CLI, MCP) gets this long on its runner. */
const RUNNER_UNATTENDED_MS = 30 * 60_000;
const RUNNER_DIR = "/tmp/cr-runner";
const NODE = "/opt/cr/node/bin/node";

/**
 * Source files the pipeline reads from its working folder at run time and uploads into
 * the scan VM (the repo map tool, lib/engine/sandbox/vmfetch.ts); next.config.ts ships
 * them with this route, and the runner gets them at the same relative paths.
 */
export const RUNNER_TOOL_FILES = ["lib/engine/sandbox/vm-map.mjs", "lib/engine/reach/graph.ts", "lib/engine/static/heuristics.ts", "lib/engine/archive.ts"] as const;

/** The environment a scan needs, by name. Values are read from this process and passed to the runner's one command. */
export const RUNNER_ENV_NAMES = [
  "OPENAI_API_KEY", "E2B_API_KEY", "CR_V2_DATABASE_URL", "GITHUB_TOKEN", "CR_E2B_TEMPLATE", "CR_MODEL_ID", "CR_JEV_MODEL_ID",
  "CR_MODEL_REASONING_EFFORT", "CR_DAILY_MODEL_TOKENS_CAP", "CR_DAILY_SANDBOX_SECONDS_CAP", "CR_USD_INR", "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_ADSENSE_CLIENT_ID", "NEXT_PUBLIC_ADSENSE_SLOT_ID",
  "NEXT_PUBLIC_ADSENSE_TEST", "VERCEL_ENV", "VERCEL_REGION",
] as const;

export interface RunnerStart {
  target: ScanTarget;
  caller: ScanCaller;
  full: boolean;
  testInstallMs?: number;
  /** Raw NDJSON event lines, in order, as the runner prints them. */
  onLine: (line: string) => void;
  /** Stop relaying (no final line) at this epoch ms; the runner keeps going. */
  relayUntil: number;
}

export async function scanOnRunner(config: EngineConfig, s: RunnerStart): Promise<{ runId: string; final: FinalLine | null }> {
  // @ts-ignore generated at build time by scripts/build-runner.mjs (package.json vercel-build)
  const code = (await import("./runner-bundle.generated.mjs")).default as string;
  const { Sandbox } = await import("e2b");
  const runId = randomUUID();
  const heartbeat = s.caller.surface === "web";
  const sbx = await Sandbox.create(config.e2bTemplate, {
    apiKey: config.e2bApiKey!,
    timeoutMs: heartbeat ? HEARTBEAT_GRACE_MS : RUNNER_UNATTENDED_MS,
    metadata: { runId, purpose: "runner", ...(heartbeat ? { heartbeat: "1" } : {}) },
  });
  await sbx.files.write([
    { path: `${RUNNER_DIR}/runner.mjs`, data: code },
    ...RUNNER_TOOL_FILES.map((rel) => ({ path: `${RUNNER_DIR}/${rel}`, data: readFileSync(join(process.cwd(), rel), "utf8") })),
  ]);
  await sbx.files.write(`${RUNNER_DIR}/request.json`, JSON.stringify({ runId, sandboxId: sbx.sandboxId, target: s.target, caller: s.caller, full: s.full, heartbeat, ...(s.testInstallMs ? { testInstallMs: s.testInstallMs } : {}) }));
  const envs: Record<string, string> = {};
  for (const name of RUNNER_ENV_NAMES) {
    const v = process.env[name];
    if (typeof v === "string" && v !== "") envs[name] = v;
  }
  // Jev reaches the AI Gateway with this deployment's OIDC token; the runner has no request to read it from.
  try {
    envs.VERCEL_OIDC_TOKEN = await getVercelOidcToken();
  } catch {
    // Without it Jev's checks fail and the report states they did not complete.
  }
  let buf = "";
  let final: FinalLine | null = null;
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => (done = r));
  const onStdout = (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith('{"type":"final"')) {
        try {
          final = (JSON.parse(line) as { final: FinalLine }).final;
        } catch {
          final = null;
        }
        done();
      } else if (line.startsWith('{"type":"event"')) {
        s.onLine(line);
      }
    }
  };
  const cmd = await sbx.commands.run(`cd ${RUNNER_DIR} && exec ${NODE} runner.mjs request.json`, { background: true, envs, onStdout, timeoutMs: 0 });
  void cmd.wait().then(done, done);
  await Promise.race([finished, new Promise<void>((r) => setTimeout(r, Math.max(0, s.relayUntil - Date.now())))]);
  return { runId, final };
}
