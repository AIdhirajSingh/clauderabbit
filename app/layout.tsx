import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

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
 * No-flash theme init — runs in <head> before first paint so the page never
 * flashes the wrong theme. Faithful port of the prototype's componentDidMount
 * theme logic (`design-source/Claude Rabbit.dc.html`, lines ~1116–1125):
 * a saved 'cr-theme' wins; otherwise fall back to the OS preference; otherwise
 * stay on the default 'light' that is already set on <html>.
 */
const themeInitScript = `
(function(){
  try {
    var saved = localStorage.getItem('cr-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="light"
      data-scroll-behavior="smooth"
      className={`${geist.variable} ${instrumentSerif.variable}`}
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
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
