import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import manifest from "../app/manifest.ts";

/** PNG width and height from the IHDR chunk. */
function pngSize(buf: Buffer): [number, number] {
  assert.equal(buf.subarray(1, 4).toString("latin1"), "PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test("favicon.ico holds 16, 32 and 48 px PNG entries", () => {
  const ico = readFileSync("app/favicon.ico");
  assert.equal(ico.readUInt16LE(2), 1, "type icon");
  const n = ico.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    const len = ico.readUInt32LE(6 + i * 16 + 8);
    const off = ico.readUInt32LE(6 + i * 16 + 12);
    const [w, h] = pngSize(ico.subarray(off, off + len));
    assert.equal(w, h);
    sizes.push(w);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
});

test("app icons and the Open Graph image have their sizes, built from the canvas mark", async () => {
  assert.deepEqual(pngSize(readFileSync("public/apple-touch-icon.png")), [180, 180]);
  assert.deepEqual(pngSize(readFileSync("public/icon-192.png")), [192, 192]);
  assert.deepEqual(pngSize(readFileSync("public/icon-512.png")), [512, 512]);
  assert.deepEqual(pngSize(readFileSync("app/opengraph-image.png")), [1200, 630]);
  const svg = readFileSync("app/icon.svg", "utf8");
  for (const c of ["#1B77F3", "#00BF63", "#FF4829", "#B12ED1", "#F5A84E"]) assert.ok(svg.includes(c), c);
  // The Open Graph image is black at its corners (the canvas background).
  const { data } = await sharp("app/opengraph-image.png").extract({ left: 0, top: 0, width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0]! < 8 && data[1]! < 8 && data[2]! < 8);
});

test("the manifest and the root metadata point at the built icons", () => {
  const m = manifest();
  assert.equal(m.name, "ClaudeRabbit");
  assert.deepEqual(m.icons?.map((i) => i.src), ["/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]);
  const layout = readFileSync("app/layout.tsx", "utf8");
  assert.match(layout, /manifest: "\/manifest\.webmanifest"/);
  assert.match(layout, /apple: \[\{ url: "\/apple-touch-icon\.png"/);
});
