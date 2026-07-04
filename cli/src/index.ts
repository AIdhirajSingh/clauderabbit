#!/usr/bin/env node
/**
 * clauderabbit — CLI entrypoint.
 *
 * Commands:
 *   scan <target> [--json] [--ref <r>] [--no-color]
 *   report <target> [--json] [--no-color]          (cached-only read, no new scan)
 *   npm-install  <args...> [--yes] [--dry-run]
 *   pnpm-install <args...> [--yes] [--dry-run]
 *   git-clone    <args...> [--yes] [--dry-run]
 *   install-hooks   [--shell bash|zsh|powershell] [--profile <path>] [--print]
 *   uninstall-hooks [--shell ...] [--profile <path>]
 *   mcp install
 *   login | logout
 *   help | --help | -h
 *   version | --version | -v
 *
 * A "target" is: owner/repo, a GitHub URL, owner/repo@ref, or an npm package
 * name (resolved to its GitHub repo via the npm registry).
 */

import { runScanCommand } from "./commands/scan.js";
import { runWrapCommand, type Manager } from "./commands/wrap.js";
import { runMcpInstallCommand } from "./commands/mcp-install.js";
import {
  detectShell,
  installHooks,
  reloadHint,
  uninstallHooks,
  type Shell,
} from "./commands/hooks.js";
import { getReport } from "./lib/client.js";
import { clearToken, ensureLoggedIn, login, saveToken } from "./lib/auth.js";
import { loadConfig } from "./lib/env.js";
import {
  colorPalette,
  plainPalette,
  reportUrlFor,
  toJson,
  toText,
} from "./lib/format.js";
import { resolveTarget } from "./lib/resolve.js";

const VERSION = "0.1.0";

interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positionals: string[];
  /** Everything after a literal `--`, passed through untouched. */
  passthrough: string[];
}

/** Parse argv into flags/positionals. `--` ends option parsing (rest is passthrough). */
function parseArgs(argv: string[]): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const passthrough: string[] = [];
  let afterDashDash = false;
  const VALUE_FLAGS = new Set(["--ref", "--shell", "--profile", "--token"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterDashDash) {
      passthrough.push(a);
      continue;
    }
    if (a === "--") {
      afterDashDash = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (VALUE_FLAGS.has(a) && i + 1 < argv.length) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      // short flags: -h, -v (single-letter booleans)
      flags[a.slice(1)] = true;
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals, passthrough };
}

