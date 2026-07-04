/**
 * Install/clone wrapper subcommands:
 *   clauderabbit npm-install  <args...>   → scan target(s), then run `npm install <args...>`
 *   clauderabbit pnpm-install <args...>   → scan target(s), then run `pnpm install/add <args...>`
 *   clauderabbit git-clone    <args...>   → scan target,    then run `git clone <args...>`
 *
 * The design (per the reviewer's concern #1) is deliberately honest:
 *   - We scan the NEW dependency/repo being fetched, print the real verdict
 *     and the honest hedge (what was / wasn't verified) — NEVER a bare "Safe".
 *   - ONLY a "Trusted" (>=90) verdict proceeds with a brief one-line confirm.
 *     "Likely safe" and below always print the full hedge/summary before
 *     proceeding, so a human or agent sees exactly what was and wasn't
 *     verified — never just a green light.
 *   - We never silently BLOCK either (a wrong auto-deny is also false
 *     certainty). In an interactive TTY we prompt for anything below Trusted;
 *     in a non-interactive/agent context we proceed but only AFTER printing
 *     the full hedge (and, for a strong warning, a loud banner).
 *
 * Coverage is intentionally scoped and documented (README concern #2): we only
 * scan a new package/repo when a target is present on the command line. Bare
 * `npm install` (installing an existing lockfile/package.json) fetches no
 * single new dependency to scan, so we pass it straight through.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { scanRepo } from "../lib/client.js";
import { ensureLoggedIn } from "../lib/auth.js";
import { loadConfig } from "../lib/env.js";
import {
  colorPalette,
  plainPalette,
  proceedPolicy,
  ranSandbox,
  reportUrlFor,
  type Palette,
} from "../lib/format.js";
import { resolveTarget } from "../lib/resolve.js";
import type { Report } from "../lib/types.js";

export type Manager = "npm" | "pnpm" | "git";

export interface WrapOptions {
  color: boolean;
  /** Never prompt; proceed after printing the honest verdict (agent mode). */
  yes: boolean;
  /** Scan and report only; never actually run the underlying command. */
  dryRun: boolean;
}

/** npm/pnpm subcommands that FETCH a named package (so a target may be present). */
const NPM_INSTALL_SUBCMDS = new Set(["install", "i", "add"]);
const PNPM_INSTALL_SUBCMDS = new Set(["install", "i", "add"]);

/**
 * Extract the package/repo target(s) from the raw args for a given manager.
 * Returns the list of scan targets (npm package names or git URLs). An empty
 * list means "nothing new to scan" (e.g. bare `npm install`).
 */
export function extractTargets(manager: Manager, args: string[]): string[] {
  if (manager === "git") {
    // git clone <url> [dir] — the first non-flag arg after (an implicit)
    // clone is the URL. We're invoked as `git-clone <args>`, so args are the
    // args that would follow `git clone`.
    const first = args.find((a) => !a.startsWith("-"));
    return first ? [first] : [];
  }

  // npm / pnpm: the caller passes the args that follow the manager binary,
  // e.g. ["install", "lodash", "--save-dev"] or ["add", "@scope/x"].
  const [sub, ...rest] = args;
  const set = manager === "npm" ? NPM_INSTALL_SUBCMDS : PNPM_INSTALL_SUBCMDS;
  if (!sub || !set.has(sub)) {
    // Not an install/add subcommand we recognize (e.g. `npm run build`), or a
    // bare manager call — nothing new to scan.
    return [];
  }
  // Every non-flag arg after the subcommand is a package spec. We drop the
  // value of flags that take one (e.g. --prefix, -C) conservatively: npm/pnpm
  // package flags are almost all `--flag` / `--flag=value` boolean-ish forms,
  // so we only special-case the common value-taking ones.
  const VALUE_FLAGS = new Set(["--prefix", "-C", "--workspace", "-w", "--filter"]);
  const targets: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++; // skip its value
      continue;
    }
    targets.push(a);
  }
  return targets;
}

/** Strip an npm version specifier from a package spec for scanning (lodash@4 → lodash). */
function scanSpecFor(target: string): string {
  // Scoped: @scope/name@version → @scope/name ; unscoped: name@version → name.
  if (target.startsWith("@")) {
    const slash = target.indexOf("/");
    if (slash > 0) {
      const at = target.indexOf("@", slash);
      return at > 0 ? target.slice(0, at) : target;
    }
    return target;
  }
  const at = target.indexOf("@");
  return at > 0 ? target.slice(0, at) : target;
}

