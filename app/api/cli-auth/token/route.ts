/**
 * POST /api/cli-auth/token: issue a `cr_cli_` login token to the signed-in
 * user of the /cli-auth page. The page sends its Supabase session JWT as a
 * bearer; the route checks it against the Auth server and calls
 * `v2.issue_cli_token` as cr_v2_server. The plaintext token is returned once
 * and stored only as its SHA-256 hash.
 */

import { v2Executor } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";
import { issueCliToken, sessionUser } from "@/lib/server/v2-auth";

export const runtime = "nodejs";
// Next to the v2 database (Supabase ap-south-1): every scan, cache and token query is one short hop.
export const preferredRegion = "bom1";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

export async function POST(req: Request): Promise<Response> {
  let config;
  let db;
  try {
    config = serverConfig();
    db = v2Executor(config);
  } catch {
    return Response.json({ error: "server_not_configured" }, { status: 503, headers: NO_STORE });
  }
  const userId = await sessionUser(db, config, req.headers.get("authorization"));
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    return Response.json({ token: await issueCliToken(db, userId) }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
