"use client";

/**
 * The scan screen's ad slot, through Google Publisher Tag. Every unit comes from
 * lib/ads-config.ts (Google's published GPT sample units). The slot is labelled
 * "Advertisement" and never gates a scan or a result.
 *
 * The slot is a standalone display placement (no video player, no video
 * content), refreshed every ADS.refreshMs while the scan screen is open, so one
 * ad follows another until the result opens; fresh scans, stored scans and
 * replays all show it the same way. The page also defines a GPT web
 * interstitial, which GPT shows on the next same-site navigation. Each rendered
 * impression is reported to /api/scan/ads for the scan's unit economics.
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

function reportImpression(runId: string): void {
  try {
    void fetch("/api/scan/ads", { method: "POST", headers: { "content-type": "application/json", "x-clauderabbit-client": "web" }, body: JSON.stringify({ run_id: runId }), keepalive: true });
  } catch {}
}

/** The scan screen's ad slot: GPT display ads, back to back while mounted. */
export function ScanAd({ runId }: { runId: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "showing" | "blocked">("loading");
  const [shown, setShown] = useState(0);
  const divId = `cr-ad-${runId.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;

  useEffect(() => {
    let cancelled = false;
    let slot: Gt = null;
    let inter: Gt = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let listener: ((e: Gt) => void) | null = null;
    const w = window as GptWindow;
    w.googletag = w.googletag || { cmd: [] };
    gptLoading ??= loadGpt();
    gptLoading.catch(() => !cancelled && setState("blocked"));
    w.googletag.cmd.push(() => {
      if (cancelled) return;
      const gt = w.googletag;
      slot = gt.defineSlot(ADS.scanSlot.unit, ADS.scanSlot.sizes, divId);
      if (!slot) return setState("blocked");
      slot.addService(gt.pubads());
      inter = gt.defineOutOfPageSlot(ADS.interstitial, gt.enums.OutOfPageFormat.INTERSTITIAL);
      if (inter) inter.addService(gt.pubads());
      listener = (e: Gt) => {
        if (cancelled || e.slot !== slot) return;
        if (e.isEmpty) return setState((s) => (s === "showing" ? s : "blocked"));
        setState("showing");
        setShown((n) => n + 1);
        reportImpression(runId);
      };
      gt.pubads().addEventListener("slotRenderEnded", listener);
      gt.enableServices();
      gt.display(divId);
      if (inter) gt.display(inter);
      timer = setInterval(() => !cancelled && gt.pubads().refresh([slot]), ADS.refreshMs);
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      w.googletag?.cmd.push(() => {
        const gt = w.googletag;
        if (listener) gt.pubads().removeEventListener("slotRenderEnded", listener);
        gt.destroySlots([slot, inter].filter(Boolean));
      });
    };
  }, [runId, divId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-ads-shown={shown}>
      <span style={{ fontSize: 12, color: "var(--text2)" }}>{ADS.label}</span>
      <div style={{ minHeight: 280, borderRadius: 22, background: "var(--surface2, #0A0A0A)", position: "relative", overflow: "hidden", display: "grid", placeItems: "center" }}>
        <div id={divId} ref={box} style={{ minWidth: 300, minHeight: 250 }} />
        {state === "loading" && <span style={{ position: "absolute", fontSize: 13, color: "#A8A8A8", pointerEvents: "none" }}>Loading the ad</span>}
        {state === "blocked" && (
          // No ad loaded: the house card fills the slot.
          <a href={ADS.houseCard.url} target="_blank" rel="noopener noreferrer sponsored" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 8, padding: "24px 28px", color: "#F5F5F5", background: "#0A0A0A" }}>
            <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>{ADS.houseCard.headline}</span>
            <span style={{ fontSize: 15, lineHeight: 1.45, color: "#A8A8A8", maxWidth: 360 }}>{ADS.houseCard.body}</span>
          </a>
        )}
      </div>
    </div>
  );
}
