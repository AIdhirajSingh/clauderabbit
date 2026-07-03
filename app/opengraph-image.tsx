import { ImageResponse } from "next/og";

/**
 * Site-wide default OG/Twitter card image (Next's file-convention metadata
 * image — auto-wired into every page's og:image + twitter:image unless a
 * route defines its own). Fixes a real gap: every page already declared
 * `twitter:card: "summary_large_image"` but had no actual image, so link
 * previews on Twitter/Slack/Discord/etc. rendered broken or fell back to a
 * generic card. Static, on-brand, dark-theme colors (the design's default
 * theme) — matches app/globals.css's dark palette exactly, not approximated.
 */
export const alt = "Claude Rabbit — a free, open-source security product";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
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
        }}
      >
        <svg width="120" height="120" viewBox="0 0 32 32" fill="none">
          <path
            d="M10.2 14.5 C8.3 9.8 8.6 4.4 10.2 4 C11.8 3.6 13.1 8 13.3 12.3"
            stroke="#f4f1ea"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <path
            d="M21.8 14.5 C23.7 9.8 23.4 4.4 21.8 4 C20.2 3.6 18.9 8 18.7 12.3"
            stroke="#f4f1ea"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <circle cx="16" cy="19.6" r="7" stroke="#f4f1ea" strokeWidth="1.9" />
          <circle cx="16" cy="19.8" r="1.8" fill="#f4f1ea" />
        </svg>
        <div style={{ display: "flex", marginTop: 28, fontSize: 64, fontWeight: 600, color: "#f4f1ea", letterSpacing: "-0.02em" }}>
          Claude Rabbit
        </div>
        <div style={{ display: "flex", marginTop: 18, fontSize: 30, color: "#a39c90" }}>
          Everyone else reads the code. We run it.
        </div>
      </div>
    ),
    { ...size },
  );
}
