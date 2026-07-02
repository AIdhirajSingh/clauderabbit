/**
 * `claude-rabbit install-hooks [--shell bash|zsh|powershell] [--print]`
 * `claude-rabbit uninstall-hooks [--shell ...]`
 *
 * Manages OPT-IN shell-profile integration that scans a package/repo before an
 * install/clone actually fetches it. This is honest about its real coverage
 * (README concern #2): shell functions can only wrap the exact invocation
 * SHAPES they recognize; they do NOT and cannot truly intercept every way
 * npm/pnpm/git can be driven (npx, corepack, workspaces, arbitrary lockfile
 * installs, subshells, other tools shelling out). See cli/README.md.
 *
 * We write a clearly delimited block between marker comments so uninstall can
 * remove exactly what we added and re-install is idempotent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type Shell = "bash" | "zsh" | "powershell";

const BEGIN = "# >>> claude-rabbit install-hooks >>>";
const END = "# <<< claude-rabbit install-hooks <<<";
const PS_BEGIN = "# >>> claude-rabbit install-hooks >>>";
const PS_END = "# <<< claude-rabbit install-hooks <<<";

/** POSIX (bash/zsh) shell functions that wrap npm, pnpm, and git. */
function posixBlock(): string {
  return `${BEGIN}
# Opt-in Claude Rabbit safety scan before install/clone.
# COVERAGE (honest — see the CLI README):
#   Wrapped: \`npm install/i/add <pkg>\`, \`pnpm install/i/add <pkg>\`,
#            \`git clone <url>\` — when a NEW package/repo target is present.
#   NOT wrapped (fall straight through, unscanned): bare \`npm install\`
#   (lockfile/package.json), \`npm ci\`, \`npx\`, \`corepack\`-spawned pnpm,
#   \`yarn\`, other tools that shell out, and any subshell/aliased path that
#   does not go through these functions. Removal: \`claude-rabbit uninstall-hooks\`.
if command -v claude-rabbit >/dev/null 2>&1; then
  npm() {
    case "$1" in
      install|i|add)
        claude-rabbit npm-install "$@" ;;
      *)
        command npm "$@" ;;
    esac
  }
  pnpm() {
    case "$1" in
      install|i|add)
        claude-rabbit pnpm-install "$@" ;;
      *)
        command pnpm "$@" ;;
    esac
  }
  git() {
    if [ "$1" = "clone" ]; then
      shift
      claude-rabbit git-clone "$@"
    else
      command git "$@"
    fi
  }
fi
${END}`;
}

/** PowerShell functions that wrap npm, pnpm, and git. */
function powershellBlock(): string {
  return `${PS_BEGIN}
# Opt-in Claude Rabbit safety scan before install/clone.
# COVERAGE (honest — see the CLI README):
#   Wrapped: \`npm install/i/add <pkg>\`, \`pnpm install/i/add <pkg>\`,
#            \`git clone <url>\` — when a NEW package/repo target is present.
#   NOT wrapped (fall straight through, unscanned): bare \`npm install\`,
#   \`npm ci\`, \`npx\`, \`corepack\`-spawned pnpm, \`yarn\`, other tools that
#   shell out. Removal: \`claude-rabbit uninstall-hooks\`.
if (Get-Command claude-rabbit -ErrorAction SilentlyContinue) {
  function npm {
    if ($args.Count -ge 1 -and @('install','i','add') -contains $args[0]) {
      claude-rabbit npm-install @args
    } else {
      npm.cmd @args
    }
  }
  function pnpm {
    if ($args.Count -ge 1 -and @('install','i','add') -contains $args[0]) {
      claude-rabbit pnpm-install @args
    } else {
      pnpm.cmd @args
    }
  }
  function git {
    if ($args.Count -ge 1 -and $args[0] -eq 'clone') {
      claude-rabbit git-clone @($args | Select-Object -Skip 1)
    } else {
      git.exe @args
    }
  }
}
${PS_END}`;
}

