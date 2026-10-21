"use client";

/**
 * Ad slots for the scan page. Every ID comes from lib/ads-config.ts (Google's
 * published test IDs). Each slot is labelled "Advertisement". Ads never gate a
 * scan or a result.
 */

import { useEffect, useRef, useState } from "react";
import { ADS } from "@/lib/ads-config";

type ImaWindow = Window & { google?: { ima?: any } }; // eslint-disable-line @typescript-eslint/no-explicit-any

let imaLoading: Promise<void> | null = null;
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if ((existing as HTMLScriptElement).dataset.loaded) resolve();
      else existing.addEventListener("load", () => resolve());
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => {
      el.dataset.loaded = "1";
      resolve();
    };
    el.onerror = () => reject(new Error("ad script blocked"));
    document.head.appendChild(el);
  });
}

/** The video slot: Google's IMA SDK with the published sample VAST tag, muted autoplay. Remount (new `key`) to play it again. */
export function VideoAd({ playKey }: { playKey: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<"loading" | "playing" | "done" | "blocked">("loading");
  const [left, setLeft] = useState<number | null>(null);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let manager: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    let tick: ReturnType<typeof setInterval> | null = null;
    imaLoading ??= loadScript(ADS.imaSdk);
    imaLoading
      .then(() => {
        const ima = (window as ImaWindow).google?.ima;
        if (cancelled || !ima || !box.current || !video.current) return;
        const adc = new ima.AdDisplayContainer(box.current, video.current);
        adc.initialize();
        const loader = new ima.AdsLoader(adc);
        loader.addEventListener(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          if (cancelled) return;
          manager = e.getAdsManager(video.current);
          manager.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, () => setState("blocked"));
          manager.addEventListener(ima.AdEvent.Type.STARTED, () => {
            setState("playing");
            tick = setInterval(() => {
              const rem = manager?.getRemainingTime?.();
              const ad = manager?.getCurrentAd?.();
              const dur = ad?.getDuration?.();
              if (typeof rem === "number" && rem >= 0) setLeft(Math.ceil(rem));
              if (typeof rem === "number" && typeof dur === "number" && dur > 0) setPct(Math.min(100, ((dur - rem) / dur) * 100));
            }, 250);
          });
          manager.addEventListener(ima.AdEvent.Type.ALL_ADS_COMPLETED, () => {
            setState("done");
            setPct(100);
            if (tick) clearInterval(tick);
          });
          const w = box.current?.clientWidth ?? 640;
          const h = box.current?.clientHeight ?? 360;
          try {
            manager.init(w, h, ima.ViewMode.NORMAL);
            manager.setVolume(0);
            manager.start();
          } catch {
            setState("blocked");
          }
        });
        loader.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, () => !cancelled && setState("blocked"));
        const req = new ima.AdsRequest();
        req.adTagUrl = ADS.videoTag + Date.now();
        req.linearAdSlotWidth = box.current.clientWidth;
        req.linearAdSlotHeight = box.current.clientHeight;
        req.setAdWillAutoPlay(true);
        req.setAdWillPlayMuted(true);
        loader.requestAds(req);
      })
      .catch(() => !cancelled && setState("blocked"));
    return () => {
      cancelled = true;
      if (tick) clearInterval(tick);
      try {
        manager?.destroy();
      } catch {}
    };
  }, [playKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={{ fontSize: 12, color: "var(--text2)" }}>{ADS.label}</span>
      <div style={{ aspectRatio: "16 / 9", borderRadius: 22, background: "#0A0A0A", color: "#F5F5F5", position: "relative", overflow: "hidden", display: "grid", placeItems: "center" }}>
        <video ref={video} muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
        <div ref={box} style={{ position: "absolute", inset: 0 }} />
        {(state === "loading" || state === "done") && (
          <span style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, pointerEvents: "none" }}>
            <span style={{ width: 68, height: 68, borderRadius: "50%", background: "rgba(255,255,255,0.12)", display: "grid", placeItems: "center" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5l9 5.5-9 5.5z" fill="#F5F5F5" /></svg>
            </span>
            <span style={{ fontSize: 13, color: "#A8A8A8" }}>{state === "loading" ? "Loading the ad" : "Thanks for watching"}</span>
          </span>
        )}
        {state === "blocked" && (
          // No ad loaded: the house card fills the slot.
          <a href={ADS.houseCard.url} target="_blank" rel="noopener noreferrer sponsored" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 8, padding: "24px 28px", color: "#F5F5F5" }}>
            <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>{ADS.houseCard.headline}</span>
            <span style={{ fontSize: 15, lineHeight: 1.45, color: "#A8A8A8", maxWidth: 360 }}>{ADS.houseCard.body}</span>
          </a>
        )}
        {left !== null && state === "playing" && <span style={{ position: "absolute", right: 16, top: 14, fontSize: 13, color: "#A8A8A8", fontVariantNumeric: "tabular-nums", pointerEvents: "none" }}>{left} s</span>}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: "rgba(255,255,255,0.16)", pointerEvents: "none" }}><div style={{ height: "100%", background: "#F5F5F5", width: `${pct}%` }} /></div>
      </div>
    </div>
  );
}
