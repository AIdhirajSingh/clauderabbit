/**
 * The ads in the 2.0 web UI, through Google Publisher Tag (GPT).
 *
 * The scan screen has no video content, so a video ad there is a "Standalone"
 * placement (or "Interstitial" when it fills the viewport between pages), and
 * Google's video inventory policy requires GPT for both on the web; the IMA SDK
 * is for in-stream placements only
 * (support.google.com/publisherpolicies/answer/15208072).
 *
 * Every ad unit here is one of Google's PUBLISHED GPT SAMPLE units; swapping to
 * real Ad Manager units later is a change to this file only. The slot is
 * labelled "Advertisement".
 *
 *  gpt           the GPT library.
 *  scanSlot      the scan screen's display slot (it can serve display or
 *                out-stream video creatives); refreshed every `refreshMs` while
 *                the scan screen is open, so ads play back to back until the
 *                result opens.
 *  interstitial  GPT web interstitial, shown by GPT on the next same-site page
 *                navigation (the continue card's Yes is such a navigation).
 *  ecpmInr       default estimated eCPM for the earnings estimate, INR per 1,000
 *                impressions (v2.ad_settings overrides it).
 *  houseCard     shown in the slot only when no ad loads.
 */

export const ADS = {
  label: "Advertisement",
  gpt: "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
  scanSlot: { unit: "/6355419/Travel/Europe", sizes: [[300, 250], [336, 280]] as [number, number][] },
  interstitial: "/6355419/Travel/Europe/France/Paris",
  refreshMs: 30_000,
  ecpmInr: 100,
  houseCard: {
    headline: "Your product here",
    body: "Sponsor ClaudeRabbit and reach the builders who check code before they run it.",
    url: "https://clauderabbit.in",
  },
} as const;
