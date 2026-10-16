/**
 * Test-only tar writer used to build synthetic archives (traversal, symlinks,
 * pax and GNU long names, bombs) for the engine's archive and resolver tests.
 * Never imported by production code.
 */

import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  type?: "file" | "dir" | "symlink" | "hardlink" | "fifo" | "pax-global" | "pax" | "gnu-longname";
  data?: string | Uint8Array;
  linkname?: string;
  pax?: Record<string, string>;
  prefix?: string;
  /** Write a wrong checksum into the header. */
  corruptChecksum?: boolean;
}

const enc = new TextEncoder();

function writeStr(buf: Uint8Array, off: number, len: number, s: string) {
  const b = enc.encode(s);
  buf.set(b.subarray(0, len), off);
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

const TYPEFLAG: Record<NonNullable<TarEntry["type"]>, string> = {
  file: "0",
  dir: "5",
  symlink: "2",
  hardlink: "1",
  fifo: "6",
  "pax-global": "g",
  pax: "x",
  "gnu-longname": "L",
};

function header(name: string, size: number, type: NonNullable<TarEntry["type"]>, linkname = "", prefix = "", corrupt = false): Uint8Array {
  const h = new Uint8Array(512);
  writeStr(h, 0, 100, name);
  writeStr(h, 100, 8, octal(0o644, 8));
  writeStr(h, 108, 8, octal(0, 8));
  writeStr(h, 116, 8, octal(0, 8));
  writeStr(h, 124, 12, octal(size, 12));
  writeStr(h, 136, 12, octal(0, 12));
  writeStr(h, 148, 8, "        ");
  writeStr(h, 156, 1, TYPEFLAG[type]);
  writeStr(h, 157, 100, linkname);
  writeStr(h, 257, 6, "ustar\0");
  writeStr(h, 263, 2, "00");
  writeStr(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  if (corrupt) sum += 7;
  writeStr(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

export function paxBody(records: Record<string, string>): Uint8Array {
  let out = "";
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = rest.length + 1;
    while (String(len).length + enc.encode(rest).length !== len) len = String(len).length + enc.encode(rest).length;
    out += `${len}${rest}`;
  }
  return enc.encode(out);
}

function pad(data: Uint8Array): Uint8Array {
  const size = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
}

export function makeTar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const type = e.type ?? "file";
    if (e.pax) {
      const body = paxBody(e.pax);
      parts.push(header("PaxHeader", body.length, "pax"), pad(body));
    }
    const data = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array(0));
    if (type === "pax-global" || type === "gnu-longname") {
      parts.push(header(e.name, data.length, type), pad(data));
      continue;
    }
    const size = type === "file" ? data.length : 0;
    parts.push(header(e.name, size, type, e.linkname ?? "", e.prefix ?? "", e.corruptChecksum ?? false));
    if (size > 0) parts.push(pad(data));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function makeTgz(entries: TarEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(makeTar(entries)));
}

/** A files map like the archive parser returns, from plain strings. */
export function filesOf(record: Record<string, string>): Map<string, Uint8Array> {
  return new Map(Object.entries(record).map(([k, v]) => [k, enc.encode(v)]));
}
