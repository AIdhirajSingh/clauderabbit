/**
 * GET /api/board?filter=<All|Malicious|High risk|Caution|Low risk>&offset=<n>
 * The danger board: one row per target, most dangerous first, paginated. After the
 * response, targets whose shown scan is under older scoring rules are rescanned in
 * the background (lib/server/board-refresh.ts), at most 5 scans running at once.
 */

import { after } from "next/server";
import { createV2Store } from "@/lib/engine/store";
import { executeScan, serverConfig } from "@/lib/server/scan-service";
import { refreshSlots, runningScans, staleBoardSubjects, targetForSubject } from "@/lib/server/board-refresh";
import { listBoard } from "@/lib/server/board-v2";
import { BOARD_FILTERS, type BoardFilter } from "@/lib/cr/verdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Background rescans run after the response, inside this invocation's lifetime.
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const f = url.searchParams.get("filter") ?? "all";
  const filter: BoardFilter = BOARD_FILTERS.some((x) => x.id === f) ? (f as BoardFilter) : "all";
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 && offsetRaw <= 100_000 ? offsetRaw : 0;
  try {
    const config = serverConfig();
    const store = createV2Store(config);
    const page = await listBoard(store.db, filter, offset);
    try {
      after(async () => {
        try {
          const slots = refreshSlots(await runningScans(store.db));
          if (slots === 0) return;
          const subjects = await staleBoardSubjects(store.db, undefined, slots);
          const ctx = { config, store, identity: null, caller: { surface: "web" as const, userId: null, ip: null, deviceId: null, operator: false } };
          await Promise.allSettled(
            subjects.map((s) => {
              const target = targetForSubject(s);
              return target ? executeScan(ctx, target, false, {}) : Promise.resolve(null);
            }),
          );
        } catch (err) {
          console.error("board refresh failed:", err instanceof Error ? err.message : err);
        }
      });
    } catch {
      // No request scope (direct handler calls in tests): no background refresh.
    }
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("board read failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "internal" }, { status: 503 });
  }
}
