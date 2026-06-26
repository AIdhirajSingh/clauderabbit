/**
 * Dependency-free world geography for the danger-board map.
 *
 * Everything here is pure and framework-agnostic (no React) so it can be unit
 * tested under `node --test` and imported from a Client Component alike.
 *
 * The map is an equirectangular (plate carrée) projection: longitude maps
 * linearly to x across [-180, 180], latitude linearly to y across [90, -90]
 * (north up). `WORLD_OUTLINE_PATH` is a hand-built, deliberately low-poly
 * continent outline authored in the SAME projection at a 360×180 unit viewBox,
 * so a projected point lands on the matching coastline. The outline is
 * decoration only — it carries no data and names no place.
 *
 * Honesty: a dot is only ever placed where we have a REAL resolved country from
 * a caught repo's forensic geolocation. `centroidForCountry` returns the
 * country's approximate centroid (country-level precision — never a claim about
 * the exact server location) or null when the country is unknown, in which case
 * the caller renders no dot rather than guessing.
 */

/** The map's intrinsic coordinate space (equirectangular, 2:1). */
export const MAP_W = 360;
export const MAP_H = 180;

/** A projected point in the map's [0..MAP_W] × [0..MAP_H] space. */
export interface MapPoint {
  x: number;
  y: number;
}

/**
 * Project a (lat, lng) onto the map space. Longitude → x linearly across the
 * full width; latitude → y with north up (lat +90 at the top, -90 at the
 * bottom), so SVG's downward y is handled by the `90 - lat` term. Inputs are
 * clamped to valid ranges so a malformed geo record can never project off-canvas.
 */
export function project(lat: number, lng: number, w: number = MAP_W, h: number = MAP_H): MapPoint {
  const clampedLat = Math.max(-90, Math.min(90, lat));
  const clampedLng = Math.max(-180, Math.min(180, lng));
  return {
    x: ((clampedLng + 180) / 360) * w,
    y: ((90 - clampedLat) / 180) * h,
  };
}

/**
 * Approximate centroids (lat, lng) for the countries most likely to surface as
 * a caught C2 destination. Keyed by the lower-cased country string the forensic
 * record carries. We index by full English name AND ISO-3166 alpha-2/alpha-3 so
 * a record that stored "RU", "RUS", or "Russia" all resolve. This is not an
 * exhaustive gazetteer — an unknown country resolves to null and the caller
 * renders no dot (honest over invented).
 */
const COUNTRY_CENTROIDS: Record<string, { lat: number; lng: number }> = {};

/** Register a country under its name and ISO codes. */
function reg(
  centroid: { lat: number; lng: number },
  name: string,
  iso2: string,
  iso3: string,
): void {
  COUNTRY_CENTROIDS[name.toLowerCase()] = centroid;
  COUNTRY_CENTROIDS[iso2.toLowerCase()] = centroid;
  COUNTRY_CENTROIDS[iso3.toLowerCase()] = centroid;
}

reg({ lat: 38.0, lng: -97.0 }, "United States", "US", "USA");
reg({ lat: 56.0, lng: 38.0 }, "Russia", "RU", "RUS");
reg({ lat: 35.9, lng: 104.2 }, "China", "CN", "CHN");
reg({ lat: 51.2, lng: 10.4 }, "Germany", "DE", "DEU");
reg({ lat: 46.2, lng: 2.2 }, "France", "FR", "FRA");
reg({ lat: 52.4, lng: -1.5 }, "United Kingdom", "GB", "GBR");
reg({ lat: 52.1, lng: 5.3 }, "Netherlands", "NL", "NLD");
reg({ lat: 22.4, lng: 114.1 }, "Hong Kong", "HK", "HKG");
reg({ lat: 1.35, lng: 103.8 }, "Singapore", "SG", "SGP");
reg({ lat: 36.2, lng: 138.3 }, "Japan", "JP", "JPN");
reg({ lat: 36.5, lng: 127.9 }, "South Korea", "KR", "KOR");
reg({ lat: 20.6, lng: 78.9 }, "India", "IN", "IND");
reg({ lat: 48.4, lng: 31.2 }, "Ukraine", "UA", "UKR");
reg({ lat: 52.1, lng: 19.4 }, "Poland", "PL", "POL");
reg({ lat: 60.1, lng: 18.6 }, "Sweden", "SE", "SWE");
reg({ lat: 41.9, lng: 12.6 }, "Italy", "IT", "ITA");
reg({ lat: 40.3, lng: -3.7 }, "Spain", "ES", "ESP");
reg({ lat: 56.3, lng: 9.5 }, "Denmark", "DK", "DNK");
reg({ lat: 47.5, lng: 14.6 }, "Austria", "AT", "AUT");
reg({ lat: 46.8, lng: 8.2 }, "Switzerland", "CH", "CHE");
reg({ lat: 50.5, lng: 4.5 }, "Belgium", "BE", "BEL");
reg({ lat: 47.2, lng: 19.5 }, "Hungary", "HU", "HUN");
reg({ lat: 49.8, lng: 15.5 }, "Czechia", "CZ", "CZE");
reg({ lat: 45.9, lng: 25.0 }, "Romania", "RO", "ROU");
reg({ lat: 39.1, lng: 35.0 }, "Turkey", "TR", "TUR");
reg({ lat: 31.0, lng: 35.0 }, "Israel", "IL", "ISR");
reg({ lat: 25.2, lng: 55.3 }, "United Arab Emirates", "AE", "ARE");
reg({ lat: -25.3, lng: 133.8 }, "Australia", "AU", "AUS");
reg({ lat: 56.1, lng: -106.3 }, "Canada", "CA", "CAN");
reg({ lat: 23.6, lng: -102.6 }, "Mexico", "MX", "MEX");
reg({ lat: -14.2, lng: -51.9 }, "Brazil", "BR", "BRA");
reg({ lat: -38.4, lng: -63.6 }, "Argentina", "AR", "ARG");
reg({ lat: 4.6, lng: -74.3 }, "Colombia", "CO", "COL");
reg({ lat: 9.1, lng: 8.7 }, "Nigeria", "NG", "NGA");
reg({ lat: -30.6, lng: 22.9 }, "South Africa", "ZA", "ZAF");
reg({ lat: 26.8, lng: 30.8 }, "Egypt", "EG", "EGY");
reg({ lat: 15.2, lng: 101.0 }, "Thailand", "TH", "THA");
reg({ lat: -0.8, lng: 113.9 }, "Indonesia", "ID", "IDN");
reg({ lat: 12.9, lng: 121.8 }, "Philippines", "PH", "PHL");
reg({ lat: 14.1, lng: 108.3 }, "Vietnam", "VN", "VNM");
reg({ lat: 30.4, lng: 69.3 }, "Pakistan", "PK", "PAK");
reg({ lat: 33.9, lng: 67.7 }, "Afghanistan", "AF", "AFG");
reg({ lat: 32.4, lng: 53.7 }, "Iran", "IR", "IRN");
reg({ lat: 40.0, lng: 127.5 }, "North Korea", "KP", "PRK");
reg({ lat: 47.0, lng: 28.4 }, "Moldova", "MD", "MDA");
reg({ lat: 53.7, lng: 27.9 }, "Belarus", "BY", "BLR");
reg({ lat: 42.7, lng: 25.5 }, "Bulgaria", "BG", "BGR");
reg({ lat: 64.9, lng: -19.0 }, "Iceland", "IS", "ISL");
reg({ lat: 53.4, lng: -8.2 }, "Ireland", "IE", "IRL");
reg({ lat: 39.4, lng: -8.2 }, "Portugal", "PT", "PRT");
reg({ lat: 61.9, lng: 25.7 }, "Finland", "FI", "FIN");
reg({ lat: 60.5, lng: 8.5 }, "Norway", "NO", "NOR");

