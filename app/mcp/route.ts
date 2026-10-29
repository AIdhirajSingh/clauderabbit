/**
 * Remote MCP server over Streamable HTTP at `/mcp` for claude.ai custom
 * connectors (DESIGN.md section 8.2). Stateless: a fresh server and transport
 * per request. No sign-in: the endpoint answers without a token and publishes
 * no OAuth discovery, so a connector adds it with "No sign-in". A fresh scan
 * without an account is held to the anonymous limits (lib/engine/ratelimit.ts);
 * a `cr_cli_` bearer, when sent, still attaches its account. The `scan`
 * tool runs the same engine pipeline as `/api/scan` in-process with
 * `caller.surface = "mcp-remote"` and returns verdict, score, `not_verified`,
 * report URL and the ad as text.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { EngineError, type ScanTarget } from "@/lib/engine/types";
import { createV2Store, type V2Store } from "@/lib/engine/store";
import { finalLineStructured, finalLineText } from "@/lib/server/report-text";
import { invalidateReport } from "@/lib/server/report-cache";
import { adForSurface, callerFrom, executeScan, missingServerKeys, rateLimitFor, serverConfig, type FinalLine } from "@/lib/server/scan-service";
import { resolveMcpScanTarget, scanInputShape } from "./scan-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same ceiling as /api/scan: every scan runs the code in a fresh E2B sandbox in this request.
export const maxDuration = 300;

function buildServer(req: Request, store: V2Store): McpServer {
  const server = new McpServer({ name: "clauderabbit-mcp-remote", version: "2.0.0" });

  server.registerTool(
    "scan",
    {
      title: "Scan a GitHub repo or npm package with ClaudeRabbit",
      description:
        "Runs the package or repository in a throwaway sandbox (install hooks and entry point, all network calls answered by a forge) alongside static scanners, OSV malicious-package lookups and Jev model checks, then returns a deterministic 0-100 score, a verdict, the evidence split into behaviour, code and reputation, and what was not verified. Pass `owner` + `repo` for GitHub or `package` (optionally `version`) for npm; npm scans use the integrity-verified registry tarball that `npm install` fetches. A report for the same commit or artifact returns from cache. Never returns a bare \"Safe\".",
      inputSchema: scanInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const resolved = resolveMcpScanTarget(args);
      const config = serverConfig();
      if (!resolved.ok) {
        const ad = adForSurface(config, "mcp-remote", null);
        const final: FinalLine = { type: "error", code: "invalid_target", message: resolved.error, run_id: null, ad };
        return { isError: true as const, content: [{ type: "text" as const, text: finalLineText(final) }], structuredContent: finalLineStructured(final) };
      }
      const t = resolved.target;
      const target: ScanTarget = t.kind === "npm" ? { kind: "npm", name: t.package, ...(t.version ? { version: t.version } : {}) } : { kind: "github", owner: t.owner, repo: t.repo, ...(t.ref ? { ref: t.ref } : {}) };
      const ctx = await callerFrom(req.headers, "mcp-remote", null, config, store);
      let final: FinalLine;
      const rl = await rateLimitFor(ctx);
      if (rl && !rl.allowed) {
        final = { type: "error", code: "rate_limited", message: `too many scans from this source; retry in ${rl.retryAfter} s`, run_id: null, ad: adForSurface(config, "mcp-remote", target), retryAfter: rl.retryAfter };
      } else {
        try {
          final = await executeScan(ctx, target, false, { signal: req.signal, onPersisted: ({ ownerLogin, repoName }) => invalidateReport(ownerLogin, repoName) });
        } catch (err) {
          final = { type: "error", code: err instanceof EngineError ? err.code : "internal", message: err instanceof Error ? err.message.slice(0, 500) : "scan failed", run_id: null, ad: adForSurface(config, "mcp-remote", target) };
        }
      }
      return {
        ...(final.type === "error" ? { isError: true as const } : {}),
        content: [{ type: "text" as const, text: finalLineText(final) }],
        structuredContent: finalLineStructured(final),
      };
    },
  );

  return server;
}

function storeOrNull(): V2Store | null {
  try {
    const config = serverConfig();
    if (missingServerKeys(config).length > 0) return null;
    return createV2Store(config);
  } catch {
    return null;
  }
}

async function handle(req: Request): Promise<Response> {
  const store = storeOrNull();
  if (!store) return new Response(JSON.stringify({ error: "server_not_configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
  const server = buildServer(req, store);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — a fresh server+transport per request, safe for serverless
    enableJsonResponse: true, // plain JSON response; no long-lived SSE stream to keep alive in a serverless function
  });
  await server.connect(transport);

  let body: unknown;
  try {
    body = req.method === "POST" ? await req.json() : undefined;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // No explicit server.close() here: with enableJsonResponse the full response
  // body is already resolved by the time handleRequest returns (there is no
  // background stream left to tear down), and this is a stateless,
  // one-request-per-invocation serverless function anyway — the process
  // itself is recycled after the response is sent.
  return transport.handleRequest(req, body !== undefined ? { parsedBody: body } : undefined);
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: Request): Promise<Response> {
  return handle(req);
}

/** Protocol discovery: some clients HEAD the endpoint before ever POSTing. No sign-in is needed. */
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: storeOrNull() ? 200 : 503 });
}
