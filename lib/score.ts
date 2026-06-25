/**
 * Score-band logic — ported verbatim from the Claude Design prototype
 * (`design-source/Claude Rabbit.dc.html`, lines ~1002–1007).
 *
 * The score-color logic is fixed everywhere a score appears and must stay
 * consistent across every surface and both themes:
 *   green  = high / secure   (>= 90)
 *   blue   = upper-middle    (>= 80)
 *   yellow = warning         (>= 60)  — maps to the `--amber` CSS variable
 *   red    = low / dangerous (< 60)
 *
 * Note the deliberate yellow -> `--amber` mapping for the color/glow/tint
 * variables, matching the prototype's `C` map and band helpers exactly.
 */

export type Band = "green" | "blue" | "yellow" | "red";

const BAND_COLOR: Record<Band, string> = {
  green: "var(--green)",
  blue: "var(--blue)",
  yellow: "var(--amber)",
  red: "var(--red)",
};

/** Maps a band name to the CSS variable suffix used for color/glow/tint. */
function bandVar(b: Band): string {
  return b === "yellow" ? "amber" : b;
}

export function band(score: number): Band {
  return score >= 90 ? "green" : score >= 80 ? "blue" : score >= 60 ? "yellow" : "red";
}

export function bandColor(score: number): string {
  return BAND_COLOR[band(score)];
}

export function bandGlow(score: number): string {
  return "var(--" + bandVar(band(score)) + "-g)";
}

export function bandTint(score: number): string {
  return "var(--" + bandVar(band(score)) + "-t)";
}

export function bandLabel(
  score: number,
): "High trust" | "Likely safe" | "Caution" | "Dangerous" {
  return score >= 90
    ? "High trust"
    : score >= 80
      ? "Likely safe"
      : score >= 60
        ? "Caution"
        : "Dangerous";
}
