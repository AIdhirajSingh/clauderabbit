/**
 * GET /api/board?filter=<All|Malicious|High risk|Caution|Low risk>&offset=<n>
 * The danger board: every scan, score ascending then newest, paginated.
 */

import { createV2Store } from "@/lib/engine/store";
import { serverConfig } from "@/lib/server/scan-service";
import { listBoard } from "@/lib/server/board-v2";
import { BOARD_FILTERS, type BoardFilter } from "@/lib/cr/verdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const f = url.searchParams.get("filter") ?? "all";
  const filter: BoardFilter = BOARD_FILTERS.some((x) => x.id === f) ? (f as BoardFilter) : "all";
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 && offsetRaw <= 100_000 ? offsetRaw : 0;
  try {
    const store = createV2Store(serverConfig());
    const page = await listBoard(store.db, filter, offset);
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("board read failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "internal" }, { status: 503 });
  }
}
