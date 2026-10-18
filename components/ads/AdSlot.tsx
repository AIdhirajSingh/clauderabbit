"use client";

/**
 * Renders the ad payload that comes with every scan result (DESIGN.md section
 * 8.3). AdSense: the documented `<ins class="adsbygoogle">` unit with
 * `data-adtest` from the payload ("on" unless NEXT_PUBLIC_ADSENSE_TEST=off),
 * and the adsbygoogle.js script loaded only when NEXT_PUBLIC_ADSENSE_CLIENT_ID
 * is set. House: ClaudeRabbit's own labelled offer. Ads never gate a result.
 */

import Script from "next/script";
import { useEffect, useRef } from "react";
import type { Ad } from "@/lib/engine/types";
import { pageNonce } from "@/lib/ads/gpt-rewarded";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

const ADSENSE_CLIENT_ENV = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID?.trim() || "";

export function AdSlot({ ad }: { ad: Ad }) {
  const pushed = useRef(false);
  const isAdsense = ad.kind === "adsense" && ADSENSE_CLIENT_ENV.length > 0 && ad.client === ADSENSE_CLIENT_ENV;

  useEffect(() => {
    if (!isAdsense || pushed.current) return;
    pushed.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // A blocked or failed ad script never affects the report.
    }
  }, [isAdsense]);

  if (ad.kind === "adsense") {
    if (!isAdsense) return null;
    return (
      <aside aria-label="Advertisement" data-testid="ad-slot" style={{ margin: "32px auto 0", maxWidth: 728, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "var(--t6)", marginBottom: 6 }}>Advertisement</div>
        <Script
          id="adsbygoogle-js"
          async
          strategy="afterInteractive"
          crossOrigin="anonymous"
          nonce={typeof document === "undefined" ? undefined : (pageNonce(document) ?? undefined)}
          src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ad.client)}`}
        />
        <ins
          className="adsbygoogle"
          style={{ display: "block" }}
          data-ad-client={ad.client}
          data-ad-slot={ad.slot}
          data-ad-format={ad.format}
          data-adtest={ad.adtest}
        />
      </aside>
    );
  }

  return (
    <aside aria-label="Sponsored" data-testid="ad-slot" style={{ margin: "32px auto 0", maxWidth: 560, padding: "14px 18px", border: "1px solid var(--line, rgba(127,127,127,.25))", borderRadius: 12, fontSize: 13, color: "var(--t3)" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--t6)", marginBottom: 6 }}>{ad.label}</div>
      <a href={ad.url} style={{ color: "inherit", textDecoration: "none" }}>
        <strong style={{ display: "block", color: "var(--t1)", marginBottom: 4 }}>{ad.headline}</strong>
        <span>{ad.body}</span>
      </a>
    </aside>
  );
}
