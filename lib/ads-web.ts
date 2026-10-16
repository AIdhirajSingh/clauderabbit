/**
 * The ad for a web surface that renders a result without a fresh API response
 * (the public report pages, a report reopened in the SPA). Same rules as the
 * API (lib/engine/ads.ts, DESIGN.md section 8.3): AdSense when
 * NEXT_PUBLIC_ADSENSE_CLIENT_ID and NEXT_PUBLIC_ADSENSE_SLOT_ID are set, with
 * `data-adtest="on"` unless NEXT_PUBLIC_ADSENSE_TEST=off; otherwise the house ad.
 * The env vars are referenced statically so Next inlines them in client code.
 */

import { adFor, type AdTarget } from "./engine/ads";
import type { Ad } from "./engine/types";

export function webAdsenseEnv(): { clientId: string | null; slotId: string | null; adtest: "on" | "off" } {
  const clientId = process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID?.trim() || null;
  const slotId = process.env.NEXT_PUBLIC_ADSENSE_SLOT_ID?.trim() || null;
  const adtest = process.env.NEXT_PUBLIC_ADSENSE_TEST?.trim().toLowerCase() === "off" ? "off" : "on";
  return { clientId, slotId, adtest };
}

export function webSiteUrl(): string {
  const v = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  try {
    return v ? new URL(v).origin : "https://clauderabbit.in";
  } catch {
    return "https://clauderabbit.in";
  }
}

export function webAdFor(target: AdTarget | null): Ad {
  return adFor("web", { siteUrl: webSiteUrl(), adsense: webAdsenseEnv(), target });
}
