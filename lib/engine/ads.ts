/**
 * Ad payloads (DESIGN.md section 8.3). Every scan response carries one. Ads never
 * gate a scan or a result.
 *
 * Web: an AdSense unit when NEXT_PUBLIC_ADSENSE_CLIENT_ID and
 * NEXT_PUBLIC_ADSENSE_SLOT_ID are set (`adtest` "on" unless
 * NEXT_PUBLIC_ADSENSE_TEST=off), otherwise the house ad.
 * CLI, stdio MCP and remote MCP: the house ad, ClaudeRabbit's own badge offer
 * for the scanned target.
 */

import type { AdsenseConfig } from "./config";
import type { Ad, Surface } from "./types";

export interface AdTarget {
  kind: "github" | "npm" | "tarball";
  /** `owner/repo` for GitHub, the package name for npm, the label for a tarball. */
  name: string;
}

const CLIENT_RE = /^ca-pub-\d{10,20}$/;
const SLOT_RE = /^\d{6,20}$/;

/** Badge URL for a target; the badge route serves `/badge/<owner>/<repo>` (npm uses owner `npm`). */
export function badgeUrl(siteUrl: string, target: AdTarget): string {
  const origin = new URL(siteUrl).origin;
  if (target.kind === "github") {
    const [owner, repo] = target.name.split("/");
    return `${origin}/badge/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`;
  }
  if (target.kind === "npm") return `${origin}/badge/npm/${encodeURIComponent(target.name)}`;
  return `${origin}/`;
}

export function houseAd(siteUrl: string, target: AdTarget | null): Ad {
  if (target && target.kind !== "tarball") {
    return {
      kind: "house",
      placement: "scan_result",
      id: "house-badge-v1",
      label: "Sponsored",
      headline: `Show this scan on ${target.name}`,
      body: "Add the ClaudeRabbit badge to your README so users see the latest scan result and what it did not verify.",
      url: badgeUrl(siteUrl, target),
    };
  }
  return {
    kind: "house",
    placement: "scan_result",
    id: "house-scan-v1",
    label: "Sponsored",
    headline: "Scan a dependency before you install it",
    body: "Paste any public GitHub repo or npm package into ClaudeRabbit. It runs the code in a throwaway sandbox and reports what it did.",
    url: new URL(siteUrl).origin + "/",
  };
}

export function adsenseAd(cfg: AdsenseConfig): Ad | null {
  if (!cfg.clientId || !cfg.slotId) return null;
  if (!CLIENT_RE.test(cfg.clientId) || !SLOT_RE.test(cfg.slotId)) return null;
  return { kind: "adsense", placement: "scan_result", client: cfg.clientId, slot: cfg.slotId, format: "auto", adtest: cfg.adtest };
}

export function adFor(surface: Surface, opts: { siteUrl: string; adsense: AdsenseConfig; target: AdTarget | null }): Ad {
  if (surface === "web") {
    const a = adsenseAd(opts.adsense);
    if (a) return a;
  }
  return houseAd(opts.siteUrl, opts.target);
}

/** Plain-text rendering for CLI and MCP output. */
export function adText(ad: Ad): string {
  if (ad.kind === "house") return `[${ad.label}] ${ad.headline}: ${ad.body} ${ad.url}`;
  return "[Sponsored] Advertisement shown on the ClaudeRabbit web report.";
}
