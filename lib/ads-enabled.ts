/**
 * The one ads switch. `NEXT_PUBLIC_ADS_ENABLED=true` (with real unit IDs in lib/ads-config.ts) turns every ad slot,
 * ad script and ad request back on; anything else, including unset, leaves the site with no ad slot, no reserved
 * space and no ad script. Inlined at build time, so the server and the browser agree.
 */
export const ADS_ENABLED = process.env.NEXT_PUBLIC_ADS_ENABLED === "true";
