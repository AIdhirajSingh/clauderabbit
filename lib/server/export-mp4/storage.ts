/**
 * Supabase Storage REST calls for the private `v2-exports` bucket. Server-only.
 *
 * 2.0's only database credential is the cr_v2_server Postgres login, which
 * cannot reach the Storage API, so uploads and signed links use the project's
 * server secret key from SUPABASE_SECRET_KEY (SUPABASE_SERVICE_ROLE_KEY as the
 * legacy name). The key is read here only, sent only to the project's own
 * Storage endpoint, and never logged; errors carry env var NAMES only.
 */

import { EXPORT_BUCKET, SIGNED_URL_SECONDS, objectName } from "./plan";

export const STORAGE_KEY_ENV_NAMES = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

export interface StorageConfig {
  supabaseUrl: string;
  key: string;
}

export function storageConfigFrom(env: Record<string, string | undefined>): StorageConfig | { missing: string[] } {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = STORAGE_KEY_ENV_NAMES.map((n) => env[n]?.trim()).find((v) => !!v);
  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!key) missing.push(STORAGE_KEY_ENV_NAMES.join(" or "));
  if (missing.length > 0 || !url || !key) return { missing };
  return { supabaseUrl: url.replace(/\/+$/, ""), key };
}

function headers(cfg: StorageConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: cfg.key, authorization: `Bearer ${cfg.key}`, ...extra };
}

export async function uploadExport(cfg: StorageConfig, runId: string, mp4: Uint8Array): Promise<void> {
  const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${EXPORT_BUCKET}/${objectName(runId)}`, {
    method: "POST",
    headers: headers(cfg, { "content-type": "video/mp4", "x-upsert": "true", "cache-control": "max-age=31536000" }),
    body: mp4.slice().buffer as ArrayBuffer,
  });
  if (!res.ok) throw new Error(`storage upload failed: HTTP ${res.status}`);
}

/** A 1-hour signed link to the run's MP4, or null when the object does not exist. */
export async function signedExportUrl(cfg: StorageConfig, runId: string, seconds = SIGNED_URL_SECONDS): Promise<string | null> {
  const name = objectName(runId);
  const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/sign/${EXPORT_BUCKET}/${name}`, {
    method: "POST",
    headers: headers(cfg, { "content-type": "application/json" }),
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`storage sign failed: HTTP ${res.status}`);
  const body = (await res.json()) as { signedURL?: string };
  if (typeof body.signedURL !== "string") return null;
  const u = new URL(`${cfg.supabaseUrl}/storage/v1${body.signedURL}`);
  u.searchParams.set("download", `clauderabbit-scan-${name}`);
  return u.toString();
}
