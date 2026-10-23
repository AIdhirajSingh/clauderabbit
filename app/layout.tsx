import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import "./globals.css";
import "@/components/v4/v4.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

/**
 * Self-hosted fonts via `next/font/local` — the font files are COMMITTED to the repo
 * (./fonts/*.woff2, the exact latin-subset faces) and bundled at build time. This is a
 * deliberate switch from `next/font/google`: that loader downloads the faces from
 * fonts.googleapis.com AT BUILD TIME, which fails in any network-isolated build — including
 * our OWN hermetic detonation sandbox, where the self-scan of this repo scored "did not
 * build to a runnable state" purely because `next build` could not reach Google Fonts. A
 * local face has no build-time network dependency, so the build is fully reproducible
 * offline. Runtime is unchanged (served from our origin, same `@font-face` + `size-adjust`
 * metric-matched fallback so text paints immediately with no layout shift).
 *
 * DISPLAY STRATEGY (measured, not guessed): the hero <h1> is the mobile LCP element
 * and it is set in Instrument Serif. Under Lighthouse's throttled mobile profile the
 * serif file finishes ~2.7s in (three faces share the slow-4G pipe), and with
 * `display: swap` Chrome re-marks LCP at that late swap — pinning mobile LCP at
 * ~2.7s and performance at ~91 even though FCP is ~1.0s and CLS is ~0. So the DISPLAY
 * serif uses `display: optional`: because next/font's fallback is metric-matched
 * (`size-adjust`), the layout is pixel-identical either way, but `optional` lets the
 * fallback OWN a genuinely slow first paint instead of a jarring late swap — so LCP
 * collapses to ~FCP and mobile performance clears 95. Fast connections and every
 * repeat (cached) visit still render the real Instrument Serif. Geist (body copy, not
 * the LCP element) keeps `swap` so running text always upgrades to the real face.
 *
 * Faithful to design.md's type system — the exact same families/weights/styles the
 * shipped Claude Design used:
 *   • Instrument Serif — weight 400, normal + italic (all display + hero numbers).
 *   • Geist — weights 300–700 (all text UI). Geist ships as a variable font, so the
 *     single variable face covers the whole 300–700 range the design uses.
 * The families are exposed as CSS variables and consumed by globals.css
 * (`body { font-family: var(--font-geist) }`, `.serif { font-family: var(--font-serif) }`),
 * so the design's `font-family:'Geist'` / `.serif{font-family:'Instrument Serif'}`
 * intent resolves without changing any component.
 */
const geist = localFont({
  src: [{ path: "./fonts/geist-latin.woff2", weight: "300 700", style: "normal" }],
  display: "swap",
  variable: "--font-geist",
  // Metric-matched sans fallback so text paints instantly with no layout shift.
  adjustFontFallback: "Arial",
});

/**
 * Figtree, the iDesign Pockit face used by every 2.0 screen (CSS var --font-figtree).
 * Self-hosted for the same reason as the faces above: next/font/google fetches at
 * build time and a failed fetch fails the build. Variable latin face
 * (@fontsource-variable/figtree 5.2.10, sha256 4ba7d3d0…62dd), weights 300 to 900.
 */
const figtree = localFont({
  src: [{ path: "./fonts/figtree-latin.woff2", weight: "300 900", style: "normal" }],
  display: "swap",
  variable: "--font-figtree",
  adjustFontFallback: "Arial",
});

/** Geist Mono, the v4 design's mono face (@fontsource/geist-mono 5.2.7, latin 400 and 500), self-hosted like the faces above. */
const geistMono = localFont({
  src: [
    { path: "./fonts/geist-mono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/geist-mono-latin-500.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-geist-mono",
  adjustFontFallback: false,
});

const instrumentSerif = localFont({
  src: [
    { path: "./fonts/instrument-serif-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/instrument-serif-italic-latin.woff2", weight: "400", style: "italic" },
  ],
  // `optional` (not `swap`): the hero <h1> LCP element is set in this face; on a slow
  // first load the metric-matched fallback owns the paint (identical layout, no shift)
  // rather than a late swap that re-marks LCP at ~2.7s. See the block comment above.
  display: "optional",
  variable: "--font-instrument-serif",
  // Metric-matched serif fallback (mirrors what next/font/google generated before).
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "ClaudeRabbit",
  description:
    "ClaudeRabbit is a free, open-source security product protecting the open-source community from malware. We clone any public GitHub repo into an isolated sandbox, run it, and return one honest safety score.",
  alternates: { canonical: siteUrl },
};


/**
 * Async because it reads the per-request CSP nonce that proxy.ts puts on the
 * request (`x-nonce`, see lib/csp.ts). Reading a request header makes every page
 * render per request, which a nonce requires: Next.js stamps the same nonce on
 * its own scripts from the request's Content-Security-Policy header, and the
 * theme init script below carries it explicitly.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Dark only (the v4 design). Reading the nonce header keeps every page rendered per request, which the CSP nonce needs.
  await headers();
  return (
    <html
      lang="en"
      data-theme="dark"
      data-scroll-behavior="smooth"
      className={`${figtree.variable} ${geistMono.variable} ${geist.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Fonts are self-hosted via next/font (see the loaders above): the
          `@font-face` CSS is inlined and the files are served from our own
          origin, so there is no longer any render-blocking external font
          request. The font-family CSS variables set on <html> above are
          consumed by globals.css.
        */}
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#000000" />
      </head>
      <body>{children}</body>
    </html>
  );
}
