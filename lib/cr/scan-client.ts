"use client";

/**
 * The browser side of a scan. `startScan` POSTs /api/scan and reads the NDJSON
 * stream; the stream lives in this module so it survives the client-side move
 * from /app to /app/scan/<runId>. The scan page subscribes by run id; when no
 * live stream exists (a reload, a shared link, a dropped connection) it falls
 * back to the stored events plus Supabase Realtime, deduplicated by seq.
 */

import type { ReportPayload, ScanEvent } from "@/lib/engine/types";

export type FinalResult = { type: "result"; run_id: string; report: ReportPayload };
export type FinalError = { type: "error"; code: string; message: string; run_id: string | null; retryAfter?: number };

interface LiveScan {
  runId: string;
  events: ScanEvent[];
  /**
   * performance.now() when the stream delivered the first event, minus that
   * event's t_ms: the wall-clock origin the scan page plays events against, so
   * every scan plays at its recorded pace however fast its events arrive.
   */
  origin: number | null;
  final: FinalResult | FinalError | null;
  dropped: boolean;
  listeners: Set<() => void>;
}

const live = new Map<string, LiveScan>();

export function liveScan(runId: string): LiveScan | undefined {
  return live.get(runId);
}

export function subscribeLive(runId: string, fn: () => void): () => void {
  const s = live.get(runId);
  if (!s) return () => {};
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

function deviceId(): string | null {
  try {
    let id = localStorage.getItem("cr_device");
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem("cr_device", id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * Starts a scan. Resolves with the run id as soon as the server names it (the
 * first event, or the final line), or rejects with the
 * server's message.
 */
export async function startScan(target: string, accessToken: string | null, full = false): Promise<{ runId: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-clauderabbit-client": "web" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch("/api/scan", { method: "POST", headers, body: JSON.stringify({ target, deviceId: deviceId(), ...(full ? { full: true } : {}) }) });
  if (!res.ok || !res.body) {
    let msg = `Scan failed (${res.status}).`;
    try {
      const j = await res.json();
      if (typeof j?.message === "string") msg = j.message;
    } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let scan: LiveScan | null = null;
  const pending: ScanEvent[] = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (runId: string) => {
      if (settled) return;
      settled = true;
      resolve({ runId });
    };
    const emit = () => scan?.listeners.forEach((f) => f());
    const handle = (line: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "accepted") return;
      if (msg.type === "result" || msg.type === "error") {
        const final = msg as unknown as FinalResult | FinalError;
        const runId = final.run_id;
        if (!runId) {
          if (!settled) {
            settled = true;
            reject(new Error((final as FinalError).message || "Scan failed."));
          }
          return;
        }
        if (!scan) {
          scan = { runId, events: pending.splice(0), origin: null, final: null, dropped: false, listeners: new Set() };
          live.set(runId, scan);
        }
        scan.final = final;
        emit();
        settle(runId);
        return;
      }
      // Each event line is {"type":"event","event":<ScanEvent>} (lib/engine/events.ts eventLine).
      if (msg.type !== "event" || !msg.event || typeof msg.event !== "object") return;
      const ev = msg.event as ScanEvent;
      if (typeof ev.run_id !== "string" || typeof ev.seq !== "number") return;
      if (!scan) {
        scan = { runId: ev.run_id, events: [], origin: null, final: null, dropped: false, listeners: new Set() };
        live.set(ev.run_id, scan);
      }
      scan.origin ??= performance.now() - ev.t_ms;
      scan.events.push(ev);
      emit();
      settle(ev.run_id);
    };
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) handle(line);
          }
        }
        if (buf.trim()) handle(buf.trim());
      } catch {
        // The connection dropped: the page falls back to stored events + Realtime.
      }
      const s = scan as LiveScan | null;
      if (s && !s.final) {
        s.dropped = true;
        s.listeners.forEach((f) => f());
      }
      if (!settled) {
        settled = true;
        reject(new Error("The connection closed before the scan started. Try again."));
      }
    })();
  });
}
