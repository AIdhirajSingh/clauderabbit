#!/usr/bin/env node
/**
 * clauderabbit — CLI entrypoint.
 *
 * Commands:
 *   scan <target> [--json] [--ref <r>] [--no-color]  (cache-aware: instant if
 *                                                     already scanned, else a
 *                                                     real scan runs)
 *   mcp install
 *   login | logout
 *   help | --help | -h
 *   version | --version | -v
 *
 * A "target" is: owner/repo, a GitHub URL, owner/repo@ref, or an npm package
 * name (resolved to its GitHub repo via the npm registry).
 *
 * An earlier opt-in shell-hook feature (`install-hooks`/`uninstall-hooks`,
 * `npm-install`/`pnpm-install`/`git-clone`) was built and then removed: it
 * scanned a package's linked GitHub repo, not the actual published registry
 * artifact, so it couldn't catch the exact attack an install-time check most
 * needs to (a compromised maintainer publishing a malicious version directly
 * to the registry). It will be planned and built properly against the real
 * published artifact, not shipped with that gap.
 */

import { runScanCommand } from "./commands/scan.js";
import { runMcpInstallCommand } from "./commands/mcp-install.js";
import { clearToken, login, saveToken } from "./lib/auth.js";
import { loadConfig } from "./lib/env.js";

const VERSION = "0.1.1";

interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** Parse argv into flags/positionals. */
function parseArgs(argv: string[]): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const VALUE_FLAGS = new Set(["--ref", "--token"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
  return { flags, positionals };
}

function wantsColor(flags: Record<string, string | boolean>): boolean {
  if (flags["no-color"] === true) return false;
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

const HELP =`clauderabbit — scan a public GitHub repo or npm package for a 0-100 safety
score before you install or clone it. Requires a signed-in ClaudeRabbit account
(opens your browser the first time). Never states a bare "Safe".

USAGE
  clauderabbit <command> [options]

COMMANDS
  scan <target> [--json] [--ref <ref>]
      Print a ClaudeRabbit verdict for <target> — owner/repo, a GitHub URL,
      owner/repo@ref, or an npm package name (resolved to its GitHub repo via
      the npm registry). Cache-aware: if the repo's current commit already
      has a report it comes back immediately; otherwise a real fast-path scan
      runs. You never need to choose which case applies.
      --json  Emit the documented machine-readable object (see README).

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
  const { flags, positionals } = parseArgs(argv);
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
