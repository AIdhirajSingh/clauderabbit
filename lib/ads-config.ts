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
 *  unit          the scan page slots' ad unit.
 *  videoSizes    the scan screen's 16:9 video slot, asking for video-capable
 *                sizes (out-stream video or, when no video fills, display). A new
 *                ad starts when the previous video ends or after `refreshMs`,
 *                never faster: Google's refresh guidance is 30 s.
 *  bannerSizes   the banner slots in the screen's empty areas (300×250 desktop,
 *                320×50 phone, keeping phone ad density under 30 % of the page).
 *  slotCount     slots on the scan screen; their starts are staggered evenly
 *                across refreshMs.
 *  refreshKey    targeting key set on every refresh (0 on the first request), so
 *                Ad Manager sees the slot's refreshed impressions; the ad unit
 *                must also be declared as refreshed inventory in Ad Manager.
 *  interstitial  GPT web interstitial, shown by GPT on the next same-site page
 *                navigation (the continue card's Yes is such a navigation).
 *  ecpmInr       default estimated eCPM for the earnings estimate, INR per 1,000
 *                impressions (v2.ad_settings overrides it).
 *  houseCard     shown in the slot only when no ad loads.
 */

export const ADS = {
  label: "Advertisement",
  gpt: "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
  unit: "/6355419/Travel/Europe",
  // Desktop and phone sizes per slot kind (GPT size mapping at 768 px).
  videoSizes: { desktop: [[640, 360], [640, 480], [480, 270], [300, 250]] as [number, number][], phone: [[300, 250], [320, 180]] as [number, number][] },
  bannerSizes: { desktop: [[300, 250]] as [number, number][], phone: [[320, 50]] as [number, number][] },
  // The video slot plus banner_1 to banner_3: 4 slots × one impression per 30 s ×
  // 10 paise (₹100 eCPM) = 1.33 paise a second.
  slotCount: 4,
  interstitial: "/6355419/Travel/Europe/France/Paris",
  refreshMs: 30_000,
  refreshKey: "refresh",
  ecpmInr: 100,
  houseCard: {
    headline: "Your product here",
    body: "Sponsor ClaudeRabbit and reach the builders who check code before they run it.",
    url: "https://clauderabbit.in",
  },
} as const;