/**
 * Resolve a country string from a forensic geolocation to an approximate
 * centroid, or null when we cannot honestly place it. Tolerant of casing and
 * surrounding whitespace; tries the raw string and a few light normalizations.
 */
export function centroidForCountry(country: string | null | undefined): { lat: number; lng: number } | null {
  if (!country) return null;
  const key = country.trim().toLowerCase();
  if (!key) return null;
  const direct = COUNTRY_CENTROIDS[key];
  if (direct) return direct;
  // Common alternate spellings → canonical key.
  const aliases: Record<string, string> = {
    usa: "united states",
    "u.s.": "united states",
    "u.s.a.": "united states",
    america: "united states",
    uk: "united kingdom",
    "u.k.": "united kingdom",
    "great britain": "united kingdom",
    england: "united kingdom",
    "russian federation": "russia",
    "south korea (republic of korea)": "south korea",
    "republic of korea": "south korea",
    "korea, republic of": "south korea",
    "viet nam": "vietnam",
    holland: "netherlands",
    "czech republic": "czechia",
    "united arab emirates (uae)": "united arab emirates",
    uae: "united arab emirates",
  };
  const aliased = aliases[key];
  if (aliased && COUNTRY_CENTROIDS[aliased]) return COUNTRY_CENTROIDS[aliased];
  return null;
}

/**
 * Hand-built low-poly continent outline, authored against the equirectangular
 * 360×180 projection (x: lng+180, y: 90-lat). Decorative only — it gives the
 * dotted field a recognizable shape and names nothing. Kept coarse on purpose
 * so it stays a few hundred bytes, not a geo dataset.
 */
export const WORLD_OUTLINE_PATH = [
  // North America
  "M 40 36 L 78 30 L 110 34 L 120 50 L 96 64 L 86 86 L 70 92 L 58 74 L 44 58 Z",
  // Central America tail
  "M 86 86 L 96 96 L 104 108 L 96 110 L 88 98 Z",
  // South America
  "M 104 110 L 122 108 L 132 126 L 124 150 L 110 162 L 102 150 L 100 128 Z",
  // Greenland
  "M 120 22 L 140 20 L 146 34 L 130 40 L 120 32 Z",
  // Europe
  "M 170 40 L 196 34 L 210 42 L 206 56 L 188 60 L 176 54 Z",
  // Africa
  "M 176 70 L 206 64 L 220 84 L 216 110 L 200 128 L 186 118 L 180 94 Z",
  // Asia
  "M 210 36 L 268 30 L 312 40 L 320 60 L 300 76 L 268 72 L 232 64 L 212 52 Z",
  // India peninsula
  "M 250 74 L 262 76 L 266 94 L 256 100 L 250 86 Z",
  // SE Asia / Indonesia
  "M 286 88 L 312 92 L 320 104 L 300 110 L 288 100 Z",
  // Australia
  "M 300 120 L 332 116 L 344 134 L 326 148 L 304 142 L 298 130 Z",
].join(" ");
