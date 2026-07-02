/**
 * Human-count formatting — a single, tested place for turning a raw integer
 * into the abbreviated string a report or board stat shows a human (e.g.
 * `302545` -> `"303K"`). Nothing else in the repo has a shared formatter for
 * this (the Deno edge function has its own copy, `formatNumber` in
 * `supabase/functions/scan/index.ts`, which this mirrors in spirit but is not
 * byte-for-byte identical to — that file is a separate runtime).
 *
 * Kept dependency-free and pure so it is trivial to unit test and safe to call
 * from both Server and Client Components.
 */

/** Order-of-magnitude tiers this formatter abbreviates through, largest first. */
const TIERS: ReadonlyArray<{ threshold: number; divisor: number; suffix: string }> = [
  { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: "B" },
  { threshold: 1_000_000, divisor: 1_000_000, suffix: "M" },
  { threshold: 1_000, divisor: 1_000, suffix: "K" },
];

/**
 * Format a count for human display: plain integers under 1000, abbreviated
 * with one decimal place above that (dropping the decimal once the scaled
 * value reaches 100+, so we show 3 significant figures, not a fixed decimal
 * count) — e.g. `1234` -> `"1.2K"`, `302545` -> `"303K"`, `3200000` -> `"3.2M"`.
 *
 * Never throws and never renders a raw huge number: non-finite input (NaN,
 * +/-Infinity, or anything that isn't really a number) safely renders as
 * `"0"` rather than propagating garbage into a report a stranger reads.
 */
export function formatCount(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  if (n === 0) return "0";

  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);

  if (abs < 1000) return sign + String(Math.round(abs));

  for (const { threshold, divisor, suffix } of TIERS) {
    if (abs >= threshold) {
      const scaled = abs / divisor;
      // 3 significant figures: one decimal below 100, a rounded integer at/above
      // it. Rounding at the 100 boundary can carry a value up to the next tier
      // (e.g. 999,500 -> 999.5K -> rounds to "1000K"), so re-check after rounding.
      let out = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
      let unitSuffix = suffix;
      if (out >= 1000) {
        const nextTierIdx = TIERS.findIndex((t) => t.suffix === suffix) - 1;
        const nextTier = nextTierIdx >= 0 ? TIERS[nextTierIdx] : null;
        if (nextTier) {
          const rescaled = abs / nextTier.divisor;
          out = rescaled >= 100 ? Math.round(rescaled) : Math.round(rescaled * 10) / 10;
          unitSuffix = nextTier.suffix;
        }
      }
      const numStr = Number.isInteger(out) ? String(out) : out.toFixed(1);
      return `${sign}${numStr}${unitSuffix}`;
    }
  }

  // Unreachable given the tiers above start at 1000, kept as a safe fallback.
  return sign + String(Math.round(abs));
}

/** Does this trimmed string look like a raw, unformatted integer (e.g. "302545")? */
function looksLikeRawDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/**
 * Defensive normalization for the `stats.loc` display string. It arrives
 * pre-formatted from the model (e.g. `"9880 KB"`, `"7.2k"`, `"—"`) with no
 * code-side enforcement — if the model ever emits a bare unformatted integer
 * (e.g. `"302545"`), this re-parses and re-formats it through `formatCount` so
 * the UI can never show a raw number. Any string that already carries a unit,
 * a separator, or is a placeholder (`"—"`, `"unknown"`, ...) passes through
 * unchanged — this only catches the one failure mode of "the model forgot to
 * format it", not the separate concern of "the model chose the wrong unit".
 */
export function normalizeLocDisplay(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (!looksLikeRawDigits(trimmed)) return raw;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return raw;
  return formatCount(n);
}
