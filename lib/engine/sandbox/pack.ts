/**
 * Repack the verified, normalized archive file map into a gzip tarball for the
 * analysis sandbox (DESIGN.md section 2.1). The scanners then see exactly the
 * file set the reachability graph classified: regular files only, paths already
 * normalized and traversal-free by lib/engine/archive.ts, no links.
 */

import { gzipSync } from "node:zlib";

const enc = new TextEncoder();
const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function put(buf: Uint8Array, off: number, len: number, s: string): void {
  buf.set(enc.encode(s).subarray(0, len), off);
}

function header(name: string, size: number, type: "0" | "x"): Uint8Array {
  const h = new Uint8Array(BLOCK);
  put(h, 0, 100, name);
  put(h, 100, 8, octal(0o644, 8));
  put(h, 108, 8, octal(0, 8));
  put(h, 116, 8, octal(0, 8));
  put(h, 124, 12, octal(size, 12));
  put(h, 136, 12, octal(0, 12));
  put(h, 148, 8, "        ");
  put(h, 156, 1, type);
  put(h, 257, 6, "ustar\0");
  put(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

function paxRecord(key: string, value: string): Uint8Array {
  const rest = ` ${key}=${value}\n`;
  const restLen = enc.encode(rest).length;
  let len = restLen + 1;
  while (String(len).length + restLen !== len) len = String(len).length + restLen;
  return enc.encode(`${len}${rest}`);
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(data);
  return out;
}

/** Build a gzip'd POSIX tar of `files` (sorted by path). */
export function packFiles(files: Map<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    const nameBytes = enc.encode(path).length;
    let name = path;
    if (nameBytes > 99) {
      const pax = paxRecord("path", path);
      parts.push(header("PaxHeader", pax.length, "x"), padded(pax));
      name = path.slice(0, 99);
    }
    parts.push(header(name, data.length, "0"));
    if (data.length > 0) parts.push(padded(data));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    tar.set(p, off);
    off += p.length;
  }
  return new Uint8Array(gzipSync(tar, { level: 6 }));
}
