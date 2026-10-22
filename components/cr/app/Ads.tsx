"use client";

/**
 * The scan page's ads, through Google Publisher Tag. Every unit comes from
 * lib/ads-config.ts (Google's published GPT sample units). Each slot is labelled
 * "Advertisement" and never gates a scan or a result.
 *
 * ScanAd is the design's 16:9 video slot. There is no video content on the page,
 * so a video ad here is a Standalone placement and must come through GPT, not
 * IMA (Google's video inventory policy). The slot asks for video-capable sizes;
 * a new ad starts when the previous video ends or after ADS.refreshMs (30 s),
 * never faster, and every refresh is declared to Ad Manager through the
 * ADS.refreshKey targeting key. When nothing fills, a banner (the house card)
 * shows. Fresh scans, stored scans and replays all show it the same way. Each
 * rendered impression is reported to /api/scan/ads.
 *
 * Interstitial is the GPT web interstitial, defined for the scan page's whole
 * life so it exists before Yes on the continue card is clicked; GPT shows it on
 * that same-site navigation (developers.google.com/publisher-tag/samples/display-web-interstitial-ad).
 */

import { useEffect, useRef, useState } from "react";
import { ADS } from "@/lib/ads-config";

type Gt = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type GptWindow = Window & { googletag?: Gt };

let gptLoading: Promise<void> | null = null;
function loadGpt(): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${ADS.gpt}"]`);
    if (existing) {
      if ((existing as HTMLScriptElement).dataset.loaded) resolve();
      else existing.addEventListener("load", () => resolve());
      return;
    }
    const el = document.createElement("script");
    el.src = ADS.gpt;
    el.async = true;
    el.onload = () => {
      el.dataset.loaded = "1";
      resolve();
    };
    el.onerror = () => reject(new Error("ad script blocked"));
    document.head.appendChild(el);
  });
}

function gpt(): Gt {
  const w = window as GptWindow;
  w.googletag = w.googletag || { cmd: [] };
  gptLoading ??= loadGpt();
  return w.googletag;
}

function reportImpression(runId: string, slot: string): void {
  try {
    void fetch("/api/scan/ads", { method: "POST", headers: { "content-type": "application/json", "x-clauderabbit-client": "web" }, body: JSON.stringify({ run_id: runId, slot }), keepalive: true });
  } catch {}
}

type SlotName = "video" | "banner_1" | "banner_2" | "banner_3";

/**
 * One GPT slot of the scan page, refreshed while mounted: the next ad starts when the
 * playing video ends or at ADS.refreshMs (30 s), never sooner. `startDelayMs`
 * staggers the slots evenly across the 30 s, so impressions arrive steadily.
 */
function useGptSlot(runId: string, slotName: SlotName, divId: string, sizes: { desktop: [number, number][]; phone: [number, number][] }, startDelayMs: number) {
  const [state, setState] = useState<"loading" | "showing" | "banner">("loading");
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let slot: Gt = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let listener: ((e: Gt) => void) | null = null;
    let endListener: ((e: MessageEvent) => void) | null = null;
    let refreshes = 0;
    let lastStart = 0;
    const gt0 = gpt();
    gptLoading!.catch(() => !cancelled && setState("banner"));
    const start = setTimeout(() => {
      gt0.cmd.push(() => {
        if (cancelled) return;
        const gt = (window as GptWindow).googletag;
        slot = gt.defineSlot(ADS.unit, [...sizes.desktop, ...sizes.phone], divId);
        if (!slot) return setState("banner");
        slot.defineSizeMapping(gt.sizeMapping().addSize([768, 0], sizes.desktop).addSize([0, 0], sizes.phone).build());
        slot.addService(gt.pubads()).setTargeting(ADS.refreshKey, "0").setTargeting("cr_slot", slotName);
        const next = () => {
          if (cancelled) return;
          const wait = Math.max(0, lastStart + ADS.refreshMs - Date.now());
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (cancelled) return;
            refreshes += 1;
            slot.setTargeting(ADS.refreshKey, String(refreshes));
            gt.pubads().refresh([slot]);
          }, wait);
        };
        listener = (e: Gt) => {
          if (cancelled || e.slot !== slot) return;
          if (e.isEmpty) setState("banner");
          else {
            setState("showing");
            setShown((n) => n + 1);
            reportImpression(runId, slotName);
          }
          lastStart = Date.now();
          next();
        };
        if (slotName === "video") {
          // A video creative that posts an "ended" message moves the next ad up to the floor.
          endListener = (m: MessageEvent) => {
            if (typeof m.data === "string" && /\b(ended|complete)\b/i.test(m.data) && /doubleclick|googlesyndication|google/.test(m.origin)) next();
          };
          window.addEventListener("message", endListener);
        }
        gt.pubads().addEventListener("slotRenderEnded", listener);
        gt.enableServices();
        gt.display(divId);
      });
    }, startDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(start);
      if (timer) clearTimeout(timer);
      if (endListener) window.removeEventListener("message", endListener);
      (window as GptWindow).googletag?.cmd.push(() => {
        const gt = (window as GptWindow).googletag;
        if (listener) gt.pubads().removeEventListener("slotRenderEnded", listener);
        if (slot) gt.destroySlots([slot]);
      });
    };
  }, [runId, slotName, divId, sizes, startDelayMs]);
  return { state, shown };
}

