/**
 * The one ad in the 2.0 web UI: an instream video ad in the video slot of the
 * scan progress screen (every scan, cached or not, and Watch how it happened,
 * which uses the same screen). Google Ad Manager through the IMA SDK.
 *
 * Every value here is Google's PUBLISHED SAMPLE; swapping to real Ad Manager
 * tags later is a change to this file only. The slot is labelled "Advertisement".
 *
 *  videoTag   IMA sample "Single Skippable Inline": a linear, skippable pre-roll.
 *  imaSdk     the IMA SDK loader.
 *  houseCard  shown in the slot only when no ad loads.
 */

export const ADS = {
  label: "Advertisement",
  videoTag:
    "https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_preroll_skippable&sz=640x480&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&impl=s&correlator=",
  imaSdk: "https://imasdk.googleapis.com/js/sdkloader/ima3.js",
  houseCard: {
    headline: "Your product here",
    body: "Sponsor ClaudeRabbit and reach the builders who check code before they run it.",
    url: "https://clauderabbit.in",
  },
} as const;
