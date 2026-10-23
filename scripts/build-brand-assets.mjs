#!/usr/bin/env node
/**
 * Builds every ClaudeRabbit icon and the site Open Graph image from the one mark in the v4 canvas
 * (project/term/Gate.dc.html nav: the mark on a white tile, 26 px tile, 17 px glyph, 7 px radius).
 *
 *   node scripts/build-brand-assets.mjs
 *
 * Writes:
 *   app/icon.svg                     the mark on its tile, scalable (also the source for every PNG below)
 *   app/favicon.ico                  16, 32 and 48 px PNG entries
 *   public/apple-touch-icon.png      180 px, full-bleed white (iOS rounds the corners itself)
 *   public/icon-192.png, icon-512.png  the tile with transparent corners (manifest icons)
 *   app/opengraph-image.png          1200 x 630: black, the mark, the hero headline and lede word for word
 *   app/twitter-image.png            the same image for twitter:image
 * Icons are rasterised with sharp; the Open Graph text is set in Figtree (scripts/brand/*.woff, OFL) by Next's
 * bundled @vercel/og, then recompressed with sharp.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (p) => path.join(ROOT, p);

// The canvas mark: viewBox -340.4 -340.4 680.8 680.8 (Gate.dc.html header).
const GLYPH = `<defs><linearGradient id="a" x1="-122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#B12ED1"/><stop offset=".52" stop-color="#DE37AF"/><stop offset="1" stop-color="#F5A84E"/></linearGradient><linearGradient id="b" x1="122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#B12ED1"/><stop offset=".52" stop-color="#DE37AF"/><stop offset="1" stop-color="#F5A84E"/></linearGradient></defs><circle r="300" fill="none" stroke="#121212" stroke-width="32.8"/><g stroke-width="32.8" stroke-linecap="round"><line x1="-122.25" y1="-68.41" x2="0" y2="140.09" stroke="url(#a)"/><line x1="122.25" y1="-68.41" x2="0" y2="140.09" stroke="url(#b)"/></g><circle cx="-122.25" cy="-68.41" r="53" fill="#1B77F3"/><circle cx="122.25" cy="-68.41" r="53" fill="#00BF63"/><circle cx="0" cy="140.09" r="53" fill="#FF4829"/>`;

/** The mark on a white tile of side `size`: glyph 17/26 of the tile, corner radius 7/26 (0 for a full-bleed square). */
function tileSvg(size, { rounded = true } = {}) {
  const glyph = (size * 17) / 26;
  const scale = glyph / 680.8;
  const rx = rounded ? (size * 7) / 26 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${rx}" fill="#FFFFFF"/><g transform="translate(${size / 2} ${size / 2}) scale(${scale})">${GLYPH}</g></svg>`;
}

const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * Math.max(1, 512 / size) }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** An ICO file whose entries are PNG images (supported by every current browser and Windows Vista onward). */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

const iconSvg = tileSvg(64);
writeFileSync(out("app/icon.svg"), iconSvg + "\n");

const icoEntries = [];
for (const size of [16, 32, 48]) icoEntries.push({ size, data: await png(tileSvg(size), size) });
writeFileSync(out("app/favicon.ico"), ico(icoEntries));

writeFileSync(out("public/apple-touch-icon.png"), await png(tileSvg(180, { rounded: false }), 180));
writeFileSync(out("public/icon-192.png"), await png(tileSvg(192), 192));
writeFileSync(out("public/icon-512.png"), await png(tileSvg(512), 512));

// Open Graph: the canvas hero on black (Gate.dc.html): the mark, the headline "ClaudeRabbit" with the .gw gradient,
// and the lede, both word for word.
const require = createRequire(import.meta.url);
const { ImageResponse } = require("next/dist/compiled/@vercel/og/index.node.js");
const fig400 = readFileSync(out("scripts/brand/figtree-latin-400.woff"));
const fig500 = readFileSync(out("scripts/brand/figtree-latin-500.woff"));
const markData = `data:image/svg+xml;base64,${Buffer.from(tileSvg(112)).toString("base64")}`;
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } });
const og = new ImageResponse(
  h(
    "div",
    { style: { width: 1200, height: 630, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 96px", background: "#000000", fontFamily: "Figtree", position: "relative" } },
    h("div", { style: { position: "absolute", left: 0, right: 0, top: 0, height: 630, background: "radial-gradient(60% 70% at 85% 40%, rgba(255,255,255,0.07), rgba(255,255,255,0) 70%)" } }),
    h("img", { src: markData, width: 112, height: 112, style: { borderRadius: 30 } }),
    h("div", { style: { marginTop: 40, fontSize: 112, lineHeight: 1.02, letterSpacing: "-0.045em", fontWeight: 400, backgroundImage: "linear-gradient(180deg, #FFFFFF 35%, #9C9C9C)", backgroundClip: "text", color: "transparent" } }, "ClaudeRabbit"),
    h("div", { style: { marginTop: 28, maxWidth: 900, fontSize: 32, lineHeight: 1.45, color: "#A1A1A1", fontWeight: 400 } }, "ClaudeRabbit is a security audit tool that scans open-source repositories and packages to protect the developer and builder community from malware."),
  ),
  { width: 1200, height: 630, fonts: [{ name: "Figtree", data: fig400, weight: 400, style: "normal" }, { name: "Figtree", data: fig500, weight: 500, style: "normal" }] },
);
const ogPng = await sharp(Buffer.from(await og.arrayBuffer())).png({ compressionLevel: 9, palette: false }).toBuffer();
writeFileSync(out("app/opengraph-image.png"), ogPng);
writeFileSync(out("app/twitter-image.png"), ogPng);

for (const f of ["app/icon.svg", "app/favicon.ico", "public/apple-touch-icon.png", "public/icon-192.png", "public/icon-512.png", "app/opengraph-image.png", "app/twitter-image.png"]) {
  console.log(`${f} ${readFileSync(out(f)).length} bytes`);
}
