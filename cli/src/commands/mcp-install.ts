/**
 * `clauderabbit mcp install`
 *
 * Wires the ClaudeRabbit MCP server (mcp-server/, stdio transport) into
 * Claude Desktop's claude_desktop_config.json for real: finds the actual
 * config file (handling Windows' MSIX dual-path — see
 * lib/claude-desktop-config.ts), merges in the entry without touching
 * anything else already in the file, and carries the server's real
 * filesystem location via an environment variable rather than a literal
 * path baked into "args" (see LOADER_SCRIPT below).
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  locateConfig,
  mergeMcpServerEntry,
  readConfigIfExists,
  writeConfig,
} from "../lib/claude-desktop-config.js";

export interface McpInstallOutcome {
  exitCode: number;
  message: string;
}

/**
 * mcp-server/ isn't published to npm as its own package, so its built output
 * is bundled directly into this package at build time instead (see
 * scripts/bundle-mcp-server.mjs and the "build" script in package.json) —
 * cli/dist/mcp-server/index.js. Resolved relative to THIS file's own
 * compiled location (cli/dist/commands/mcp-install.js is always one level
 * below cli/dist/), so it works from a real `npm install -g clauderabbit`,
 * not just a full repo checkout.
 */
function resolveMcpServerEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "mcp-server", "index.js");
}

/**
 * A `node -e` snippet that imports whatever path CLAUDE_RABBIT_MCP_SERVER_ENTRY
 * names at spawn time. This is the "environment variable instead of a
 * hardcoded path in args" requirement: the real, machine-specific full path
 * to the server lives in the config entry's "env", never as a literal in
 * "args" itself. pathToFileURL handles Windows drive letters/spaces safely.
 */
const LOADER_SCRIPT =
  "import(require('url').pathToFileURL(process.env.CLAUDE_RABBIT_MCP_SERVER_ENTRY).href)" +
  ".catch((e) => { console.error(e); process.exit(1); })";

export async function runMcpInstallCommand(): Promise<McpInstallOutcome> {
  const entry = resolveMcpServerEntry();
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    return {
      exitCode: 1,
      message:
        `Could not find the built MCP server at ${entry}.\n` +
        "Run `npm run build` in mcp-server/ first, then re-run `clauderabbit mcp install`.",
    };
  }

  const location = locateConfig();
  if (!location) {
    return {
      exitCode: 1,
      message:
        "Could not find a Claude Desktop installation on this machine (checked the classic " +
        "%APPDATA%\\Claude\\ path and, on Windows, %LOCALAPPDATA%\\Packages\\Claude_*\\ for an " +
        "MSIX/Store install). Install Claude Desktop first, then re-run this command.",
    };
  }

  let existingRaw: string | null;
  try {
    existingRaw = readConfigIfExists(location.path);
  } catch (err) {
    return { exitCode: 1, message: `Could not read ${location.path}: ${(err as Error).message}` };
  }

  let merged;
  try {
    merged = mergeMcpServerEntry(existingRaw, {
      command: "node",
      args: ["-e", LOADER_SCRIPT],
      env: { CLAUDE_RABBIT_MCP_SERVER_ENTRY: entry },
    });
  } catch (err) {
    return {
      exitCode: 1,
      message:
        `${location.path} exists but isn't valid JSON (${(err as Error).message}); not touching it. ` +
        "Fix or remove it manually, then re-run this command.",
    };
  }

  writeConfig(location.path, merged.config);

  const detectedDesc =
    location.detected === "classic"
      ? "classic install path"
      : location.detected === "default"
        ? "classic install path — new file"
        : `MSIX/Store install, package ${location.detected.slice("msix:".length)}`;

  const lines = [
    `Found Claude Desktop config at ${location.path} (${detectedDesc}).`,
    `${merged.action === "updated" ? "Updated" : "Added"} the "clauderabbit" MCP server entry — every ` +
      "other server and setting already in the file was left untouched.",
    ...(merged.removedLegacyKey
      ? ['Removed the older "claude-rabbit" entry from an earlier manual setup, replaced by "clauderabbit".']
      : []),
    "Restart Claude Desktop for this to take effect.",
  ];

  return { exitCode: 0, message: lines.join("\n") };
}
