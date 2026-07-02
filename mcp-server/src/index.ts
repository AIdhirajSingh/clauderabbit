#!/usr/bin/env node
/**
 * Claude Rabbit MCP server — stdio entrypoint.
 *
 * Exposes two tools that call the REAL, deployed, public Claude Rabbit API
 * (the same Supabase edge function + PostgREST route the Next.js frontend
 * uses) so any MCP-compatible AI coding tool can check a public GitHub repo's
 * safety score before installing or running it:
 *
 *   - scan_repo(owner, repo, ref?)  — trigger/hit-cache a fast-path scan.
 *   - get_report(owner, repo)       — read an existing cached report only.
 *
 * No scanning or scoring logic lives here — this process is a pure client of
 * Claude Rabbit's public API surface. See README.md for setup.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./env.js";
import { getReportInputSchema, getReportToolMeta, runGetReportTool } from "./tools/get-report.js";
import { runScanRepoTool, scanRepoInputSchema, scanRepoToolMeta } from "./tools/scan-repo.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer({
    name: "claude-rabbit-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    scanRepoToolMeta.name,
    {
      title: scanRepoToolMeta.title,
      description: scanRepoToolMeta.description,
      inputSchema: scanRepoInputSchema,
    },
    async (args) => runScanRepoTool(config, args),
  );

  server.registerTool(
    getReportToolMeta.name,
    {
      title: getReportToolMeta.title,
      description: getReportToolMeta.description,
      inputSchema: getReportInputSchema,
    },
    async (args) => runGetReportTool(config, args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // MCP stdio servers must never write to stdout outside the protocol frames;
  // stderr is safe for operator-facing diagnostics.
  console.error(
    `claude-rabbit-mcp running on stdio (target: ${config.supabaseUrl})`,
  );
}

main().catch((err) => {
  console.error("claude-rabbit-mcp failed to start:", err);
  process.exit(1);
});