function bannerFor(report: Report, p: Palette): string[] {
  const policy = proceedPolicy(report);
  const ran = ranSandbox(report);
  const paint =
    report.score >= 90
      ? p.green
      : report.score >= 80
        ? p.blue
        : report.score >= 60
          ? p.yellow
          : p.red;
  const lines: string[] = [];
  lines.push(
    paint(
      `  ClaudeRabbit: ${report.owner}/${report.name} — ${report.score}/100 (${report.verdict})`,
    ),
  );
  // Honest hedge ALWAYS printed — never a bare green light.
  lines.push(p.dim(`  ${policy.hedge}`));
  // Code/behavior findings, kept separate from reputation.
  const behavior = report.risky.filter((r) => r.kind !== "rep");
  if (behavior.length > 0) {
    lines.push(p.dim("  Code/behavior findings:"));
    for (const b of behavior.slice(0, 4)) {
      lines.push(p.dim(`    - [${b.severity.toUpperCase()}] ${b.title}`));
    }
  }
  if (!ran) {
    lines.push(p.dim("  Not verified: full runtime behavior (no sandbox run on this pass)."));
  }
  return lines;
}

/** Ask the user y/N on the interactive TTY. Resolves false on EOF/non-TTY. */
function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Shell metacharacters that must never appear in an arg we hand to a shelled
 * child. A legitimate npm package spec, flag, or git URL never contains these;
 * their presence means someone is trying to break out of the command, so we
 * refuse to run rather than risk injection.
 */