function wantsColor(flags: Record<string, string | boolean>): boolean {
  if (flags["no-color"] === true) return false;
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function normalizeShell(raw: string | boolean | undefined): Shell {
  if (raw === "bash" || raw === "zsh" || raw === "powershell") return raw;
  if (raw === "pwsh" || raw === "ps") return "powershell";
  return detectShell();
}

const HELP = `clauderabbit — scan a public GitHub repo or npm package for a 0-100 safety
score before you install or clone it. Requires a signed-in ClaudeRabbit account
(opens your browser the first time). Never states a bare "Safe".

USAGE
  clauderabbit <command> [options]

COMMANDS
  scan <target> [--json] [--ref <ref>]
      Run (or hit the cache for) a ClaudeRabbit fast-path scan and print the
      verdict. <target> is owner/repo, a GitHub URL, owner/repo@ref, or an npm
      package name (resolved to its GitHub repo via the npm registry).
      --json  Emit the documented machine-readable object (see README).

  report <target> [--json]
      Read an EXISTING cached report from ClaudeRabbit's public DB without
      triggering a new scan. Prints an honest "not found" if none exists.

  npm-install  <args...> [--yes] [--dry-run]
  pnpm-install <args...> [--yes] [--dry-run]
  git-clone    <args...> [--yes] [--dry-run]
      Scan the package/repo being fetched, print the honest verdict, then run
      the real command. Only a Trusted (>=90) verdict proceeds on a brief
      confirm; everything else prints the full hedge first. --yes proceeds
      non-interactively AFTER printing the verdict (never a silent green light);
      --dry-run scans and reports only.

  install-hooks   [--shell bash|zsh|powershell] [--profile <path>] [--print]
  uninstall-hooks [--shell ...] [--profile <path>]
      Add/remove opt-in shell functions that wrap npm/pnpm install and git
      clone. Coverage is intentionally scoped — see the README for exactly
      which invocation shapes are and are NOT wrapped. --print shows the block
      without writing it.

  mcp install
      Wire the ClaudeRabbit MCP server into Claude Desktop's
      claude_desktop_config.json — finds the real file (including Windows'
      MSIX/Store dual-path, not just the commonly-documented classic one)
      and appends the entry, leaving every other server/setting untouched.

  login [--token <token>]
      Sign in (opens your browser). Saved to ~/.clauderabbit/credentials.json
      and reused silently on every future run until \`logout\`. --token skips
      the browser and saves a token issued elsewhere (e.g. by the MCP
      server's sign-in link).
  logout
      Forget the saved sign-in.

  help | version

NOTES
  A scan runs the FAST PATH only (static scanners + reputation + a model read).
  It can DECIDE a repo should escalate to the dynamic sandbox without the
  sandbox having actually run. "Did the sandbox run" is reported honestly and
  keyed off a forensic record being present (sandboxActuallyRan in --json),
  never off the escalation flag alone.
`;

async function main(argv: string[]): Promise<number> {
  const { flags, positionals, passthrough } = parseArgs(argv);
  const command = positionals[0];

  if (!command || command === "help" || flags.help || flags.h) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "version" || flags.version || flags.v) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const color = wantsColor(flags);

  switch (command) {
    case "scan": {
      const target = positionals[1];
      if (!target) {
        process.stderr.write("scan: missing <target>. Try: clauderabbit scan owner/repo\n");
        return 1;
      }
      const outcome = await runScanCommand(target, {
        json: flags.json === true,
        ...(typeof flags.ref === "string" ? { ref: flags.ref } : {}),
        color,
        quiet: flags.quiet === true,
      });
      return outcome.exitCode;
    }

    case "report": {
      const target = positionals[1];
      if (!target) {
        process.stderr.write("report: missing <target>. Try: clauderabbit report owner/repo\n");
        return 1;
      }
      return runReportCommand(target, { json: flags.json === true, color });
    }

    case "npm-install":
    case "pnpm-install":
    case "git-clone": {
      const manager: Manager =
        command === "npm-install" ? "npm" : command === "pnpm-install" ? "pnpm" : "git";
      // Everything after the subcommand word (positionals[1..]) plus anything
      // after `--` are the args for the underlying tool.
      const args = [...positionals.slice(1), ...passthrough];
      const outcome = await runWrapCommand(manager, args, {
        color,
        yes: flags.yes === true || flags.y === true,
        dryRun: flags["dry-run"] === true,
      });
      return outcome.exitCode;
    }

    case "install-hooks": {
      const shell = normalizeShell(flags.shell);
      const res = installHooks(shell, {
        ...(typeof flags.profile === "string" ? { profile: flags.profile } : {}),
        print: flags.print === true,
      });
      process.stderr.write(`${res.message}\n`);
      if (res.action === "installed" || res.action === "updated") {
        process.stderr.write(`${reloadHint(shell, res.path)}\n`);
      }
      return 0;
    }

    case "uninstall-hooks": {
      const shell = normalizeShell(flags.shell);
      const res = uninstallHooks(shell, {
        ...(typeof flags.profile === "string" ? { profile: flags.profile } : {}),
      });
      process.stderr.write(`${res.message}\n`);
      return 0;
    }

    case "mcp": {
      const sub = positionals[1];
      if (sub !== "install") {
        process.stderr.write(
          `Unknown "mcp" subcommand "${sub ?? ""}". Try: clauderabbit mcp install\n`,
        );
        return 1;
      }
      const outcome = await runMcpInstallCommand();
      process.stderr.write(`${outcome.message}\n`);
      return outcome.exitCode;
    }

    case "login": {
      if (typeof flags.token === "string" && flags.token) {
        if (!flags.token.startsWith("cr_cli_")) {
          process.stderr.write("login: that doesn't look like a ClaudeRabbit token.\n");
          return 1;
        }
        saveToken(flags.token);
        process.stderr.write("Signed in.\n");
        return 0;
      }
      try {
        await login(loadConfig());
        process.stderr.write("Signed in.\n");
        return 0;
      } catch (err) {
        process.stderr.write(`Sign-in failed: ${(err as Error).message}\n`);
        return 1;
      }
    }

    case "logout": {
      const cleared = clearToken();
      process.stderr.write(cleared ? "Signed out.\n" : "Not signed in.\n");
      return 0;
    }

    default:
      process.stderr.write(`Unknown command "${command}". Run \`clauderabbit help\`.\n`);
      return 1;
  }
}

async function runReportCommand(
  rawTarget: string,
  opts: { json: boolean; color: boolean },
): Promise<number> {
  const config = loadConfig();
  const palette = opts.color ? colorPalette : plainPalette;

  // Require sign-in — reports are public data, but the CLI/MCP tools
  // themselves are gated (real product/access decision; see CLAUDE.md).
  try {
    await ensureLoggedIn(config);
  } catch (err) {
    const msg = `Sign-in failed: ${(err as Error).message}`;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: msg, target: rawTarget }, null, 2)}\n`);
    } else {
      process.stderr.write(`${palette.red("Error:")} ${msg}\n`);
    }
    return 1;
  }

  let resolved;
  try {
    resolved = await resolveTarget(rawTarget);
  } catch (err) {
    const msg = (err as Error).message;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: msg, target: rawTarget }, null, 2)}\n`);
    } else {
      process.stderr.write(`${palette.red("Error:")} ${msg}\n`);
    }
    return 1;
  }

  const result = await getReport(config, resolved.owner, resolved.repo);
  if (!result.ok) {
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          { error: result.error, notFound: result.notFound, target: `${resolved.owner}/${resolved.repo}` },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stderr.write(`${result.notFound ? "" : palette.red("Error: ")}${result.error}\n`);
    }
    return result.notFound ? 4 : 1;
  }

  if (opts.json) {
    const json = toJson(result.report, config.siteUrl, {
      fresh: false,
      resolvedVia: resolved.via,
      ...(resolved.npmPackage ? { npmPackage: resolved.npmPackage } : {}),
    });
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    process.stdout.write(
      toText(
        result.report,
        config.siteUrl,
        { fresh: false, resolvedVia: resolved.via, ...(resolved.npmPackage ? { npmPackage: resolved.npmPackage } : {}) },
        palette,
      ),
    );
    process.stderr.write(palette.dim(`\n(cached read — did not trigger a new scan; ${reportUrlFor(config.siteUrl, result.report)})\n`));
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    // Set exitCode rather than calling process.exit() so buffered stdout/stderr
    // flush and open handles close cleanly. Calling process.exit() mid-flush
    // can trip a libuv "handle closing" assertion on Windows.
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
    process.exitCode = 1;
  });
