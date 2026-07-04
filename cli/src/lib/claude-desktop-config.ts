/**
 * Locating and safely editing Claude Desktop's `claude_desktop_config.json`.
 *
 * On Windows the file lives in one of two real places depending on how
 * Claude Desktop was installed, and only one of them is documented anywhere:
 *   - Classic installer: `%APPDATA%\Claude\claude_desktop_config.json`
 *   - MSIX / Microsoft Store install: the file lives inside the app's
 *     virtualized package folder, not %APPDATA% at all —
 *     `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\Claude\claude_desktop_config.json`,
 *     where <PackageFamilyName> (e.g. `Claude_pzs8sxrjxfjjc`) is a
 *     per-installation hash that differs machine to machine. Confirmed by
 *     inspecting a real MSIX install directly (Get-AppxPackage) rather than
 *     assuming the commonly-documented classic path is the only one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface ConfigLocation {
  path: string;
  /** How this path was found, for an honest confirmation message. */
  detected: "classic" | "default" | `msix:${string}`;
  /** Whether a file already existed there. */
  exists: boolean;
}

function classicPath(): string {
  switch (platform()) {
    case "win32":
      return join(
        process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    default:
      return join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "Claude",
        "claude_desktop_config.json",
      );
  }
}

/** Windows-only: MSIX/Store installs hide the real config under a per-install package folder. */
function findMsixConfigCandidates(): ConfigLocation[] {
  if (platform() !== "win32") return [];
  const packagesRoot = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Packages");
  if (!existsSync(packagesRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(packagesRoot).filter((name) => /^Claude_/i.test(name));
  } catch {
    return [];
  }

  return entries.map((name) => {
    const path = join(packagesRoot, name, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
    return { path, detected: `msix:${name}` as const, exists: existsSync(path) };
  });
}

/**
 * Find the real config file: prefer an EXISTING file (classic first, since
 * it's the common case) over a guessed default, and only offer to create a
 * brand-new file somewhere Claude Desktop actually appears to be installed.
 */
export function locateConfig(): ConfigLocation | null {
  const classic = classicPath();
  if (existsSync(classic)) {
    return { path: classic, detected: "classic", exists: true };
  }

  const msixCandidates = findMsixConfigCandidates();
  const existingMsix = msixCandidates.find((c) => c.exists);
  if (existingMsix) return existingMsix;

  // No config file anywhere yet — only create one where the app is
  // demonstrably installed already (its settings folder exists).
  if (existsSync(dirname(classic))) {
    return { path: classic, detected: "default", exists: false };
  }
  if (msixCandidates.length > 0) {
    return { path: msixCandidates[0].path, detected: msixCandidates[0].detected, exists: false };
  }
  return null;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MergeResult {
  config: Record<string, unknown>;
  removedLegacyKey: boolean;
  action: "installed" | "updated";
}

/** Key used by an earlier manual setup this session — migrated, not left orphaned. */
const LEGACY_KEY = "claude-rabbit";
const KEY = "clauderabbit";

/** Merge the clauderabbit MCP entry into an existing config, touching nothing else. */
export function mergeMcpServerEntry(existingRaw: string | null, entry: McpServerEntry): MergeResult {
  let config: Record<string, unknown> = {};
  if (existingRaw && existingRaw.trim()) {
    const parsed: unknown = JSON.parse(existingRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    } else {
      throw new Error("existing claude_desktop_config.json is not a JSON object");
    }
  }

  const mcpServers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  const removedLegacyKey = LEGACY_KEY in mcpServers;
  const action: MergeResult["action"] = KEY in mcpServers ? "updated" : "installed";
  delete mcpServers[LEGACY_KEY];
  mcpServers[KEY] = entry;

  config.mcpServers = mcpServers;
  return { config, removedLegacyKey, action };
}

export function readConfigIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function writeConfig(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
