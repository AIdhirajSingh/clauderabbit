/**
 * In-memory gunzip + tar parser for untrusted tarballs (DESIGN.md sections 2.2, 4).
 *
 * The bytes come from GitHub codeload, the npm registry or an operator URL and
 * are hostile by assumption. Nothing here touches the filesystem: entries land in
 * a Map keyed by a normalized relative path. Rules:
 *  - gunzip is streamed with a hard cap on expanded bytes (a gzip bomb stops at
 *    the cap and the archive is marked `truncated`);
 *  - at most `maxFiles` regular files are kept (past that, `truncated`);
 *  - header checksums are verified; a corrupt header fails the parse;
 *  - absolute paths, drive letters, `..` segments and NUL bytes are rejected
 *    per entry and listed in `rejected` (the rest of the archive still parses);
 *  - symlinks and hardlinks are recorded in `links` and never followed or read;
 *  - devices and FIFOs are skipped and recorded in `rejected`;
 *  - pax (`x`, `g`) and GNU long-name (`L`, `K`) records are honored, and the
 *    pax global `comment` (git archive writes the commit SHA there) is exposed;
 *  - a single shared top-level directory (GitHub `owner-repo-sha/`, npm
 *    `package/`) is stripped and reported as `root`.
 */

import { createGunzip } from "node:zlib";

export interface ArchiveLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
}

export interface ArchiveLink {
  path: string;
  target: string;
  kind: "symlink" | "hardlink";
  /** True when the link target resolves outside the archive root. */
  escapes: boolean;
}

export interface RejectedEntry {
  path: string;
  reason: "absolute_path" | "path_traversal" | "nul_in_path" | "empty_path" | "special_file" | "link_escapes_root";
}

export interface ParsedArchive {
  files: Map<string, Uint8Array>;
  /** The stripped shared top-level directory, or null. */
  root: string | null;
  /** pax global header `comment`, which git archive sets to the commit SHA. */
  paxComment: string | null;
  links: ArchiveLink[];
  rejected: RejectedEntry[];
  truncated: boolean;
  truncatedReason: "expanded_bytes" | "file_count" | null;
  expandedBytes: number;
  entryCount: number;
}

export class ArchiveError extends Error {
  readonly reason: "too_large" | "corrupt";
  constructor(reason: "too_large" | "corrupt", message: string) {
    super(message);
    this.name = "ArchiveError";
    this.reason = reason;
  }
}

const BLOCK = 512;
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Stream-gunzip `data`, stopping at `cap` expanded bytes. */
export function gunzipCapped(data: Uint8Array, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const gz = createGunzip();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      resolve({ bytes: out, truncated });
    };
    gz.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = cap - total;
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(new Uint8Array(chunk.subarray(0, room)));
          total += room;
        }
        finish(true);
        gz.destroy();
        return;
      }
      chunks.push(new Uint8Array(chunk));
      total += chunk.length;
    });
    gz.on("end", () => finish(false));
    gz.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new ArchiveError("corrupt", `gzip stream is corrupt: ${err.message}`));
    });
    gz.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
}

function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function cString(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  const max = start + len;
  while (end < max && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(start, end));
}

/** Numeric header field: octal text, or GNU base-256 when the high bit is set. */
function parseNumber(buf: Uint8Array, start: number, len: number): number {
  const first = buf[start] ?? 0;
  if (first & 0x80) {
    let n = first & 0x7f;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + (buf[i] ?? 0);
    if (!Number.isSafeInteger(n)) throw new ArchiveError("corrupt", "tar size field out of range");
    return n;
  }
  const text = cString(buf, start, len).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError("corrupt", "tar numeric field is not octal");
  return parseInt(text, 8);
}

function checksumOk(header: Uint8Array): boolean {
  const stored = parseNumber(header, 148, 8);
  let unsigned = 0;
  for (let i = 0; i < BLOCK; i++) {
    unsigned += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  }
  return stored === unsigned;
}

