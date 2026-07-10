/**
 * `clauderabbit scan <target> [--json] [--ref <ref>] [--no-color]`
 *
 * Resolves the target (owner/repo, GitHub URL, or npm package name), calls the
 * real ClaudeRabbit API, and prints either a human report or the documented
 * `--json` structured object (consumed by scripts and agents).
 */

import {
  awaitForensics,
  runDeepScan,
  scanRepo,
  type ScanArgs,
  type StageStatus,
} from "../lib/client.js";
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

  // 1. Resolve the target into a GitHub repo or an npm package target. This is
  // now purely local (no registry lookup) — the edge function does the real npm
  // work against the published artifact.
  let resolved;
  try {
    resolved = resolveTarget(rawTarget);
  } catch (err) {
    return fail((err as Error).message);
  }

  // 2. Build the API scan args + an honest human label per ecosystem. For npm
  // we pass the package target THROUGH so the API scans the real published
  // artifact — never a linked GitHub repo. `--ref` doubles as the version/dist-
  // tag selector for npm (its only sensible meaning there) and, as for GitHub,
  // an explicit flag wins over one parsed from the target string.
  let scanArgs: ScanArgs;
  let label: string;
  let displayRef: string | undefined;
  if (resolved.via === "npm") {
    const version = opts.ref ?? resolved.version;
    scanArgs = { ecosystem: "npm", package: resolved.package, ...(version ? { version } : {}) };
    label = `npm package ${resolved.package}`;
    displayRef = version;
  } else {
    const ref = opts.ref ?? resolved.ref;
    scanArgs = { owner: resolved.owner, repo: resolved.repo, ...(ref ? { ref } : {}) };
    label = `${resolved.owner}/${resolved.repo}`;
    displayRef = ref;
  }

  if (!opts.json && !opts.quiet) {
    process.stderr.write(palette.dim(`Scanning ${label}${displayRef ? `@${displayRef}` : ""}…\n`));
  }

  // 3. Call the real API. Stage events go to stderr in interactive text mode.
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

  const result = await scanRepo(config, scanArgs, token, onStage);

  if (!result.ok) {
    return fail(result.error);
  }
  let report = result.report;

  // 3b. ESCALATION → REAL SANDBOX. When the fast path decided the repo warrants a
  // live detonation (`report.deep`) but the sandbox hasn't run yet (no
  // `forensics`), trigger the SAME production dispatch the website uses
  // (`/api/deep`) and wait for the sandbox-verified report — so the CLI returns
  // the real runtime score, never the scarier static-only interim. GitHub targets
  // only: the detonation clones `owner/repo@sha` (npm-artifact detonation is a
  // separate harness capability, tracked separately).
  if (
    resolved.via !== "npm" &&
    report.deep &&
    !report.forensics &&
    typeof report.commit_sha === "string" &&
    report.commit_sha
  ) {
    if (!opts.json && !opts.quiet) {
      process.stderr.write(
        palette.dim(`  · Escalated — running the live sandbox (this takes a few minutes)…\n`),
      );
    }
    const deep = await runDeepScan(
      config,
      { owner: resolved.owner, repo: resolved.repo, sha: report.commit_sha },
      onStage,
    );
    if (deep.ok) {
      // persisted → forensics already attached (one confirming re-read); pending →
      // poll the report row until they land. Pinned to report.commit_sha (the
      // EXACT commit that was dispatched) so a fast-moving repo's default branch
      // advancing mid-poll can never substitute a fresh, non-escalated scan of a
      // newer commit as if it were this run's result — see awaitForensics.
      const verified = await awaitForensics(config, scanArgs, token, report.commit_sha, {
        tries: deep.persisted ? 3 : 36,
      });
      if (verified) report = verified;
    } else if (deep.unavailable) {
      if (!opts.json && !opts.quiet) process.stderr.write(palette.dim(`  · ${deep.error}\n`));
    } else if (!opts.json) {
      // A genuine dispatch failure — surface it, but still print the static read.
      process.stderr.write(`${palette.red("Sandbox:")} ${deep.error}\n`);
    }
  }

  // 4. Print output. For npm, thread the package name through so the renderers
  // can label the result honestly as an npm package (the report itself already
  // comes back with owner "npm" and the package as its name).
  const outputOpts = {
    fresh: result.fresh,
    resolvedVia: resolved.via,
    ...(resolved.via === "npm" ? { npmPackage: resolved.package } : {}),
  };
  if (opts.json) {
    const json = toJson(report, config.siteUrl, outputOpts);
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    process.stdout.write(
      toText(report, config.siteUrl, outputOpts, palette, opts.color),
    );
  }

  return { exitCode: 0 };
}
