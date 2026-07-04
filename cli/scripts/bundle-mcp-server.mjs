#!/usr/bin/env node
/**
 * Copies the already-built mcp-server/dist/ into cli/dist/mcp-server/ so the
 * published `clauderabbit` package is self-contained: `clauderabbit mcp
 * install` needs a real, runnable MCP server entry point, and mcp-server/
 * itself is not published to npm as its own package. Run mcp-server's own
 * `npm run build` before this script (see cli/package.json's `build` script).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "mcp-server", "dist");
const dest = join(here, "..", "dist", "mcp-server");

if (!existsSync(src)) {
  console.error(
    `bundle-mcp-server: ${src} does not exist. Run "npm run build" in mcp-server/ first.`,
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`bundle-mcp-server: copied ${src} -> ${dest}`);
