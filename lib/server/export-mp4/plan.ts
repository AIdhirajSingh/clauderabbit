/**
 * Pure helpers for the "Export MP4" scan replay job (no I/O, unit-tested).
 *
 * The job renders our own replay page (/app/scan/<runId>?replay=1&export=1)
 * in headless Chromium inside an E2B sandbox at 1280x720, 30 fps, and encodes
 * H.264 MP4 with ffmpeg, with a 2-second house ad card (lib/ads-config.ts
 * ADS.exportSponsor) burned in at the start and at the end.
 */

import { ADS } from "../../ads-config";
import { DEFAULT_FX, E2B_USD_PER_GIB_SECOND, E2B_USD_PER_VCPU_SECOND, roundUsd, type FxRate } from "../../engine/cost";

export const EXPORT_BUCKET = "v2-exports";
export const EXPORT_WIDTH = 1280;
export const EXPORT_HEIGHT = 720;
export const EXPORT_FPS = 30;
/** Each ad card is a full-frame 2-second card. */
export const AD_CARD_SECONDS = 2;
export const AD_CARD_FRAMES = AD_CARD_SECONDS * EXPORT_FPS;
/** Frames held on the final result after the replay reports done. */
export const HOLD_FRAMES = EXPORT_FPS * 2;
/** Hard cap on replay capture so the job fits the 300 s function budget. */
export const MAX_REPLAY_SECONDS = 60;
export const MAX_REPLAY_FRAMES = MAX_REPLAY_SECONDS * EXPORT_FPS;
/** Replay speed passed to the page (&speed=<n>). */
export const REPLAY_SPEED = 4;
/** A "rendering" row older than this is treated as a dead job and may be reclaimed. */
export const STALE_RENDER_MS = 6 * 60 * 1000;
/** Signed download links live one hour. */
export const SIGNED_URL_SECONDS = 3600;

/** Sandbox size the export template is built at (sandbox/e2b/export/template.ts). */
export const EXPORT_VCPU = 2;
export const EXPORT_MEMORY_MB = 2048;
export const EXPORT_TEMPLATE_DEFAULT = "cr-export";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRunId(v: string): boolean {
  return UUID_RE.test(v);
}

export function objectName(runId: string): string {
  if (!isRunId(runId)) throw new Error("invalid run id");
  return `${runId.toLowerCase()}.mp4`;
}

/** The replay page URL the sandbox loads. Only our own site origin, never a repo URL. */
export function replayUrl(siteOrigin: string, runId: string, speed = REPLAY_SPEED): string {
  if (!isRunId(runId)) throw new Error("invalid run id");
  const u = new URL(`/app/scan/${encodeURIComponent(runId.toLowerCase())}`, siteOrigin);
  u.searchParams.set("replay", "1");
  u.searchParams.set("export", "1");
  u.searchParams.set("speed", String(speed));
  return u.toString();
}

/**
 * Where the sandbox loads the replay page. On a Vercel Preview the page lives on
 * this deployment, not on NEXT_PUBLIC_SITE_URL (which is the production site), and
 * the deployment is protected, so the URL carries Vercel's automation bypass
 * (VERCEL_AUTOMATION_BYPASS_SECRET) and asks for the bypass cookie so the page's
 * own API calls pass too. The URL only goes into the export sandbox; it is never logged.
 */
export function exportPageUrl(siteOrigin: string, runId: string, env: Record<string, string | undefined> = process.env): string {
  const host = env.VERCEL_ENV === "preview" ? (env.VERCEL_BRANCH_URL || env.VERCEL_URL)?.trim() : undefined;
  const url = new URL(replayUrl(host ? `https://${host}` : siteOrigin, runId));
  const bypass = host ? env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() : undefined;
  if (bypass) {
    url.searchParams.set("x-vercel-protection-bypass", bypass);
    url.searchParams.set("x-vercel-set-bypass-cookie", "true");
  }
  return url.toString();
}

/** E2B price per second for the export sandbox size (rates from lib/engine/cost.ts). */
export function exportUsdPerSecond(vcpu = EXPORT_VCPU, memoryMb = EXPORT_MEMORY_MB): number {
  return roundUsd(vcpu * E2B_USD_PER_VCPU_SECOND + (memoryMb / 1024) * E2B_USD_PER_GIB_SECOND);
}

export interface ExportCost {
  sandbox_seconds: number;
  usd_per_second: number;
  usd: number;
  inr: number;
  fx: FxRate;
}

export function exportCost(sandboxSeconds: number, fx: FxRate = { ...DEFAULT_FX }, vcpu = EXPORT_VCPU, memoryMb = EXPORT_MEMORY_MB): ExportCost {
  const seconds = Math.max(0, Math.round(sandboxSeconds * 1000) / 1000);
  const perSecond = exportUsdPerSecond(vcpu, memoryMb);
  const usd = roundUsd(seconds * perSecond);
  return { sandbox_seconds: seconds, usd_per_second: perSecond, usd, inr: Math.round(usd * fx.usd_inr * 1e6) / 1e6, fx };
}

