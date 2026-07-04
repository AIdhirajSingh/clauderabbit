import { ImageResponse } from "next/og";
import { createClient } from "@/lib/supabase/server";
import { buildReportView } from "@/lib/report-view";
import { fetchLatestReport } from "@/lib/report-fetch";
import { band } from "@/lib/score";

/**
 * Per-report OG/Twitter card image — overrides the site-wide default
 * (app/opengraph-image.tsx) for every `/[owner]/[repo]` page. Shows the real
 * score and verdict so a shared report link previews as an actual result,
 * not a generic logo card — this repo/report database growing via sharing is
 * the product's real growth loop (badge, "shareable, embeddable"). Uses the
 * SAME enforced verdict + score band color rule as the page itself
 * (buildReportView, lib/score.ts) — never a different or invented color, and
 * never a bare "Safe" (the verdict is rendered verbatim from buildReportView,
 * which already guards that).
 */
export const alt = "ClaudeRabbit safety report";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface RouteParams {
  params: Promise<{ owner: string; repo: string }>;
}

// Approximate, Satori-renderable hex equivalents of the design's oklch score-band
// colors (lib/score.ts) — oklch() isn't supported by Satori's CSS subset, so this
// is a same-hue-family stand-in for the social-card render only; the live page
// still uses the exact design tokens via CSS variables.
const BAND_HEX: Record<ReturnType<typeof band>, string> = {
  green: "#4ade80",
  blue: "#60a5fa",
  yellow: "#fbbf24",
  red: "#f87171",
};

export default async function ReportOpengraphImage({ params }: RouteParams) {
  const { owner, repo } = await params;
  const slug = `${owner}/${repo}`;

  let view: ReturnType<typeof buildReportView> | null = null;
  try {
    const supabase = await createClient();
    const report = await fetchLatestReport(supabase, owner, repo);
    view = report ? buildReportView(report) : null;
  } catch {
    view = null;
  }

  const color = view ? BAND_HEX[band(view.score)] : "#a39c90";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#16130f",
          fontFamily: "sans-serif",
          padding: 80,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 140, fontWeight: 700, color }}>
            {view ? view.score : "—"}
          </div>
          <div style={{ display: "flex", fontSize: 36, color: "#a39c90" }}>/ 100</div>
        </div>
        <div style={{ display: "flex", marginTop: 8, fontSize: 40, fontWeight: 600, color }}>
          {view ? view.verdict : "No report yet"}
        </div>
        <div style={{ display: "flex", marginTop: 32, fontSize: 44, color: "#f4f1ea", fontWeight: 500 }}>
          {slug}
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 24, color: "#6d665b" }}>
          ClaudeRabbit — an honest, evidence-backed safety score
        </div>
      </div>
    ),
    { ...size },
  );
}