function isZeroBlock(buf: Uint8Array, off: number): boolean {
  for (let i = off; i < off + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/** Parse pax extended header records (`<len> <key>=<value>\n`). */
export function parsePaxRecords(body: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off < body.length) {
    let sp = off;
    while (sp < body.length && body[sp] !== 0x20) sp++;
    if (sp >= body.length) break;
    const len = parseInt(decoder.decode(body.subarray(off, sp)), 10);
    if (!Number.isFinite(len) || len <= 0 || off + len > body.length) {
      throw new ArchiveError("corrupt", "pax record length is invalid");
    }
    const rec = decoder.decode(body.subarray(sp + 1, off + len));
    const eq = rec.indexOf("=");
    if (eq > 0) {
      const key = rec.slice(0, eq);
      const value = rec.slice(eq + 1).replace(/\n$/, "");
      out[key] = value;
    }
    off += len;
  }
  return out;
}

/**
 * Normalize an entry path to a relative POSIX path, or return the rejection reason.
 * Backslashes count as separators so a Windows-style `..\\x` cannot slip through.
 */
export function normalizeEntryPath(raw: string): { path: string } | { rejected: RejectedEntry["reason"] } {
  if (raw.includes("\u0000")) return { rejected: "nul_in_path" };
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return { rejected: "absolute_path" };
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return { rejected: "path_traversal" };
    parts.push(seg);
  }
  if (parts.length === 0) return { rejected: "empty_path" };
  return { path: parts.join("/") };
}