const slotDiv = (runId: string, name: string) => `cr-ad-${name}-${runId.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
const STAGGER_MS = ADS.refreshMs / ADS.slotCount;

function HouseBanner({ compact }: { compact?: boolean }) {
  return (
    <a href={ADS.houseCard.url} target="_blank" rel="noopener noreferrer sponsored" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 6, padding: compact ? "0 16px" : "24px 28px", color: "#F5F5F5", background: "#0A0A0A" }}>
      <span style={{ fontSize: compact ? 15 : 22, fontWeight: 600, letterSpacing: "-0.03em" }}>{ADS.houseCard.headline}</span>
      {!compact && <span style={{ fontSize: 15, lineHeight: 1.45, color: "#A8A8A8", maxWidth: 360 }}>{ADS.houseCard.body}</span>}
    </a>
  );
}

/** The scan screen's 16:9 video slot: GPT video-capable ads, one after another while mounted. */
export function ScanAd({ runId }: { runId: string }) {
  const divId = slotDiv(runId, "video");
  const { state, shown } = useGptSlot(runId, "video", divId, ADS.videoSizes, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-ad-slot="video" data-ads-shown={shown}>
      <span style={{ fontSize: 12, color: "var(--text2)" }}>{ADS.label}</span>
      <div style={{ aspectRatio: "16 / 9", borderRadius: 22, background: "#0A0A0A", color: "#F5F5F5", position: "relative", overflow: "hidden", display: "grid", placeItems: "center" }}>
        <div id={divId} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }} />
        {state === "loading" && <span style={{ position: "relative", fontSize: 13, color: "#A8A8A8", pointerEvents: "none" }}>Loading the ad</span>}
        {state === "banner" && <HouseBanner />}
      </div>
    </div>
  );
}

/**
 * A banner slot in an empty area of the scan screen (`n` 1 to 3), staggered after the
 * video slot. 300×250 on desktop; 320×50 on phones, which keeps the page's ad density
 * under the Better Ads limit of 30 % of its height.
 */
export function BannerAd({ runId, n }: { runId: string; n: 1 | 2 | 3 }) {
  const name = `banner_${n}` as SlotName;
  const divId = slotDiv(runId, name);
  const { state, shown } = useGptSlot(runId, name, divId, ADS.bannerSizes, n * STAGGER_MS);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    setPhone(mq.matches);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return (
    <div className="cr-banner-ad" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }} data-ad-slot={name} data-ads-shown={shown}>
      <span style={{ alignSelf: "flex-start", fontSize: 12, color: "var(--text2)" }}>{ADS.label}</span>
      <div style={{ position: "relative", overflow: "hidden", borderRadius: 12, display: "grid", placeItems: "center", ...(phone ? { width: 320, height: 50 } : { width: 300, height: 250 }) }}>
        <div id={divId} />
        {state === "banner" && <HouseBanner compact />}
      </div>
    </div>
  );
}

/** GPT web interstitial for the scan page, defined before any link on it is clicked. */
export function Interstitial({ runId }: { runId: string }) {
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  useEffect(() => {
    let slot: Gt = null;
    let cancelled = false;
    const gt0 = gpt();
    gt0.cmd.push(() => {
      if (cancelled) return;
      const gt = (window as GptWindow).googletag;
      slot = gt.defineOutOfPageSlot(ADS.interstitial, gt.enums.OutOfPageFormat.INTERSTITIAL);
      if (!slot) return; // GPT declines interstitials on pages it judges ineligible.
      slot.addService(gt.pubads());
      const onRender = (e: Gt) => {
        if (e.slot === slot && !e.isEmpty && runIdRef.current) reportImpression(runIdRef.current, "interstitial");
      };
      gt.pubads().addEventListener("slotRenderEnded", onRender);
      slot.setConfig?.({ interstitial: { triggers: { navBar: true, unhideWindow: true } } });
      gt.enableServices();
      gt.display(slot);
    });
    return () => {
      cancelled = true;
      (window as GptWindow).googletag?.cmd.push(() => {
        if (slot) (window as GptWindow).googletag.destroySlots([slot]);
      });
    };
  }, []);
  return null;
}
