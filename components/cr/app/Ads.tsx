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

function reportImpression(runId: string): void {
  try {
    void fetch("/api/scan/ads", { method: "POST", headers: { "content-type": "application/json", "x-clauderabbit-client": "web" }, body: JSON.stringify({ run_id: runId }), keepalive: true });
  } catch {}
}

/** The scan screen's video slot: GPT video-capable ads, one after another while mounted. */
export function ScanAd({ runId }: { runId: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "showing" | "banner">("loading");
  const [shown, setShown] = useState(0);
  const divId = `cr-ad-${runId.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;

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
    gt0.cmd.push(() => {
      if (cancelled) return;
      const gt = (window as GptWindow).googletag;
      slot = gt.defineSlot(ADS.scanSlot.unit, ADS.scanSlot.sizes, divId);
      if (!slot) return setState("banner");
      slot.addService(gt.pubads()).setTargeting(ADS.refreshKey, "0");
      // Next ad: when the playing video ends, or at the refresh floor, never sooner.
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
        if (e.isEmpty) {
          setState("banner");
        } else {
          setState("showing");
          setShown((n) => n + 1);
          reportImpression(runId);
        }
        lastStart = Date.now();
        next();
      };
      // A video creative that posts an "ended" message moves the next ad up to the
      // refresh floor; without one the floor alone decides.
      endListener = (m: MessageEvent) => {
        if (typeof m.data === "string" && /\b(ended|complete)\b/i.test(m.data) && /doubleclick|googlesyndication|google/.test(m.origin)) next();
      };
      window.addEventListener("message", endListener);
      gt.pubads().addEventListener("slotRenderEnded", listener);
      gt.enableServices();
      gt.display(divId);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (endListener) window.removeEventListener("message", endListener);
      (window as GptWindow).googletag?.cmd.push(() => {
        const gt = (window as GptWindow).googletag;
        if (listener) gt.pubads().removeEventListener("slotRenderEnded", listener);
        if (slot) gt.destroySlots([slot]);
      });
    };
  }, [runId, divId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-ads-shown={shown}>
      <span style={{ fontSize: 12, color: "var(--text2)" }}>{ADS.label}</span>
      <div style={{ aspectRatio: "16 / 9", borderRadius: 22, background: "#0A0A0A", color: "#F5F5F5", position: "relative", overflow: "hidden", display: "grid", placeItems: "center" }}>
        <div id={divId} ref={box} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }} />
        {state === "loading" && <span style={{ position: "relative", fontSize: 13, color: "#A8A8A8", pointerEvents: "none" }}>Loading the ad</span>}
        {state === "banner" && (
          // No video filled: the banner shows.
          <a href={ADS.houseCard.url} target="_blank" rel="noopener noreferrer sponsored" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 8, padding: "24px 28px", color: "#F5F5F5", background: "#0A0A0A" }}>
            <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>{ADS.houseCard.headline}</span>
            <span style={{ fontSize: 15, lineHeight: 1.45, color: "#A8A8A8", maxWidth: 360 }}>{ADS.houseCard.body}</span>
          </a>
        )}
      </div>
    </div>
  );
}

/** GPT web interstitial for the scan page, defined before any link on it is clicked. */
export function Interstitial() {
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
