import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Claude Rabbit",
  description: "Everyone reads the code. We run it.",
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
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/*
          The shipped Claude Design loads its two fonts (Instrument Serif +
          Geist) via this exact Google Fonts stylesheet link. We deliberately
          port it as-is rather than swapping to next/font, so the design's
          `font-family:'Geist'` / `.serif{font-family:'Instrument Serif'}`
          resolve directly. Placed in the root layout <head>, it loads for the
          whole app — so the no-page-custom-font rule does not apply here.
        */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
