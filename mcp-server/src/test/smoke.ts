/**
 * Live end-to-end smoke test — actually invokes this server's tools through a
 * real MCP `Client`/`Server` pair (linked in-memory transport, same code path
 * as stdio) against the REAL deployed ClaudeRabbit Supabase project. Not a
 * mock: every HTTP call goes out over the network to the real API.
 *
 * Run with: npm run build && npm run test:smoke
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../env.js";
import { getReportInputSchema, getReportToolMeta, runGetReportTool } from "../tools/get-report.js";
import { runScanRepoTool, scanRepoInputSchema, scanRepoToolMeta } from "../tools/scan-repo.js";

async function buildServer() {
  const config = loadConfig();
  const server = new McpServer({ name: "claude-rabbit-mcp-smoke", version: "0.1.0" });

  server.registerTool(
    scanRepoToolMeta.name,
    { title: scanRepoToolMeta.title, description: scanRepoToolMeta.description, inputSchema: scanRepoInputSchema },
    async (args) => runScanRepoTool(config, args),
  );
  server.registerTool(
    getReportToolMeta.name,
    { title: getReportToolMeta.title, description: getReportToolMeta.description, inputSchema: getReportInputSchema },
    async (args) => runGetReportTool(config, args),
  );

  return { server, config };
}

function printResult(label: string, result: unknown): void {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const { server, config } = await buildServer();
  console.log(`Target Supabase project: ${config.supabaseUrl}`);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke-test-client", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  console.log(
    `\nDiscovered ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`,
  );

  // 1. get_report against a repo very likely to already have a cached report
  //    (a tiny, extremely common, long-lived package). Exercises the pure
  //    PostgREST read path with no scan triggered.
  const getReportResult = await client.callTool({
    name: "get_report",
    arguments: { owner: "sindresorhus", repo: "is" },
  });
  printResult("get_report(sindresorhus/is)", getReportResult);

  // 2. scan_repo against a small, real, public repo — exercises the live
  //    edge-function call end-to-end (cache hit or fresh NDJSON stream,
  //    whichever the deployed project actually returns).
  const scanResult = await client.callTool({
    name: "scan_repo",
    arguments: { owner: "sindresorhus", repo: "is" },
  });
  printResult("scan_repo(sindresorhus/is)", scanResult);

  // 3. get_report against a repo that (almost certainly) has never been
  //    scanned, to prove the honest not-found path (no fabricated data).
  const notFoundOwner = `cr-mcp-smoke-test-${Date.now()}`;
  const notFoundResult = await client.callTool({
    name: "get_report",
    arguments: { owner: notFoundOwner, repo: "does-not-exist" },
  });
  printResult(`get_report(${notFoundOwner}/does-not-exist) [expect not found]`, notFoundResult);

  await client.close();
  await server.close();
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
