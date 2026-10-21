/**
 * "Export MP4" of a scan replay. Server-only.
 *
 * The render never runs in the request path: POST /api/scan/<runId>/export
 * claims the run's row in v2.exports and hands `renderExport` to Next's
 * `after()`. The render runs in a fresh E2B sandbox (template `cr-export`,
 * CR_EXPORT_TEMPLATE overrides; a sandbox without the tools bootstraps them),
 * which loads ONLY our own replay page URL: no repo code ever enters it. The
 * sandbox is killed in `finally`. Progress, size, duration, render time and
 * cost (INR, E2B per-second price at the export size) land in v2.exports; the
 * MP4 goes to the private `v2-exports` bucket as `<runId>.mp4`, so each run
 * renders once.
 */

import { Sandbox } from "e2b";
import type { EngineConfig } from "./../engine/config";
import type { V2Store } from "./../engine/store";
import { RENDER_PY } from "./export-mp4/guest";
import {
  EXPORT_FPS,
  EXPORT_MEMORY_MB,
  EXPORT_TEMPLATE_DEFAULT,
  EXPORT_VCPU,
  GUEST_BOOTSTRAP,
  STALE_RENDER_MS,
  exportCost,
  guestJob,
  parseProgressLine,
  progressFor,
  replayUrl,
} from "./export-mp4/plan";
import { signedExportUrl, storageConfigFrom, uploadExport, type StorageConfig } from "./export-mp4/storage";

export interface ExportRow {
  run_id: string;
  status: "rendering" | "done" | "error";
  progress: number;
  bytes: number | null;
  seconds: number | null;
  render_ms: number | null;
  cost_inr: number | null;
  error: string | null;
  updated_at: string;
}

export type ExportResponse =
  | { status: "done"; url: string; bytes: number | null; seconds: number | null; render_ms: number | null; cost_inr: number | null }
  | { status: "rendering"; progress: number; label: string }
  | { status: "error"; error: string }
  | { status: "none" };

const SELECT_ROW = `select run_id::text as run_id, status, progress, bytes, seconds::float8 as seconds, render_ms,
  cost_inr::float8 as cost_inr, error, to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
  from v2.exports where run_id = $1::uuid`;

export async function loadExport(store: V2Store, runId: string): Promise<ExportRow | null> {
  const rows = await store.db.query<ExportRow>(SELECT_ROW, [runId]);
  return rows[0] ?? null;
}

/**
 * Claim the render for a run: insert a fresh row, or take over an errored or
 * stale one. False when another job is rendering it or it is already done.
 */
export async function claimExport(store: V2Store, runId: string): Promise<boolean> {
  const rows = await store.db.query<{ run_id: string }>(
    `insert into v2.exports (run_id, status, progress) values ($1::uuid, 'rendering', 0)
     on conflict (run_id) do update set status = 'rendering', progress = 0, error = null, bytes = null, seconds = null, render_ms = null, cost_inr = null
       where v2.exports.status = 'error'
          or (v2.exports.status = 'rendering' and v2.exports.updated_at < now() - make_interval(secs => $2::int))
     returning run_id::text as run_id`,
    [runId, Math.round(STALE_RENDER_MS / 1000)],
  );
  return rows.length === 1;
}

async function setProgress(store: V2Store, runId: string, progress: number): Promise<void> {
  await store.db.query("update v2.exports set progress = greatest(progress, $2::int) where run_id = $1::uuid and status = 'rendering'", [runId, progress]);
}

export function rendering(progress: number): ExportResponse {
  const p = Math.max(0, Math.min(99, Math.round(progress)));
  return { status: "rendering", progress: p, label: `Rendering ${p}%` };
}

/** The response for a row, signing a fresh 1-hour link when the MP4 is done. */
export async function responseFor(row: ExportRow | null, storage: StorageConfig, runId: string): Promise<ExportResponse> {
  if (!row) return { status: "none" };
  if (row.status === "rendering") return rendering(row.progress);
  if (row.status === "error") return { status: "error", error: row.error ?? "render failed" };
  const url = await signedExportUrl(storage, runId);
  if (!url) return { status: "error", error: "export file is missing from storage" };
  return { status: "done", url, bytes: row.bytes, seconds: row.seconds, render_ms: row.render_ms, cost_inr: row.cost_inr };
}

