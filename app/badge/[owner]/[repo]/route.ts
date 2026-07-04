/**
 * Trust-badge SVG endpoint — `/badge/[owner]/[repo]`.
 *
 * Returns a small embeddable SVG showing the repo's safety score in its band
 * color (green / blue / amber / red — the fixed score-color logic). CORS-open
 * and cacheable headers are set in `next.config.ts` for `/badge/*`, so the badge
 * embeds on third-party sites and the trust badge from the PRD works anywhere.
 *
 * Reads the latest report for the repo via the anon Supabase server client
 * (public report reads are RLS-allowed). No secret is used.
 */

import { createClient } from "@/lib/supabase/server";
import { band } from "@/lib/score";

export const revalidate = 600;

// Plain hex (SVG embedded cross-site cannot resolve CSS variables) — matches
// the design's band palette.
const BAND_HEX: Record<ReturnType<typeof band>, string> = {
  green: "#16a34a",
  blue: "#2563eb",
  yellow: "#d97706",
  red: "#dc2626",
};

interface RouteParams {
  params: Promise<{ owner: string; repo: string }>;
}

/** Escape text for safe inclusion in SVG markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badgeSvg(label: string, value: string, color: string): string {
  // Rough monospace-ish width estimate keeps the two halves snug.
  const labelW = Math.max(54, label.length * 6.2 + 16);
  const valueW = Math.max(40, value.length * 6.6 + 18);
  const total = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <rect rx="3" width="${total}" height="20" fill="#24292f"/>
  <rect rx="3" x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
  <rect rx="3" width="${total}" height="20" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${esc(label)}</text>
    <text x="${labelW + valueW / 2}" y="14">${esc(value)}</text>
  </g>
</svg>`;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const { owner, repo } = await params;

  let score: number | null = null;
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("reports")
      .select("score")
      .eq("owner_login", owner)
      .eq("repo_name", repo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data && typeof (data as { score: number }).score === "number") {
      score = (data as { score: number }).score;
    }
  } catch {
    score = null;
  }

  const svg =
    score == null
      ? badgeSvg("ClaudeRabbit", "unscanned", "#6b7280")
      : badgeSvg("ClaudeRabbit", `${score}/100`, BAND_HEX[band(score)]);

  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // Cache-Control + CORS are also set by next.config for /badge/*; set here too.
      "Cache-Control": "public, max-age=300, s-maxage=600",
    },
  });
}
