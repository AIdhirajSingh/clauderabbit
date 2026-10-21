/**
 * POST /api/scan/<runId>/export  start (or reuse) the MP4 export of a finished run.
 * GET  /api/scan/<runId>/export  current state.
 *
 * Responses (JSON):
 *   { status: "done", url, bytes, seconds, render_ms, cost_inr }   url: signed, 1 hour
 *   { status: "rendering", progress, label: "Rendering N%" }
 *   { status: "error", error }                                       POST retries an errored export
 *   { status: "none" }                                               GET only: never requested
 *   { error: "invalid_run" | "not_found" | "not_done" | "internal", message }  4xx / 503
 *
 * The render runs after the response via `after()` inside an E2B sandbox
 * (lib/server/export-mp4.ts), never in the request path. One render per run.
 */

import { after } from "next/server";
import { createV2Store } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";
import { claimExport, exportStorage, loadExport, renderExport, rendering, responseFor } from "@/lib/server/export-mp4";
import { isRunId } from "@/lib/server/export-mp4/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ runId: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

function fail(error: string, message: string, status: number): Response {
  return Response.json({ error, message }, { status, headers: NO_STORE });
}

async function setup(ctx: Ctx) {
  const { runId: raw } = await ctx.params;
  if (!isRunId(raw)) return { ok: false, res: fail("invalid_run", "run id must be a UUID", 400) } as const;
  const runId = raw.toLowerCase();
  const storage = exportStorage();
  if ("missing" in storage) return { ok: false, res: fail("internal", `server is missing required configuration: ${storage.missing.join(", ")}`, 503) } as const;
  let config, store;
  try {
    config = serverConfig();
    store = createV2Store(config);
  } catch (err) {
    return { ok: false, res: fail("internal", err instanceof Error ? err.message : "configuration error", 503) } as const;
  }
  const run = await store.loadRun(runId);
  if (!run) return { ok: false, res: fail("not_found", "no scan run with that id", 404) } as const;
  if (run.status !== "done") return { ok: false, res: fail("not_done", "the scan has not finished", 409) } as const;
  return { ok: true, runId, storage, config, store } as const;
}

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const s = await setup(ctx);
  if (!s.ok) return s.res;
  try {
    return Response.json(await responseFor(await loadExport(s.store, s.runId), s.storage, s.runId), { headers: NO_STORE });
  } catch (err) {
    return fail("internal", err instanceof Error ? err.message : "export lookup failed", 503);
  }
}

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const s = await setup(ctx);
  if (!s.ok) return s.res;
  try {
    if (await claimExport(s.store, s.runId)) {
      const { store, config, storage, runId } = s;
      after(() => renderExport(store, config, storage, runId));
      return Response.json(rendering(0), { status: 202, headers: NO_STORE });
    }
    return Response.json(await responseFor(await loadExport(s.store, s.runId), s.storage, s.runId), { headers: NO_STORE });
  } catch (err) {
    return fail("internal", err instanceof Error ? err.message : "export start failed", 503);
  }
}
