import type { MetadataRoute } from "next";

/** /manifest.webmanifest: the installable app's name, colours and icons (built by scripts/build-brand-assets.mjs). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ClaudeRabbit",
    short_name: "ClaudeRabbit",
    description: "Open-source supply-chain security scanner: it installs and runs a GitHub repo or npm package in a disposable, isolated VM and returns a 0 to 100 safety score with the evidence.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
