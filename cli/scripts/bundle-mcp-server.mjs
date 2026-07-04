#!/usr/bin/env node
/**
 * Builds mcp-server/ fresh (its own "build" script cleans its dist/ first —
 * see mcp-server/package.json — so no stale output from a deleted/renamed
 * source file can survive) and copies the result into cli/dist/mcp-server/,
 * so the published `clauderabbit` package is self-contained: `clauderabbit
 * mcp install` needs a real, runnable MCP server entry point, and
 * mcp-server/ itself is not published to npm as its own package.
 *
 * Deliberately does NOT trust a pre-existing mcp-server/dist/ — a stale one
 * (built before a source file was deleted, e.g. the old scan_repo/get_report
 * tools) was exactly how clauderabbit@0.1.1 shipped without this fix at all:
 * npm pack/publish only ran cli's own build, which just copied whatever was
 * already sitting in mcp-server/dist/ without verifying it was current.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerDir = join(here, "..", "..", "mcp-server");
const src = join(mcpServerDir, "dist");
const dest = join(here, "..", "dist", "mcp-server");

// On Windows, npm is a .cmd shim — spawning it directly (no shell) throws
// EINVAL, the same issue this project has hit before with npm/pnpm/git
// child processes; `shell: true` is required there. Node emits DEP0190
// whenever `shell: true` is combined with an args array, but the args here
// are fully static ("run", "build" — never user input), so there is no
// injection surface to close; silence just this one deprecation.
const useShell = process.platform === "win32";
if (useShell) {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.code === "DEP0190") return;
    console.error(`${warning.name}: ${warning.message}`);
  });
}
console.log(`bundle-mcp-server: building ${mcpServerDir} fresh…`);
const result = spawnSync("npm", ["run", "build"], { cwd: mcpServerDir, stdio: "inherit", shell: useShell });
if (result.status !== 0) {
  console.error(`bundle-mcp-server: mcp-server build failed (exit ${result.status}).`);
  process.exit(result.status ?? 1);
}

if (!existsSync(src)) {
  console.error(`bundle-mcp-server: ${src} still does not exist after building — aborting.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`bundle-mcp-server: copied ${src} -> ${dest}`);