/** Resolve a link target relative to the link's directory; true when it leaves the root. */
function linkEscapes(linkPath: string, target: string): boolean {
  const t = target.replace(/\\/g, "/");
  if (t.startsWith("/") || /^[A-Za-z]:/.test(t)) return true;
  const stack = linkPath.split("/").slice(0, -1);
  for (const seg of t.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return true;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return false;
}

interface RawEntry {
  path: string;
  type: "file" | "symlink" | "hardlink";
  data?: Uint8Array;
  linkTarget?: string;
}

/** Parse an uncompressed tar buffer. `inputTruncated` marks a capped gunzip. */
export function parseTar(
  tar: Uint8Array,
  limits: Pick<ArchiveLimits, "maxFiles">,
  inputTruncated = false,
): ParsedArchive {
  const raw: RawEntry[] = [];
  const rejected: RejectedEntry[] = [];
  let paxComment: string | null = null;
  let globalPax: Record<string, string> = {};
  let nextPax: Record<string, string> | null = null;
  let longName: string | null = null;
  let longLink: string | null = null;
  let truncated = inputTruncated;
  let truncatedReason: ParsedArchive["truncatedReason"] = inputTruncated ? "expanded_bytes" : null;
  let fileCount = 0;
  let entryCount = 0;
  let off = 0;

  while (off + BLOCK <= tar.length) {
    if (isZeroBlock(tar, off)) break;
    const header = tar.subarray(off, off + BLOCK);
    if (!checksumOk(header)) throw new ArchiveError("corrupt", `tar header checksum mismatch at offset ${off}`);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    let size = parseNumber(header, 124, 12);
    const pax: Record<string, string> = { ...globalPax, ...(nextPax ?? {}) };
    if (pax.size !== undefined && /^\d+$/.test(pax.size)) size = Number(pax.size);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    const nextOff = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (dataEnd > tar.length) {
      // The body runs past the buffer: only legitimate when gunzip was capped.
      if (inputTruncated) break;
      throw new ArchiveError("corrupt", "tar entry body runs past the end of the archive");
    }
    const body = tar.subarray(dataStart, dataEnd);

    if (typeflag === "x") {
      nextPax = parsePaxRecords(body);
      off = nextOff;
      continue;
    }
    if (typeflag === "g") {
      const g = parsePaxRecords(body);
      if (typeof g.comment === "string") paxComment = g.comment;
      globalPax = { ...globalPax, ...g };
      delete globalPax.comment;
      off = nextOff;
      continue;
    }
    if (typeflag === "L") {
      longName = cString(body, 0, body.length);
      off = nextOff;
      continue;
    }
    if (typeflag === "K") {
      longLink = cString(body, 0, body.length);
      off = nextOff;
      continue;
    }

    entryCount++;
    const magic = cString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? cString(header, 345, 155) : "";
    let name = cString(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    if (longName !== null) name = longName;
    if (pax.path !== undefined) name = pax.path;
    let linkTarget = cString(header, 157, 100);
    if (longLink !== null) linkTarget = longLink;
    if (pax.linkpath !== undefined) linkTarget = pax.linkpath;
    nextPax = null;
    longName = null;
    longLink = null;

    const isDir = typeflag === "5" || (name.endsWith("/") && (typeflag === "0" || typeflag === "\u0000"));
    if (isDir) {
      off = nextOff;
      continue;
    }
    const norm = normalizeEntryPath(name);
    if ("rejected" in norm) {
      rejected.push({ path: name, reason: norm.rejected });
      off = nextOff;
      continue;
    }

    if (typeflag === "0" || typeflag === "\u0000" || typeflag === "7") {
      if (fileCount >= limits.maxFiles) {
        truncated = true;
        truncatedReason = "file_count";
        break;
      }
      fileCount++;
      raw.push({ path: norm.path, type: "file", data: body.slice() });
    } else if (typeflag === "2" || typeflag === "1") {
      raw.push({ path: norm.path, type: typeflag === "2" ? "symlink" : "hardlink", linkTarget });
    } else {
      rejected.push({ path: norm.path, reason: "special_file" });
    }
    off = nextOff;
  }

  // Strip one shared top-level directory when every entry sits under it.
  const firstSegs = new Set(raw.map((e) => e.path.split("/")[0]));
  const allNested = raw.length > 0 && raw.every((e) => e.path.includes("/"));
  const root = allNested && firstSegs.size === 1 ? [...firstSegs][0]! : null;
  const strip = (p: string) => (root !== null ? p.slice(root.length + 1) : p);

  const files = new Map<string, Uint8Array>();
  const links: ArchiveLink[] = [];
  let expandedBytes = 0;
  for (const e of raw) {
    const p = strip(e.path);
    if (e.type === "file") {
      const prev = files.get(p);
      if (prev) expandedBytes -= prev.length;
      files.set(p, e.data!);
      expandedBytes += e.data!.length;
    } else {
      const target = e.linkTarget ?? "";
      // Hardlink targets are archive paths (with the root); symlink targets are relative to the link.
      const escapes =
        e.type === "hardlink"
          ? "rejected" in normalizeEntryPath(target)
          : linkEscapes(p, target);
      links.push({ path: p, target, kind: e.type, escapes });
      if (escapes) rejected.push({ path: p, reason: "link_escapes_root" });
    }
  }

  return { files, root, paxComment, links, rejected, truncated, truncatedReason, expandedBytes, entryCount };
}

/** Gunzip (when gzip) and parse. Rejects inputs over the compressed cap outright. */
export async function parseTarball(data: Uint8Array, limits: ArchiveLimits): Promise<ParsedArchive> {
  if (data.length > limits.maxCompressedBytes) {
    throw new ArchiveError("too_large", `archive is ${data.length} bytes, over the ${limits.maxCompressedBytes} byte cap`);
  }
  if (!isGzip(data)) {
    if (data.length > limits.maxExpandedBytes) {
      throw new ArchiveError("too_large", "uncompressed archive is over the expanded cap");
    }
    return parseTar(data, limits);
  }
  const { bytes, truncated } = await gunzipCapped(data, limits.maxExpandedBytes);
  return parseTar(bytes, limits, truncated);
}

/** UTF-8 text of a file, or null when it looks binary (NUL in the first 8 KiB). */
export function textOf(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return null;
  return decoder.decode(bytes);
}
