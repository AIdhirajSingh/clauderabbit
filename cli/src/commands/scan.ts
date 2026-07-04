/**
 * `clauderabbit scan <target> [--json] [--ref <ref>] [--no-color]`
 *
 * Resolves the target (owner/repo, GitHub URL, or npm package name), calls the
 * real ClaudeRabbit API, and prints either a human report or the documented
 * `--json` structured object (consumed by scripts and agents).
 */

import { scanRepo, type StageStatus } from "../lib/client.js";
import { ensureLoggedIn } from "../lib/auth.js";
import { loadConfig } from "../lib/env.js";
import {
  colorPalette,
  plainPalette,
  toJson,
  toText,
} from "../lib/format.js";
import { resolveTarget } from "../lib/resolve.js";

export interface ScanCliOptions {
  json: boolean;
  ref?: string;
  color: boolean;
  /** When set, stage progress is printed to stderr (text mode only). */
  quiet: boolean;
}

export interface ScanOutcome {
  /** Process exit code. 0 = report produced; 1 = error. */
  exitCode: number;
}

/**
 * Run a scan and print output. Returns the exit code. Errors are printed as
 * JSON (with an `error` field) in --json mode so callers never get a torn,
 * unparseable stream, and as plain text otherwise. This NEVER prints a bare
 * "Safe" — a failure is an error, not a clearance.
 */
export async function runScanCommand(
  rawTarget: string,
  opts: ScanCliOptions,
): Promise<ScanOutcome> {
  const config = loadConfig();
  const palette = opts.color ? colorPalette : plainPalette;

  const fail = (message: string): ScanOutcome => {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: message, target: rawTarget }, null, 2)}\n`);
    } else {
      process.stderr.write(`${palette.red("Error:")} ${message}\n`);
    }
    return { exitCode: 1 };
  };

  // 0. Require sign-in — the CLI only works for a logged-in ClaudeRabbit
  // user (real product/access decision; the web app itself stays free and
  // anonymous). Logs in interactively (opens the browser) if not already.
  let token: string;
  try {
    token = await ensureLoggedIn(config);
  } catch (err) {
    return fail(`Sign-in failed: ${(err as Error).message}`);
  }

  // 1. Resolve the target (may hit the npm registry).
  let resolved;
  try {
    resolved = await resolveTarget(rawTarget);
  } catch (err) {
    return fail((err as Error).message);
  }

  const ref = opts.ref ?? resolved.ref;

  if (!opts.json && !opts.quiet) {
    const label =
      resolved.via === "npm"
        ? `npm:${resolved.npmPackage} → ${resolved.owner}/${resolved.repo}`
        : `${resolved.owner}/${resolved.repo}`;
    process.stderr.write(palette.dim(`Scanning ${label}${ref ? `@${ref}` : ""}…\n`));
  }

  // 2. Call the real API. Stage events go to stderr in interactive text mode.
  // Each phase emits a real "active" (starting) then "done" (finished) event
  // — render them distinctly rather than printing the same bare label twice.
  const onStage =
    !opts.json && !opts.quiet
      ? (chapter: string, status: StageStatus) =>
          process.stderr.write(
            status === "active"
              ? palette.dim(`  · ${chapter}…\n`)
              : `  ${palette.green("✓")} ${chapter}\n`,
          )
      : undefined;

  const result = await scanRepo(
    config,
    { owner: resolved.owner, repo: resolved.repo, ...(ref ? { ref } : {}) },
    token,
    onStage,
  );

  if (!result.ok) {
    return fail(result.error);
  }

  // 3. Print output.
  if (opts.json) {
    const json = toJson(result.report, config.siteUrl, {
      fresh: result.fresh,
      resolvedVia: resolved.via,
      ...(resolved.npmPackage ? { npmPackage: resolved.npmPackage } : {}),
    });
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    process.stdout.write(
      toText(
        result.report,
        config.siteUrl,
        {
          fresh: result.fresh,
          resolvedVia: resolved.via,
          ...(resolved.npmPackage ? { npmPackage: resolved.npmPackage } : {}),
        },
        palette,
        opts.color,
      ),
    );
  }

  return { exitCode: 0 };
}
