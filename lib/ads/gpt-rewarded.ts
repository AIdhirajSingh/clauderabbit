/**
 * Web only: a Google Ad Manager rewarded ad shown while a live scan runs.
 *
 * Follows Google's GPT rewarded sample
 * (developers.google.com/publisher-tag/samples/display-rewarded-ad, source
 * github.com/googleads/google-publisher-tag-samples dist/display-rewarded-ad):
 * load gpt.js, `defineOutOfPageSlot(unit, OutOfPageFormat.REWARDED)` (null when
 * the page or device does not support rewarded ads), `rewardedSlotReady` ->
 * `makeRewardedVisible()`, `rewardedSlotGranted`, `rewardedSlotClosed` ->
 * `destroySlots`, and `slotRenderEnded` with `isEmpty` for no fill.
 *
 * The unit is Google's public sample unit unless NEXT_PUBLIC_GAM_REWARDED_AD_UNIT
 * names another valid unit path. This never gates, delays or awaits the scan:
 * `startScanRewardedAd` is fire-and-forget, every step is guarded, and a
 * blocked script, no fill, an unsupported page or a dismissed ad only logs.
 * The CLI and MCP never load this module (they carry our house ad from
 * lib/engine/ads.ts).
 */

export const GPT_SRC = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
export const GAM_SAMPLE_REWARDED_UNIT = "/22639388115/rewarded_web_example";
const UNIT_RE = /^\/\d{3,20}(\/[A-Za-z0-9_.\-]{1,100}){1,5}$/;
const SCRIPT_ID = "cr-gpt-js";

export type RewardedAdEvent =
  | "requested"
  | "unsupported"
  | "ready"
  | "visible"
  | "granted"
  | "video_completed"
  | "closed"
  | "empty"
  | "load_error"
  | "already_active"
  | "error";

/** Minimal GPT surface this module calls (types follow @types/google-publisher-tag). */
interface GptSlot {
  addService(s: GptPubAds): GptSlot;
}
interface GptEvent {
  slot: GptSlot;
  isEmpty?: boolean;
  makeRewardedVisible?: () => void;
  payload?: { amount: number; type: string } | null;
}
interface GptPubAds {
  addEventListener(name: string, fn: (e: GptEvent) => void): GptPubAds;
}
export interface GoogleTag {
  cmd: Array<() => void> | { push(fn: () => void): number };
  enums?: { OutOfPageFormat: { REWARDED: number } };
  defineOutOfPageSlot?(unit: string, format: number): GptSlot | null;
  pubads?(): GptPubAds;
  enableServices?(): void;
  display?(slot: GptSlot): void;
  destroySlots?(slots: GptSlot[]): boolean;
}

export interface RewardedHost {
  googletag?: GoogleTag;
  document: Pick<Document, "getElementById" | "createElement" | "head">;
}

export type RewardedLog = (event: RewardedAdEvent, detail?: Record<string, unknown>) => void;

const defaultLog: RewardedLog = (event, detail) => {
  try {
    console.info(`[cr-ads] gpt rewarded: ${event}`, detail ?? {});
  } catch {
    // Logging never throws into the scan path.
  }
};

/** The rewarded unit path: a valid NEXT_PUBLIC_GAM_REWARDED_AD_UNIT, else Google's public sample unit. */
export function rewardedAdUnit(env: string | undefined = process.env.NEXT_PUBLIC_GAM_REWARDED_AD_UNIT): string {
  const v = env?.trim();
  return v && UNIT_RE.test(v) ? v : GAM_SAMPLE_REWARDED_UNIT;
}

let active = false;
let current: GptSlot | null = null;
let listenersFor: GptPubAds | null = null;
let scriptFailed = false;

/** Test hook: forget the module state between cases. */
export function resetRewardedAdState(): void {
  active = false;
  current = null;
  listenersFor = null;
  scriptFailed = false;
}

function finish(tag: GoogleTag, log: RewardedLog): void {
  const slot = current;
  current = null;
  active = false;
  if (slot) {
    try {
      tag.destroySlots?.([slot]);
    } catch (err) {
      log("error", { step: "destroySlots", message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Request and show one rewarded ad for a web scan that just started. Returns
 * immediately; nothing the ad does can reach the scan.
 */
export function startScanRewardedAd(opts: { host?: RewardedHost; log?: RewardedLog; unit?: string } = {}): void {
  const log = opts.log ?? defaultLog;
  try {
    const host: RewardedHost | undefined = opts.host ?? (typeof window !== "undefined" ? (window as unknown as RewardedHost) : undefined);
    if (!host) return;
    if (scriptFailed) {
      log("load_error", { src: GPT_SRC });
      return;
    }
    if (active) {
      log("already_active");
      return;
    }
    active = true;
    const unit = opts.unit ?? rewardedAdUnit();

    if (!host.document.getElementById(SCRIPT_ID)) {
      const s = host.document.createElement("script");
      s.id = SCRIPT_ID;
      s.async = true;
      s.src = GPT_SRC;
      s.crossOrigin = "anonymous";
      s.onerror = () => {
        scriptFailed = true;
        active = false;
        current = null;
        log("load_error", { src: GPT_SRC });
      };
      host.document.head.appendChild(s);
    }

    host.googletag = host.googletag || { cmd: [] };
    const tag = host.googletag;
    tag.cmd.push(() => {
      try {
        const formats = tag.enums?.OutOfPageFormat;
        const slot = formats && tag.defineOutOfPageSlot ? tag.defineOutOfPageSlot(unit, formats.REWARDED) : null;
        if (!slot || !tag.pubads) {
          active = false;
          log("unsupported", { unit });
          return;
        }
        const pubads = tag.pubads();
        current = slot;
        slot.addService(pubads);
        if (listenersFor !== pubads) {
          listenersFor = pubads;
          pubads.addEventListener("rewardedSlotReady", (e) => {
            if (e.slot !== current) return;
            log("ready", { unit });
            try {
              e.makeRewardedVisible?.();
              log("visible", { unit });
            } catch (err) {
              log("error", { step: "makeRewardedVisible", message: err instanceof Error ? err.message : String(err) });
              finish(tag, log);
            }
          });
          pubads.addEventListener("rewardedSlotGranted", (e) => {
            if (e.slot !== current) return;
            log("granted", { payload: e.payload ?? null });
          });
          pubads.addEventListener("rewardedSlotVideoCompleted", (e) => {
            if (e.slot !== current) return;
            log("video_completed");
          });
          pubads.addEventListener("rewardedSlotClosed", (e) => {
            if (e.slot !== current) return;
            log("closed");
            finish(tag, log);
          });
          pubads.addEventListener("slotRenderEnded", (e) => {
            if (e.slot !== current || !e.isEmpty) return;
            log("empty", { unit });
            finish(tag, log);
          });
        }
        tag.enableServices?.();
        tag.display?.(slot);
        log("requested", { unit });
      } catch (err) {
        active = false;
        current = null;
        log("error", { step: "define", message: err instanceof Error ? err.message : String(err) });
      }
    });
  } catch (err) {
    active = false;
    log("error", { step: "start", message: err instanceof Error ? err.message : String(err) });
  }
}
