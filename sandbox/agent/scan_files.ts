#!/usr/bin/env -S deno run --allow-read
/**
 * scan_files.ts — a thin Deno CLI bridge to the EXISTING static scanner.
 *
 * The agentic knowledge graph (knowledge_graph.py, pure Python) needs REAL
 * static signals per file to pre-rank suspicion. Rather than fork the regex
 * pattern SET into Python (audit rule M3 — do NOT fork the patterns), Python
 * shells out to this CLI, which imports the one true `staticScan` from
 * `_shared/static-scan.ts` and runs it over files read from disk.
 *
 * This is read-only and never executes target code: it reads file bytes, caps
 * them, builds `FetchedFile[]`, and runs the pure `staticScan`. Output is JSON
 * on stdout — the StaticScanResult plus a per-file signal breakdown so the
 * graph can rank each file individually.
 *
 * Usage:
 *   deno run --allow-read scan_files.ts <file> [<file> ...]
 *   printf '%s\n' file1 file2 | deno run --allow-read scan_files.ts --stdin
 *
 * The paths are treated as untrusted DATA: they are only read, never evaluated.
 * Files that cannot be read (missing, binary-ish, permission) are reported in
 * `errors` and skipped — never fatal — so a hostile/odd repo cannot break the
 * scan.
 */

import { staticScan } from "../../supabase/functions/_shared/static-scan.ts";
import type { FetchedFile } from "../../supabase/functions/_shared/github.ts";

/** Cap per-file content. Generous vs. the fetch layer's 32KB (we have the real
 * clone on disk, not an API budget), but bounded so a giant file cannot blow up
 * memory or the regex passes. Matches the task spec (256KB/file). */
const MAX_FILE_BYTES = 256 * 1024;

/** A NUL byte in the first chunk is a strong "binary" tell; we skip scanning
 * those (the static patterns are text-only) but still report them. */
function looksBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, Math.min(bytes.length, 8000));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

interface ScanError {
  path: string;
  error: string;
}

/** Read one file from disk into a FetchedFile, capped + truncation-flagged.
 * Returns null (and records an error) for unreadable/binary files. */
function readFetchedFile(
  path: string,
  errors: ScanError[],
): FetchedFile | null {
  let raw: Uint8Array;
  try {
    // Deno.readFileSync does NOT follow into a symlink target's *contents* for
    // our purposes beyond normal FS semantics; we additionally refuse symlinks
    // so a repo cannot point us at an out-of-tree secret via a planted link.
    const info = Deno.lstatSync(path);
    if (info.isSymlink) {
      errors.push({ path, error: "symlink skipped" });
      return null;
    }
    if (info.isDirectory) {
      errors.push({ path, error: "is a directory" });
      return null;
    }
    raw = Deno.readFileSync(path);
  } catch (e) {
    errors.push({ path, error: e instanceof Error ? e.message : String(e) });
    return null;
  }

  if (looksBinary(raw)) {
    errors.push({ path, error: "binary file skipped" });
    return null;
  }

  const truncated = raw.length > MAX_FILE_BYTES;
  const slice = truncated ? raw.subarray(0, MAX_FILE_BYTES) : raw;
  const content = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { path, content, truncated };
}

/** Per-file signal breakdown: run staticScan on each file individually so the
 * graph can attribute suspicion to the exact node. We also return the combined
 * result over all files (which is what the real fast path consumes). */
function scanPerFile(files: FetchedFile[]) {
  const perFile: Record<string, ReturnType<typeof staticScan>> = {};
  for (const f of files) {
    perFile[f.path] = staticScan([f]);
  }
  return perFile;
}

function readStdinPaths(): string[] {
  const data = new Uint8Array(64 * 1024);
  const chunks: Uint8Array[] = [];
  let n: number | null;
  // Bounded read loop; stdin path lists are tiny.
  while ((n = Deno.stdin.readSync(data)) !== null && n > 0) {
    chunks.push(data.slice(0, n));
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder()
    .decode(merged)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function main(): void {
  const argv = Deno.args.slice();
  let paths: string[];
  if (argv.length === 1 && argv[0] === "--stdin") {
    paths = readStdinPaths();
  } else if (argv.includes("--stdin")) {
    paths = [
      ...argv.filter((a) => a !== "--stdin"),
      ...readStdinPaths(),
    ];
  } else {
    paths = argv;
  }

  const errors: ScanError[] = [];
  const files: FetchedFile[] = [];
  for (const p of paths) {
    const f = readFetchedFile(p, errors);
    if (f) files.push(f);
  }

  const combined = staticScan(files);
  const perFile = scanPerFile(files);

  const out = {
    scanned: files.map((f) => ({ path: f.path, truncated: f.truncated })),
    errors,
    combined,
    perFile,
  };
  // Single JSON document on stdout; nothing else is printed there.
  console.log(JSON.stringify(out));
}

if (import.meta.main) {
  main();
}
