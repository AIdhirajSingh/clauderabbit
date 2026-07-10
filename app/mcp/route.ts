/**
 * /mcp — the remote (Streamable HTTP) MCP server, for claude.ai custom
 * connectors and any other HTTP-capable MCP client. The stdio server
 * (`mcp-server/`) is for local tools that can read `~/.clauderabbit/` and
 * launch a browser; this one runs on Vercel with neither, so it needs real
 * OAuth (see app/oauth/, app/.well-known/) instead — see CLAUDE.md and the
 * `20260704000002_oauth_for_remote_mcp.sql` migration for why.
 *
 * The tool logic itself is NOT reimplemented here: `runScan` (lib/scan.ts)
 * and `buildReportView` (lib/report-view.ts) are the exact same functions
 * the SSR report page and the SPA already use — this route is a thin
 * MCP-shaped wrapper around them. One cache-aware tool (`scan`): `runScan`
 * itself already returns the existing report instantly when one exists for
 * the current commit, or runs a real scan otherwise, so there's nothing a
 * second "read-only" tool would add.
 *
 * Path is domain-portable by construction: everything below is relative
 * (`req.url`'s origin, via `siteOrigin()`), so the endpoint is just
 * `<domain>/mcp` — it moved from the placeholder `*.vercel.app` domain to
 * the real `clauderabbit.in` with no code change.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { runScan, runDeepScan } from "@/lib/scan";
import { buildReportView } from "@/lib/report-view";
import { formatReportText, structuredReport } from "./format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long enough to actually run + await a live sandbox detonation (the deep path
// self-resolves at ~270s inside /api/deep), not just the fast path.
export const maxDuration = 300;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

function siteOrigin(req: Request): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || new URL(req.url).origin;
}

/** Verify a `cr_cli_...` bearer token via the same RPC the scan function uses. */
async function verifyToken(token: string): Promise<string | null> {
  if (!token.startsWith("cr_cli_") || !SUPABASE_URL || !SUPABASE_KEY) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("verify_cli_token", { p_token: token });
  if (error || typeof data !== "string") return null;
  return data;
}

function unauthorized(req: Request): Response {
  const origin = siteOrigin(req);
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
}

function buildServer(accessToken: string, req: Request): McpServer {
  const server = new McpServer({ name: "clauderabbit-mcp-remote", version: "0.1.0" });

  server.registerTool(
    "scan",
    {
      title: "Scan a GitHub repo with ClaudeRabbit",
      description:
        "Returns a ClaudeRabbit 0-100 safety score and verdict for a public GitHub repo. Cache-aware: if a report already exists for the repo's current commit it comes back immediately; otherwise a real fast-path scan runs. When the fast path decides the repo warrants the dynamic sandbox, this tool ALSO triggers the real detonation and waits for the sandbox-verified result — so `sandboxActuallyRan` is true and the score reflects what running the code actually did, not just the static read. A detonation that outlives the request budget returns `sandboxActuallyRan: false` with the run still finishing server-side (scan again shortly for the verified result). Never returns a bare \"Safe\" verdict.",
      inputSchema: {
        owner: z.string().min(1).describe('GitHub repository owner or org, e.g. "sindresorhus".'),
        repo: z.string().min(1).describe('GitHub repository name, e.g. "is".'),
        ref: z.string().min(1).optional().describe("Optional git ref (branch, tag, or commit SHA)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const owner = args.owner.trim();
      const repo = args.repo.trim();
      const result = await runScan({
        owner,
        repo,
        ref: args.ref,
        accessToken,
        clientKind: "mcp",
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `ClaudeRabbit scan failed for ${owner}/${repo}: ${result.error}` }],
        };
      }

      // ESCALATION → REAL SANDBOX. When the fast path decided a live detonation is
      // warranted (`report.deep`) but the sandbox hasn't run (no `forensics`),
      // trigger the SAME production dispatch the website uses (`runDeepScan` →
      // POST `/api/deep`, Cloud Run REST via the cr-dispatch SA) and re-read the
      // sandbox-verified report — so the MCP result carries the real runtime score,
      // not the scarier static-only interim. Bounded by this route's maxDuration
      // (the deep wait self-resolves at ~270s inside /api/deep); if the run is
      // still going at the deadline, the report stays honestly escalation-decided
      // (`sandboxActuallyRan:false`) and the detonation finishes server-side (a
      // follow-up scan returns the verified result from cache).
      let report = result.report;
      if (report.deep && !report.forensics && report.commit_sha) {
        const sha = report.commit_sha;
        const deep = await runDeepScan({ owner, repo, sha, baseUrl: siteOrigin(req) });
        if (deep.ok) {
          // Pin the re-read to the EXACT escalated commit (`ref: sha`, not the
          // caller's original — often ref-less — `args.ref`), and require the
          // returned report's commit_sha to match before accepting it. Without
          // this, a fast-moving repo's default branch advancing between the
          // escalation and this re-read would return a FRESH, non-escalated scan
          // of a NEWER commit — the tool would then report "static read only" for
          // a commit that was never even the one just detonated, contradicting
          // the sandbox run it had just triggered (a real bug, caught live).
          const again = await runScan({ owner, repo, ref: sha, accessToken, clientKind: "mcp" });
          if (again.ok && again.report.commit_sha === sha) report = again.report;
        }
      }

      const view = buildReportView(report);
      const reportUrl = `${siteOrigin(req)}/${owner}/${repo}`;
      const fresh = !result.report.cached;
      const text = formatReportText(view, reportUrl, fresh);
      const structured = structuredReport(view, reportUrl, fresh);
      return {
        content: [
          { type: "text" as const, text },
          { type: "text" as const, text: `\n<structured-data>${JSON.stringify(structured)}</structured-data>` },
        ],
        structuredContent: structured,
      };
    },
  );

  return server;
}

async function handle(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  const userId = token ? await verifyToken(token) : null;
  if (!userId || !token) return unauthorized(req);

  const server = buildServer(token, req);
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

/** Protocol discovery: some clients HEAD the endpoint before ever POSTing. */
export async function HEAD(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  const userId = token ? await verifyToken(token) : null;
  if (!userId) return unauthorized(req);
  return new Response(null, { status: 200 });
}
