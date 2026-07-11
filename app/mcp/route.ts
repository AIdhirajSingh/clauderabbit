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
import { resolveMcpScanTarget } from "./scan-target";

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
      title: "Scan a GitHub repo or npm package with ClaudeRabbit",
      description:
        "Returns a ClaudeRabbit 0-100 safety score and verdict for a public GitHub repo (pass `owner` + `repo`) or an npm package (pass `package`). For npm it scans the REAL published registry artifact — the exact tarball `npm install` fetches, integrity-verified — not the GitHub repo its package.json links to, so it catches a compromised publish that exists only in the tarball. Cache-aware: if a report already exists for the target's current commit/artifact it comes back immediately; otherwise a real fast-path scan runs. When the fast path decides a GitHub repo warrants the dynamic sandbox, this tool ALSO triggers the real detonation and waits for the sandbox-verified result — so `sandboxActuallyRan` is true and the score reflects what running the code actually did, not just the static read. A detonation that outlives the request budget returns `sandboxActuallyRan: false` with the run still finishing server-side (scan again shortly for the verified result). Never returns a bare \"Safe\" verdict.",
      inputSchema: {
        owner: z
          .string()
          .min(1)
          .optional()
          .describe('GitHub repository owner or org, e.g. "sindresorhus". Provide together with `repo` to scan a GitHub repository. Omit when scanning an npm package via `package`.'),
        repo: z
          .string()
          .min(1)
          .optional()
          .describe('GitHub repository name, e.g. "is". Required together with `owner` for a GitHub scan.'),
        ref: z
          .string()
          .min(1)
          .optional()
          .describe("Optional git ref (branch, tag, or commit SHA) to scan instead of the default branch. GitHub scans only."),
        package: z
          .string()
          .min(1)
          .optional()
          .describe('npm package to scan the REAL published registry artifact for (the tarball `npm install` actually fetches, not the repo its package.json links to). Provide this INSTEAD of owner/repo. Accepts a bare name ("left-pad"), a scoped name ("@scope/name"), an explicit "npm:left-pad@1.3.0", or an npmjs.com package URL.'),
        version: z
          .string()
          .min(1)
          .optional()
          .describe('Optional npm version or dist-tag (e.g. "1.3.0" or "latest") for the `package` scan; defaults to the latest published version. Ignored for GitHub scans. If `package` already carries a trailing @version, that wins.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const toolError = (text: string) => ({ isError: true as const, content: [{ type: "text" as const, text }] });

      // Resolve GitHub vs npm from the structured args (pure, unit-tested — see
      // scan-target.ts). An npm `package` takes precedence; otherwise owner+repo.
      const resolved = resolveMcpScanTarget(args);
      if (!resolved.ok) return toolError(resolved.error);
      const target = resolved.target;

      const scanArgs: Parameters<typeof runScan>[0] =
        target.kind === "npm"
          ? { ecosystem: "npm", package: target.package, ...(target.version ? { version: target.version } : {}), accessToken, clientKind: "mcp" }
          : { owner: target.owner, repo: target.repo, ref: target.ref, accessToken, clientKind: "mcp" };
      const reportUrl = `${siteOrigin(req)}/${target.reportPath}`;

      const result = await runScan(scanArgs);
      if (!result.ok) {
        return toolError(`ClaudeRabbit scan failed for ${target.label}: ${result.error}`);
      }

      // ESCALATION → REAL SANDBOX. GitHub targets only: the detonation clones
      // owner/repo@sha (npm-artifact detonation is a separate harness capability,
      // matching the stdio surface). When the fast path decided a live detonation
      // is warranted (`report.deep`) but the sandbox hasn't run (no `forensics`),
      // trigger the SAME production dispatch the website uses (`runDeepScan` → POST
      // `/api/deep`, Cloud Run REST via the cr-dispatch SA) and re-read the
      // sandbox-verified report — bounded by this route's maxDuration (the deep
      // wait self-resolves at ~270s inside /api/deep). npm escalations return the
      // escalation-decided report honestly (sandboxActuallyRan:false).
      let report = result.report;
      if (target.kind === "github" && report.deep && !report.forensics && report.commit_sha) {
        const { owner, repo } = target;
        const sha = report.commit_sha;
        const deep = await runDeepScan({ owner, repo, sha, baseUrl: siteOrigin(req) });
        if (deep.ok) {
          // Pin the re-read to the EXACT escalated commit (`ref: sha`, not a
          // ref-less default-branch re-resolve) and require the returned report's
          // commit_sha to match before accepting it — so a fast-moving repo's
          // default branch advancing mid-run can never substitute a fresh,
          // non-escalated scan of a newer commit as this run's result (a real bug
          // caught live and fixed across all three surfaces).
          const again = await runScan({ owner, repo, ref: sha, accessToken, clientKind: "mcp" });
          if (again.ok && again.report.commit_sha === sha) report = again.report;
        }
      }

      const view = buildReportView(report);
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