export function exportStorage(): StorageConfig | { missing: string[] } {
  return storageConfigFrom(process.env);
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Never echo anything key-shaped back into the row.
  return m.replace(/(sb_secret_|eyJ)[A-Za-z0-9._-]+/g, "[redacted]").slice(0, 300);
}

/**
 * The background render. Writes its outcome to v2.exports; never throws.
 * `pageOrigin` is our own site origin (config.siteUrl).
 */
export async function renderExport(store: V2Store, config: EngineConfig, storage: StorageConfig, runId: string, pageOrigin = config.siteUrl): Promise<void> {
  const started = Date.now();
  let sbx: Sandbox | null = null;
  let sandboxStarted = 0;
  let sandboxSeconds = 0;
  try {
    if (!config.e2bApiKey) throw new Error("server is missing required configuration: E2B_API_KEY");
    const template = process.env.CR_EXPORT_TEMPLATE?.trim() || EXPORT_TEMPLATE_DEFAULT;
    sandboxStarted = Date.now();
    sbx = await Sandbox.create(template, {
      apiKey: config.e2bApiKey,
      timeoutMs: 290_000,
      allowInternetAccess: true,
      metadata: { runId, purpose: "export-mp4" },
    });
    await setProgress(store, runId, progressFor({ phase: "boot" }));
    await sbx.commands.run(GUEST_BOOTSTRAP, { user: "root", timeoutMs: 150_000 });

    const out = "/opt/cr-export/out.mp4";
    const job = guestJob(replayUrl(pageOrigin, runId), out, { requireDone: true });
    await sbx.files.write("/opt/cr-export/render.py", RENDER_PY, { user: "root" });
    await sbx.files.write("/opt/cr-export/job.json", JSON.stringify(job), { user: "root" });

    let lastWrite = 0;
    let resultLine: string | null = null;
    let pending = "";
    const r = await sbx.commands.run("cd /opt/cr-export && python3 -I render.py job.json", {
      user: "root",
      timeoutMs: 200_000,
      onStdout: async (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("CR_RESULT ")) resultLine = line.slice("CR_RESULT ".length);
          const frames = parseProgressLine(line);
          if (frames !== null && Date.now() - lastWrite > 1500) {
            lastWrite = Date.now();
            await setProgress(store, runId, progressFor({ phase: "capture", frames })).catch(() => {});
          }
        }
      },
    });
    if (pending.startsWith("CR_RESULT ")) resultLine = pending.slice("CR_RESULT ".length);
    if (r.exitCode !== 0) throw new Error(`render exited ${r.exitCode}`);
    const result = resultLine ? (JSON.parse(resultLine) as { frames: number }) : null;
    if (!result || !Number.isInteger(result.frames) || result.frames <= 0) throw new Error("render produced no frames");

    await setProgress(store, runId, progressFor({ phase: "encode" }));
    const mp4 = await sbx.files.read(out, { user: "root", format: "bytes" });
    await sbx.kill().catch(() => {});
    sandboxSeconds = (Date.now() - sandboxStarted) / 1000;
    sbx = null;
    if (mp4.byteLength < 1024) throw new Error("render produced an empty file");

    await setProgress(store, runId, progressFor({ phase: "upload" }));
    await uploadExport(storage, runId, mp4);
    const cost = exportCost(sandboxSeconds, config.fx, EXPORT_VCPU, EXPORT_MEMORY_MB);
    await store.db.query(
      `update v2.exports set status = 'done', progress = 100, bytes = $2::int, seconds = $3::numeric, render_ms = $4::int, cost_inr = $5::numeric, error = null
        where run_id = $1::uuid`,
      [runId, mp4.byteLength, Math.round((result.frames / EXPORT_FPS) * 1000) / 1000, Date.now() - started, cost.inr],
    );
  } catch (e) {
    if (sbx) sandboxSeconds = (Date.now() - sandboxStarted) / 1000;
    const cost = sandboxStarted ? exportCost(sandboxSeconds, config.fx, EXPORT_VCPU, EXPORT_MEMORY_MB).inr : null;
    await store.db
      .query("update v2.exports set status = 'error', error = $2, render_ms = $3::int, cost_inr = $4::numeric where run_id = $1::uuid", [
        runId,
        errorText(e),
        Date.now() - started,
        cost,
      ])
      .catch(() => {});
  } finally {
    if (sbx) await sbx.kill().catch(() => {});
  }
}
