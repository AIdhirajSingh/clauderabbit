/**
 * The one scan event stream (DESIGN.md section 6).
 *
 * A run owns one `RunEventBus`. Every emitted event gets a strictly increasing
 * `seq` and a `t_ms` offset from the run start, is fanned out to live listeners
 * (the NDJSON response, an in-process MCP caller) immediately, and is queued for
 * batched persistence into `scan_events` (a database trigger broadcasts each row
 * on Realtime topic `scan:<run_id>`).
 *
 * Bounds: at most `maxEvents` events per run, live and persisted alike, so a
 * replay equals what the live client saw. The last slot is reserved for one
 * `check{name:"events_truncated"}` that carries the dropped counts. Transcript
 * text is chunked to 4 KiB per event and capped per source.
 */

import type { ScanEvent, ScanEventBody, ScanEventType, TranscriptSource } from "./types";

export const MAX_EVENTS_PER_RUN = 600;
export const TRANSCRIPT_CHUNK_BYTES = 4096;
export const TRANSCRIPT_BYTES_PER_SOURCE = 64 * 1024;
export const PERSIST_INTERVAL_MS = 250;

export interface EventSink {
  emit(e: ScanEventBody): void;
  flush(): Promise<void>;
}

export interface RunEventBusOptions {
  runId: string;
  startedAt: number;
  now: () => number;
  listeners?: Array<(e: ScanEvent) => void>;
  /** Batched persistence. Errors are reported through `onPersistError`, never thrown into emit. */
  persist?: (batch: ScanEvent[]) => Promise<void>;
  onPersistError?: (err: unknown) => void;
  persistIntervalMs?: number;
  maxEvents?: number;
}

export interface RunEventBus extends EventSink {
  readonly runId: string;
  transcript(source: TranscriptSource, stream: "stdout" | "stderr" | "model", text: string): void;
  /** Every event accepted so far, in seq order. */
  events(): ScanEvent[];
  /** Counts of events dropped past the cap, by type. */
  dropped(): Partial<Record<ScanEventType, number>>;
  /** Stop the persistence timer and write everything still queued. */
  close(): Promise<void>;
}

const encoder = new TextEncoder();

/** Split text into pieces of at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function chunkUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error("maxBytes must be at least 4");
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of text) {
    const b = encoder.encode(ch).length;
    if (currentBytes + b > maxBytes) {
      out.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += b;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function createRunEventBus(opts: RunEventBusOptions): RunEventBus {
  const maxEvents = opts.maxEvents ?? MAX_EVENTS_PER_RUN;
  if (maxEvents < 2) throw new Error("maxEvents must be at least 2");
  const listeners = opts.listeners ?? [];
  const accepted: ScanEvent[] = [];
  const queue: ScanEvent[] = [];
  const droppedCounts: Partial<Record<ScanEventType, number>> = {};
  const transcriptBytes = new Map<string, number>();
  let seq = 0;
  let truncationEmitted = false;
  let closed = false;
  let inflight: Promise<void> = Promise.resolve();

  const deliver = (e: ScanEvent) => {
    accepted.push(e);
    if (opts.persist) queue.push(e);
    for (const l of listeners) {
      try {
        l(e);
      } catch {
        // A failing listener (a closed HTTP stream) never stops the scan or other listeners.
      }
    }
  };

  const make = (body: ScanEventBody): ScanEvent => {
    seq += 1;
    const t = Math.max(0, Math.round(opts.now() - opts.startedAt));
    return { run_id: opts.runId, seq, t_ms: t, ...body } as ScanEvent;
  };

  const emitTruncation = () => {
    if (truncationEmitted) return;
    truncationEmitted = true;
    const parts = Object.entries(droppedCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    deliver(make({ type: "check", data: { name: "events_truncated", ok: false, detail: `dropped ${parts}` } }));
  };

  const emit = (body: ScanEventBody) => {
    if (closed) return;
    // Reserve the final slot for the truncation notice.
    if (accepted.length >= maxEvents - 1) {
      droppedCounts[body.type] = (droppedCounts[body.type] ?? 0) + 1;
      return;
    }
    deliver(make(body));
  };

  const writeQueued = async () => {
    if (!opts.persist || queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    try {
      await opts.persist(batch);
    } catch (err) {
      opts.onPersistError?.(err);
    }
  };

  const flush = (): Promise<void> => {
    inflight = inflight.then(writeQueued);
    return inflight;
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.persist) {
    timer = setInterval(() => {
      void flush();
    }, opts.persistIntervalMs ?? PERSIST_INTERVAL_MS);
    const t = timer as { unref?: () => void };
    t.unref?.();
  }

  return {
    runId: opts.runId,
    emit,
    flush,
    transcript(source, stream, text) {
      if (!text) return;
      const key = `${source}:${stream}`;
      const used = transcriptBytes.get(key) ?? 0;
      if (used >= TRANSCRIPT_BYTES_PER_SOURCE) return;
      const budget = TRANSCRIPT_BYTES_PER_SOURCE - used;
      let bytes = encoder.encode(text);
      let clipped = false;
      if (bytes.length > budget) {
        clipped = true;
        // Re-chunk to the remaining budget and keep only the first piece.
        text = chunkUtf8(text, budget)[0] ?? "";
        bytes = encoder.encode(text);
      }
      transcriptBytes.set(key, used + bytes.length);
      for (const piece of chunkUtf8(text, TRANSCRIPT_CHUNK_BYTES)) {
        emit({ type: "transcript", data: { source, stream, text: piece } });
      }
      if (clipped) {
        emit({
          type: "check",
          data: { name: "transcript_capped", ok: false, detail: `${key} exceeded ${TRANSCRIPT_BYTES_PER_SOURCE} bytes` },
        });
      }
    },
    events: () => accepted.slice(),
    dropped: () => ({ ...droppedCounts }),
    async close() {
      if (closed) return;
      if (Object.keys(droppedCounts).length > 0) emitTruncation();
      closed = true;
      if (timer) clearInterval(timer);
      await flush();
    },
  };
}

// NDJSON wire format (section 8.1).

export function ndjsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

export function eventLine(event: ScanEvent): string {
  return ndjsonLine({ type: "event", event });
}

/** Parse NDJSON text into values; a trailing partial line is returned as `rest`. */
export function splitNdjson(buffer: string): { values: unknown[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const values: unknown[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t) values.push(JSON.parse(t));
  }
  return { values, rest };
}