/**
 * Overall progress 0..100 from the job phase. Boot and tooling 0..10, the
 * replay capture 10..85 (by frames against the cap, so it never runs
 * backwards), encode finish 85..92, upload 92..99, done 100.
 */
export type ExportPhase = { phase: "boot" } | { phase: "capture"; frames: number } | { phase: "encode" } | { phase: "upload" } | { phase: "done" };

export function progressFor(p: ExportPhase): number {
  switch (p.phase) {
    case "boot":
      return 5;
    case "capture": {
      const f = Math.max(0, Math.min(MAX_REPLAY_FRAMES + HOLD_FRAMES, p.frames));
      return 10 + Math.floor((75 * f) / (MAX_REPLAY_FRAMES + HOLD_FRAMES));
    }
    case "encode":
      return 88;
    case "upload":
      return 95;
    case "done":
      return 100;
  }
}

/** Parse a guest progress line: "CR_PROGRESS <frames>". */
export function parseProgressLine(line: string): number | null {
  const m = /^CR_PROGRESS (\d{1,7})$/.exec(line.trim());
  return m ? Number(m[1]) : null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export interface SponsorCard {
  label: string;
  headline: string;
  body: string;
  url: string;
}

/** The full-frame ad card as a self-contained HTML page (no external requests). */
export function adCardHtml(sponsor: SponsorCard = ADS.exportSponsor, width = EXPORT_WIDTH, height = EXPORT_HEIGHT): string {
  const host = (() => {
    try {
      return new URL(sponsor.url).host;
    } catch {
      return sponsor.url;
    }
  })();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#0b0d10;color:#f2f4f7;
font-family:"Inter","Helvetica Neue",Helvetica,Arial,sans-serif}
.wrap{box-sizing:border-box;width:100%;height:100%;padding:72px 96px;display:flex;flex-direction:column;justify-content:space-between}
.label{align-self:flex-start;font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:#9aa4b2;border:1px solid #3a414c;border-radius:6px;padding:6px 12px}
.mid{display:flex;flex-direction:column;gap:24px}
.headline{font-size:76px;font-weight:700;line-height:1.05;letter-spacing:-.02em}
.body{font-size:30px;line-height:1.4;color:#c4cbd6;max-width:900px}
.url{font-size:26px;color:#7fb2ff}
.foot{display:flex;align-items:center;gap:16px}
.mark{width:44px;height:44px;border-radius:10px;background:#f2f4f7;color:#0b0d10;font-weight:800;font-size:24px;display:flex;align-items:center;justify-content:center}
.word{font-size:30px;font-weight:700;letter-spacing:-.01em}
</style></head><body><div class="wrap">
<div class="label">${esc(sponsor.label)}</div>
<div class="mid"><div class="headline">${esc(sponsor.headline)}</div><div class="body">${esc(sponsor.body)}</div><div class="url">${esc(host)}</div></div>
<div class="foot"><div class="mark">CR</div><div class="word">ClaudeRabbit</div></div>
</div></body></html>`;
}

export interface GuestJob {
  url: string;
  out: string;
  width: number;
  height: number;
  fps: number;
  ad_frames: number;
  hold_frames: number;
  max_replay_frames: number;
  /** When true the job fails if the page never sets window.__CR_REPLAY_DONE. */
  require_done: boolean;
  ad_html: string;
}

export function guestJob(url: string, out: string, opts: { requireDone?: boolean; maxReplayFrames?: number; sponsor?: SponsorCard } = {}): GuestJob {
  return {
    url,
    out,
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    fps: EXPORT_FPS,
    ad_frames: AD_CARD_FRAMES,
    hold_frames: HOLD_FRAMES,
    max_replay_frames: opts.maxReplayFrames ?? MAX_REPLAY_FRAMES,
    require_done: opts.requireDone ?? true,
    ad_html: adCardHtml(opts.sponsor),
  };
}

/** Bootstrap for a sandbox without the cr-export template: idempotent, root. */
export const GUEST_BOOTSTRAP = [
  "set -e",
  "if command -v ffmpeg >/dev/null 2>&1 && python3 -c 'import playwright' >/dev/null 2>&1; then echo CR_TOOLS_PRESENT; exit 0; fi",
  "export DEBIAN_FRONTEND=noninteractive",
  "apt-get update -qq",
  "apt-get install -y -qq --no-install-recommends ffmpeg python3-pip >/dev/null",
  "python3 -m pip install -q --break-system-packages playwright==1.55.0",
  "python3 -m playwright install --with-deps chromium-headless-shell >/dev/null",
  "echo CR_TOOLS_INSTALLED",
].join("\n");
