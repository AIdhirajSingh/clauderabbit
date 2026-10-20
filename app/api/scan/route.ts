/**
 * POST /api/scan: the one scan endpoint for the web app, the CLI and the stdio
 * MCP server (DESIGN.md sections 6 and 8.1).
 *
 * Response is a stream of events then one final line. Default framing is
 * NDJSON (`application/x-ndjson`): `{"type":"event","event":ScanEvent}` lines,
 * then `{"type":"result",...,"ad"}` or `{"type":"error",...,"ad"}`. With
 * `Accept: text/event-stream` the same objects arrive as SSE `data:` frames.
 * The same events are stored per run and broadcast on Supabase Realtime topic
 * `scan:<run_id>` (see `realtimeChannel`). Every response, including pre-stream
 * errors, carries an ad. Ads never gate a scan or a result.
 */

import { after } from "next/server";
import { eventLine, ndjsonLine } from "@/lib/engine/events";
import { EngineError, type Ad, type ScanEvent } from "@/lib/engine/types";
import { createV2Store } from "@/lib/engine/store";
import { invalidateReport } from "@/lib/server/report-cache";
import {
  MAX_BODY_BYTES,
  adForRequest,
  adForSurface,
  callerFrom,
  executeScan,
  missingServerKeys,
  parseScanBody,
  rateLimitFor,
  realtimeChannel,
  serverConfig,
  statusFor,
  surfaceFromHeader,
  type FinalLine,
} from "@/lib/server/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
}

function preStreamError(code: FinalLine extends infer F ? (F extends { type: "error"; code: infer C } ? C : never) : never, message: string, ad: Ad, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ type: "error", error: code, code, message, run_id: null, ad, ...extra }, statusFor(code), headers);
}

export async function POST(req: Request): Promise<Response> {
  const surface = surfaceFromHeader(req.headers.get("x-clauderabbit-client"));
  let config;
  try {
    config = serverConfig();
  } catch (err) {
    return json({ type: "error", error: "internal", code: "internal", message: err instanceof Error ? err.message : "configuration error", run_id: null, ad: adForRequest(surface, null) }, 503);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return preStreamError("invalid_target", "request body is too large", adForSurface(config, surface, null));
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return preStreamError("invalid_target", "body must be JSON", adForSurface(config, surface, null));
  }
  const parsed = parseScanBody(body);
  if (!parsed.ok) return preStreamError("invalid_target", parsed.message, adForSurface(config, surface, null));
  const ad = adForSurface(config, surface, parsed.target);

  const missing = missingServerKeys(config);
  if (missing.length > 0) return preStreamError("internal", `server is missing required configuration: ${missing.join(", ")}`, ad);

  const store = createV2Store(config);
  const ctx = await callerFrom(req.headers, surface, parsed.deviceId, config, store);

  // CLI and stdio MCP require a signed-in ClaudeRabbit account; the web never does.
  if ((surface === "cli" || surface === "mcp") && !ctx.identity) {
    return preStreamError("unauthorized", "sign in first: run `clauderabbit login`", ad, { signInUrl: `${config.siteUrl}/cli-auth` });
  }
  if (parsed.target.kind === "tarball" && !ctx.caller.operator) return preStreamError("unauthorized", "tarball targets need the operator key", ad);

  const rl = await rateLimitFor(ctx);
  if (rl?.limiterError) console.error("scan rate limiter unavailable:", rl.limiterError);
  if (rl && !rl.allowed) {
    return preStreamError("rate_limited", `too many scans from this source; retry in ${rl.retryAfter} s`, ad, { retryAfter: rl.retryAfter }, { "Retry-After": String(rl.retryAfter) });
  }

  const regenerate = ctx.caller.operator && req.headers.get("x-cr-regenerate") === "1";
  const sse = (req.headers.get("accept") ?? "").includes("text/event-stream");
  const encoder = new TextEncoder();
  const frame = (line: string) => encoder.encode(sse ? `data: ${line.trimEnd()}\n\n` : line);

  // The rows of a fresh scan are written after its result line: the result goes
  // out the moment the report exists, and Next's after() (waitUntil on Vercel)
  // keeps this invocation alive until the persist task settles.
  const pending: Promise<void>[] = [];
  let background: ((task: Promise<void>) => void) | undefined;
  try {
    after(() => Promise.allSettled(pending));
    background = (task) => void pending.push(task);
  } catch {
    // No request scope (direct handler calls in tests): persist inline.
    background = undefined;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (line: string) => {
        if (!open) return;
        try {
          controller.enqueue(frame(line));
        } catch {
          open = false;
        }
      };
      // First byte at once: the scan's own events are held until its run is claimed.
      write(ndjsonLine({ type: "accepted", at: new Date().toISOString() }));
      const onEvent = (e: ScanEvent) => write(eventLine(e));
      let final: FinalLine;
      try {
        final = await executeScan(ctx, parsed.target, regenerate, {
          onEvent,
          signal: req.signal,
          background,
          onPersisted: ({ ownerLogin, repoName }) => invalidateReport(ownerLogin, repoName),
        });
      } catch (err) {
        const code = err instanceof EngineError ? err.code : "internal";
        final = { type: "error", code, message: err instanceof Error ? err.message.slice(0, 500) : "scan failed", run_id: null, ad };
      }
      write(ndjsonLine(final.type === "result" ? { ...final, realtime_channel: realtimeChannel(final.run_id) } : final));
      open = false;
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": sse ? "text/event-stream; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