export function blockFor(shell: Shell): string {
  return shell === "powershell" ? powershellBlock() : posixBlock();
}

/** Default profile path for a given shell on this platform. */
export function profilePathFor(shell: Shell): string {
  const home = homedir();
  switch (shell) {
    case "bash":
      // ~/.bashrc is the interactive-shell rc on Linux; macOS often uses
      // ~/.bash_profile, but ~/.bashrc is the safest single default and the
      // most commonly sourced. Users can point elsewhere via --profile.
      return join(home, ".bashrc");
    case "zsh":
      return join(home, ".zshrc");
    case "powershell":
      // PowerShell 7+ profile location (cross-platform). On Windows this is
      // ~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1.
      return platform() === "win32"
        ? join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
        : join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
  }
}

/** Detect the most likely shell from the environment. */
export function detectShell(): Shell {
  if (process.env.PSModulePath && platform() === "win32") return "powershell";
  const sh = (process.env.SHELL ?? "").toLowerCase();
  if (sh.includes("zsh")) return "zsh";
  if (sh.includes("bash")) return "bash";
  if (platform() === "win32") return "powershell";
  return "bash";
}

function stripExistingBlock(content: string, begin: string, end: string): string {
  const startIdx = content.indexOf(begin);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(end, startIdx);
  if (endIdx === -1) return content; // malformed — leave it alone
  const after = content.slice(endIdx + end.length);
  const before = content.slice(0, startIdx);
  // Collapse the extra blank lines the block leaves behind.
  return `${before.replace(/\n+$/, "\n")}${after.replace(/^\n+/, "")}`;
}

export interface HookResult {
  path: string;
  action: "installed" | "updated" | "removed" | "absent" | "printed";
  message: string;
}

export function installHooks(
  shell: Shell,
  opts: { profile?: string; print?: boolean } = {},
): HookResult {
  const block = blockFor(shell);
  if (opts.print) {
    process.stdout.write(`${block}\n`);
    return {
      path: opts.profile ?? profilePathFor(shell),
      action: "printed",
      message: "Printed the hook block; nothing was written.",
    };
  }

  const path = opts.profile ?? profilePathFor(shell);
  const begin = shell === "powershell" ? PS_BEGIN : BEGIN;
  const end = shell === "powershell" ? PS_END : END;

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const already = existing.includes(begin);
  const cleaned = stripExistingBlock(existing, begin, end);
  const sep = cleaned.length && !cleaned.endsWith("\n") ? "\n" : "";
  const next = `${cleaned}${sep}${cleaned.length ? "\n" : ""}${block}\n`;
  writeFileSync(path, next, "utf8");

  return {
    path,
    action: already ? "updated" : "installed",
    message: already
      ? `Updated the Claude Rabbit hook block in ${path}.`
      : `Installed the Claude Rabbit hook block in ${path}.`,
  };
}

export function uninstallHooks(shell: Shell, opts: { profile?: string } = {}): HookResult {
  const path = opts.profile ?? profilePathFor(shell);
  const begin = shell === "powershell" ? PS_BEGIN : BEGIN;
  const end = shell === "powershell" ? PS_END : END;

  if (!existsSync(path)) {
    return { path, action: "absent", message: `No profile at ${path}; nothing to remove.` };
  }
  const existing = readFileSync(path, "utf8");
  if (!existing.includes(begin)) {
    return {
      path,
      action: "absent",
      message: `No Claude Rabbit hook block found in ${path}; nothing to remove.`,
    };
  }
  const cleaned = stripExistingBlock(existing, begin, end);
  writeFileSync(path, cleaned, "utf8");
  return { path, action: "removed", message: `Removed the Claude Rabbit hook block from ${path}.` };
}

/** Human-facing post-install reminder about re-sourcing the profile. */
export function reloadHint(shell: Shell, path: string): string {
  if (shell === "powershell") return `Restart PowerShell or run: . "${path}"`;
  return `Restart your shell or run: source "${path}"`;
}
