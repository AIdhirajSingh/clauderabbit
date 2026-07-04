/**
 * Live end-to-end smoke test — actually invokes this server's tool through a
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
import { runScanTool, scanInputSchema, scanToolMeta } from "../tools/scan.js";

async function buildServer() {
  const config = loadConfig();
  const server = new McpServer({ name: "claude-rabbit-mcp-smoke", version: "0.1.0" });

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
    `\nDiscovered ${tools.tools.length} tool(s): ${tools.tools.map((t) => t.name).join(", ")}`,
  );

  // 1. scan(sindresorhus/is) at the default ref — a tiny, extremely common,
  //    long-lived package almost certainly already scanned by someone.
  //    Proves the cache-hit path: `cached: true`, no scan re-run.
  const cachedResult = await client.callTool({
    name: "scan",
    arguments: { owner: "sindresorhus", repo: "is" },
  });
  printResult("scan(sindresorhus/is) [expect cache hit]", cachedResult);

  // 2. scan(sindresorhus/is) pinned to that repo's very FIRST commit — a real,
  //    valid ref (so the scan can succeed) that is virtually guaranteed to
  //    never have been scanned before (cache keys by commit SHA, and nobody
  //    scans a package's initial commit). Proves the real-fresh-scan path.
  const firstCommitSha = await fetchFirstCommitSha("sindresorhus", "is");
  console.log(`\nResolved sindresorhus/is's first commit for a guaranteed cache miss: ${firstCommitSha}`);
  const freshResult = await client.callTool({
    name: "scan",
    arguments: { owner: "sindresorhus", repo: "is", ref: firstCommitSha },
  });
  printResult(`scan(sindresorhus/is @ ${firstCommitSha.slice(0, 12)}) [expect a real fresh scan]`, freshResult);

  await client.close();
  await server.close();
}

/**
 * The oldest commit on a repo's default branch — a real ref nobody scans,
 * for a guaranteed cache miss. Standard GitHub pagination trick: a page=1
 * request's `Link` header names the last page (= total commit count, at
 * per_page=1); that last page's sole commit is the first one ever made.
 */
async function fetchFirstCommitSha(owner: string, repo: string): Promise<string> {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "clauderabbit-mcp-smoke-test" };
  const firstRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1&page=1`, {
    headers,
  });
  if (!firstRes.ok) throw new Error(`GitHub commits API returned HTTP ${firstRes.status} for ${owner}/${repo}`);
  const linkHeader = firstRes.headers.get("link") ?? "";
  const lastPageMatch = linkHeader.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);

  if (!lastPageMatch) {
    // No "last" link at all means there's only one page — i.e. exactly one
    // commit total — so page 1's own result IS the first commit.
    const commits = (await firstRes.json()) as Array<{ sha: string }>;
    const sha = commits[0]?.sha;
    if (!sha) throw new Error(`Could not resolve a first commit for ${owner}/${repo}`);
    return sha;
  }

  const lastPage = Number(lastPageMatch[1]);
  const lastRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1&page=${lastPage}`,
    { headers },
  );
  if (!lastRes.ok) throw new Error(`GitHub commits API returned HTTP ${lastRes.status} for ${owner}/${repo}`);
  const commits = (await lastRes.json()) as Array<{ sha: string }>;
  const sha = commits[0]?.sha;
  if (!sha) throw new Error(`Could not resolve a first commit for ${owner}/${repo}`);
  return sha;
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
