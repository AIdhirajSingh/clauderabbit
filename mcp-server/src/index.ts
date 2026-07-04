#!/usr/bin/env node
/**
 * ClaudeRabbit MCP server — stdio entrypoint.
 *
 * Exposes one cache-aware tool that calls the REAL, deployed, public
 * ClaudeRabbit API (the same Supabase edge function + PostgREST route the
 * Next.js frontend uses) so any MCP-compatible AI coding tool can check a
 * public GitHub repo's safety score before installing or running it:
 *
 *   - scan(owner, repo, ref?) — returns the existing report immediately if
 *     one already exists for the current commit, otherwise runs a real
 *     fast-path scan and returns its result.
 *
 * No scanning or scoring logic lives here — this process is a pure client of
 * ClaudeRabbit's public API surface. See README.md for setup.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./env.js";
import { runScanTool, scanInputSchema, scanToolMeta } from "./tools/scan.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer({
    name: "clauderabbit-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    scanToolMeta.name,
    {
      title: scanToolMeta.title,
      description: scanToolMeta.description,
      inputSchema: scanInputSchema,
      annotations: scanToolMeta.annotations,
    },
    async (args) => runScanTool(config, args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // MCP stdio servers must never write to stdout outside the protocol frames;
  // stderr is safe for operator-facing diagnostics.
  console.error(
    `clauderabbit-mcp running on stdio (target: ${config.supabaseUrl})`,
  );
}

main().catch((err) => {
  console.error("clauderabbit-mcp failed to start:", err);
  process.exit(1);
});
