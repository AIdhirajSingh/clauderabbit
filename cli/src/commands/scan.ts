/**
 * `clauderabbit scan <target> [--json] [--ref <ref>] [--no-color] [--quiet]`
 *
 * Resolves the target (owner/repo, GitHub URL, or npm package), POSTs it to
 * `${CLAUDE_RABBIT_SITE_URL}/api/scan` with the saved sign-in token, prints a
 * line per stage as the server runs it, then the verdict, score, evidence
 * (behaviour, code and reputation kept apart), what was not verified, the
 * report URL and the ad. Exit code 0 when a report came back, 1 otherwise.
 */

import chalk from "chalk";
import { ensureLoggedIn } from "../lib/auth.js";
import { loadConfig } from "../lib/env.js";
import { resolveTarget } from "../lib/resolve.js";
import { formatResponse, postScan, stageLine, toStructured, type ScanTarget } from "../lib/scan-api.js";

export interface ScanCliOptions {
  json: boolean;
  ref?: string;
  color: boolean;
  /** When set, stage progress is not printed. */
  quiet: boolean;
}

export interface ScanOutcome {
  /** Process exit code. 0 = report produced; 1 = error. */
  exitCode: number;
}

const BAND_COLOR = { green: chalk.green, blue: chalk.blue, yellow: chalk.yellow, red: chalk.red } as const;

export async function runScanCommand(rawTarget: string, opts: ScanCliOptions): Promise<ScanOutcome> {
  const config = loadConfig();
  const fail = (message: string): ScanOutcome => {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, target: rawTarget }, null, 2)}\n`);
    else process.stderr.write(`Error: ${message}\n`);
    return { exitCode: 1 };
  };

  let token: string;
  try {
    token = await ensureLoggedIn(config);
  } catch (err) {
    return fail(`Sign-in failed: ${(err as Error).message}`);
  }

  let resolved;
  try {
    resolved = resolveTarget(rawTarget);
  } catch (err) {
    return fail((err as Error).message);
  }

  let target: ScanTarget;
  if (resolved.via === "npm") {
    const version = opts.ref ?? resolved.version;
    target = { ecosystem: "npm", package: resolved.package, ...(version ? { version } : {}) };
  } else {
    const ref = opts.ref ?? resolved.ref;
    target = { ecosystem: "github", owner: resolved.owner, repo: resolved.repo, ...(ref ? { ref } : {}) };
  }

  const progress = !opts.json && !opts.quiet;
  if (progress) {
    const label = target.ecosystem === "npm" ? `npm:${target.package}${target.version ? `@${target.version}` : ""}` : `${target.owner}/${target.repo}${target.ref ? `@${target.ref}` : ""}`;
    process.stderr.write(`Scanning ${label}\n`);
  }
  const result = await postScan(config, target, token, "cli", progress ? (e) => {
    const line = stageLine(e);
    if (line) process.stderr.write(`${opts.color ? chalk.dim(line) : line}\n`);
  } : undefined);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(toStructured(result), null, 2)}\n`);
    return { exitCode: result.ok ? 0 : 1 };
  }
  let text = formatResponse(result);
  if (opts.color && result.ok) {
    const paint = BAND_COLOR[result.report.band] ?? chalk.white;
    text = text.replace(/^Verdict: .*$/m, (m) => paint.bold(m));
  }
  (result.ok ? process.stdout : process.stderr).write(text);
  return { exitCode: result.ok ? 0 : 1 };
}