const SHELL_META_RE = /[&|;<>^"'`$(){}\[\]!%\n\r]/;

/** Run the underlying manager command, inheriting stdio; resolves its exit code. */
function runUnderlying(manager: Manager, args: string[]): Promise<number> {
  // git-clone maps to `git clone <args>`; npm/pnpm pass args through verbatim.
  const fullArgs = manager === "git" ? ["clone", ...args] : args;

  // On Windows, npm/pnpm are `.cmd` batch shims; since Node 18.20/20.12
  // (CVE-2024-27980) spawning a `.cmd` requires `shell: true`, which reopens
  // the arg-injection surface DEP0190 warns about. We close it by REFUSING any
  // arg containing shell metacharacters before shelling out — a real package
  // spec / URL / flag never has them. On POSIX we spawn the bare binary with
  // an args array (no shell), so no such guard is needed.
  const useShell = process.platform === "win32";
  const bin = useShell ? (manager === "git" ? "git" : `${manager}.cmd`) : manager;

  if (useShell) {
    const bad = fullArgs.find((a) => SHELL_META_RE.test(a));
    if (bad !== undefined) {
      process.stderr.write(
        `Refusing to run ${manager}: argument "${bad}" contains shell metacharacters. ` +
          `Run the command directly if this is intentional.\n`,
      );
      return Promise.resolve(126);
    }
  }

  // Node emits DEP0190 whenever `shell: true` is combined with an args array.
  // We are FORCED into that shape on Windows (`.cmd` shims need a shell) and
  // have already closed the injection surface it warns about via SHELL_META_RE
  // above, so silence just this one deprecation to keep the output clean for
  // agents — without muting any other warning.
  const silenceDep0190 = (warning: Error): void => {
    if ((warning as NodeJS.ErrnoException).code === "DEP0190") return;
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  };
  if (useShell) {
    process.removeAllListeners("warning");
    process.on("warning", silenceDep0190);
  }

  return new Promise((resolve) => {
    const child = spawn(bin, fullArgs, { stdio: "inherit", shell: useShell });
    child.on("error", (err) => {
      process.stderr.write(`Failed to run ${bin}: ${(err as Error).message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export interface WrapOutcome {
  exitCode: number;
}

/**
 * The shared wrapper flow: scan each fetched target, print honest verdicts,
 * apply the proceed policy, then (unless dry-run or refused) run the real
 * command.
 */
export async function runWrapCommand(
  manager: Manager,
  args: string[],
  opts: WrapOptions,
): Promise<WrapOutcome> {
  const config = loadConfig();
  const p = opts.color ? colorPalette : plainPalette;

  const targets = extractTargets(manager, args);

  if (targets.length === 0) {
    // Nothing new is being fetched (bare install / unrecognized subcommand).
    // Pass straight through — honest: we make no safety claim about it.
    process.stderr.write(
      p.dim(
        `ClaudeRabbit: no new dependency/repo target on the command line — nothing to scan, running ${manager} as-is.\n`,
      ),
    );
    if (opts.dryRun) return { exitCode: 0 };
    const code = await runUnderlying(manager, args);
    return { exitCode: code };
  }

  // A real target will be scanned, so ClaudeRabbit's login requirement
  // applies here too (opens the browser to sign in if not already).
  let token: string;
  try {
    token = await ensureLoggedIn(config);
  } catch (err) {
    process.stderr.write(p.red(`Sign-in failed: ${(err as Error).message}\n`));
    return { exitCode: 1 };
  }

  let anyStrongWarning = false;

  for (const rawTarget of targets) {
    const scanSpec = manager === "git" ? rawTarget : scanSpecFor(rawTarget);
    process.stderr.write(p.dim(`ClaudeRabbit: scanning ${scanSpec}…\n`));

    let resolved;
    try {
      resolved = await resolveTarget(scanSpec);
    } catch (err) {
      // Could not resolve to a scannable GitHub repo. Be honest: we can't
      // vouch for it, but we don't block — print a caveat and move on.
      process.stderr.write(
        p.yellow(
          `  Could not scan "${scanSpec}": ${(err as Error).message} — proceeding WITHOUT a ClaudeRabbit verdict for it.\n`,
        ),
      );
      continue;
    }

    const result = await scanRepo(config, {
      owner: resolved.owner,
      repo: resolved.repo,
      ...(resolved.ref ? { ref: resolved.ref } : {}),
    }, token);

    if (!result.ok) {
      process.stderr.write(
        p.yellow(
          `  Scan failed for ${resolved.owner}/${resolved.repo}: ${result.error} — proceeding WITHOUT a verdict for it.\n`,
        ),
      );
      continue;
    }

    const report = result.report;
    const policy = proceedPolicy(report);
    for (const line of bannerFor(report, p)) process.stderr.write(`${line}\n`);
    process.stderr.write(p.dim(`  Full report: ${reportUrlFor(config.siteUrl, report)}\n`));

    if (policy.strongWarning) {
      anyStrongWarning = true;
      process.stderr.write(
        p.red(
          `  STRONG WARNING: ${report.owner}/${report.name} scored ${report.score}/100 (${report.verdict}). Treat as dangerous; run only in a disposable environment.\n`,
        ),
      );
    }

    // --dry-run: scan and report every target, but never prompt and never
    // install. Skip the proceed gate entirely (we're not going to run the
    // command regardless), so a report-only run is not blocked by the
    // interactivity check below.
    if (opts.dryRun) {
      continue;
    }

    // Proceed policy. Trusted (>=90) may proceed on a brief confirm; anything
    // else already had its full hedge printed above.
    if (opts.yes) {
      // Agent / non-interactive: proceed, but the honest hedge (and any strong
      // warning) was already printed. Never a silent green light.
      if (policy.trusted) {
        process.stderr.write(p.green(`  Trusted verdict — proceeding.\n`));
      } else {
        process.stderr.write(
          p.dim(`  Proceeding (--yes) after printing the above; this is NOT a safety guarantee.\n`),
        );
      }
      continue;
    }

    if (process.stdin.isTTY) {
      // Interactive: Trusted gets a brief confirm; everything else prompts with
      // the hedge already visible.
      const prompt = policy.trusted
        ? p.green(`  Trusted (${report.score}/100). Proceed? [Y/n] `)
        : p.yellow(`  Proceed despite the above? [y/N] `);
      const proceed = policy.trusted
        ? await confirmDefaultYes(prompt)
        : await confirm(prompt);
      if (!proceed) {
        process.stderr.write(p.dim(`  Aborted by user; ${manager} was not run.\n`));
        return { exitCode: 2 };
      }
    } else {
      // Non-interactive without --yes: do not proceed automatically. Exit
      // with a distinct code so a caller (e.g. a hook) can decide.
      process.stderr.write(
        p.yellow(
          `  Non-interactive and no --yes given. Not running ${manager} automatically. Re-run with --yes to proceed after reviewing the above.\n`,
        ),
      );
      return { exitCode: 3 };
    }
  }

  if (opts.dryRun) {
    process.stderr.write(p.dim(`  --dry-run: not running ${manager}.\n`));
    return { exitCode: anyStrongWarning ? 10 : 0 };
  }

  const code = await runUnderlying(manager, args);
  return { exitCode: code };
}

/** Trusted confirm defaults to YES (empty answer = proceed). */
function confirmDefaultYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim();
      resolve(a === "" || /^y(es)?$/i.test(a));
    });
  });
}
