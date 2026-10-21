/**
 * Every ad ID and tag the 2.0 web UI uses, in one place. All values are Google's
 * PUBLISHED TEST IDs; swapping to real IDs later is a change to this file only.
 * Every slot is labelled "Advertisement".
 *
 *  videoTag      IMA SDK sample VAST tag (single linear ad), Google's published sample.
 *  rewardedUnit  Google Ad Manager's published rewarded test unit.
 *  adsense*      AdSense's published test publisher; adtest is always on for it.
 *  exportSponsor house card burned into exported MP4s (third-party video ads cannot be baked into a file).
 */

export const ADS = {
  label: "Advertisement",
  videoTag:
    "https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480&cust_params=sample_ct%3Dlinear&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&impl=s&correlator=",
  imaSdk: "https://imasdk.googleapis.com/js/sdkloader/ima3.js",
  rewardedUnit: "/22639388115/rewarded_web_example",
  adsenseClient: "ca-pub-3940256099942544",
  adsenseSlot: "6300978111",
  adsenseScript: "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
  exportSponsor: {
    label: "Advertisement",
    headline: "Your product here",
    body: "Sponsor ClaudeRabbit and reach the builders who check code before they run it.",
    url: "https://clauderabbit.in",
  },
} as const;
