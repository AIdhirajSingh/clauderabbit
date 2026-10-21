/**
 * Parser for the harness's `strace -f -ttt -s 256` output (DESIGN.md section 3.4).
 *
 * The harness traces execve/execveat, open/openat/creat, unlink/unlinkat,
 * rename/renameat/renameat2, chmod/fchmodat, connect, chdir and the clone
 * family, writing one file per phase with each line prefixed by the pid. This
 * module turns that text into `process` and `file` events:
 *
 *  - every successful execve (pid, ppid from the clone that created it, argv);
 *  - writes/creates/unlinks/renames/chmods outside the install tree;
 *  - any successful open of a decoy credential file (`read_decoy`).
 *
 * Relative paths are resolved against a per-pid working directory that starts
 * at the harness's cwd, is inherited across clone and follows chdir.
 */

import { isPersistencePath } from "../score";
import type { FileEventData, Phase, ProcessEventData } from "../types";

const SCORED_BINARIES = new Set(["curl", "wget", "nc", "ncat", "netcat", "powershell", "pwsh", "powershell.exe", "crontab", "base64", "bash", "zsh"]);

/** A file event the score reads: a decoy read or a write to a persistence location. */
export function isScoreRelevantFile(op: FileEventData["op"], path: string): boolean {
  return op === "read_decoy" || (op !== "unlink" && isPersistencePath(path));
}

/** A process the score reads: a download, shell, decode or crontab binary. */
export function isScoreRelevantProcess(argv: string[]): boolean {
  const a0 = argv[0] ?? "";
  return SCORED_BINARIES.has(a0.slice(a0.lastIndexOf("/") + 1));
}

/** Decoy credential files planted for uid 1001 (sandbox/e2b/guest/cr-detonate.sh step 5). */
export const DECOY_PATHS = [
  "/home/cr/.ssh/id_rsa",
  "/home/cr/.aws/credentials",
  "/home/cr/.npmrc",
  "/home/cr/.config/gh/hosts.yml",
  "/home/cr/.docker/config.json",
  "/home/cr/.git-credentials",
] as const;

const DECOYS = new Set<string>(DECOY_PATHS);

/** Writes under these prefixes are part of a normal install and not reported. */
export const INSTALL_TREE_PREFIXES = ["/work/", "/home/cr/.npm/", "/home/cr/.cache/", "/tmp/", "/dev/", "/proc/", "/run/user/"];

export const MAX_ARGV_CHARS = 512;
export const MAX_PROCESS_EVENTS = 250;
export const MAX_FILE_EVENTS = 250;

export interface StraceParse {
  processes: ProcessEventData[];
  files: FileEventData[];
  /**
   * Datagram sends to a non-loopback address other than DNS (sendto/sendmsg
   * carrying a destination), as "udp <addr>:<port>". The fence drops them, so
   * only the trace says where they were going. Attempts count whether or not
   * the send returned an error.
   */
  datagrams: string[];
  stats: { lines: number; unparsed: number; droppedProcesses: number; droppedFiles: number };
}

// ---- tokenizer for strace argument lists -------------------------------------

type Arg = { kind: "str"; value: string; truncated: boolean } | { kind: "arr"; items: Arg[]; truncated: boolean } | { kind: "raw"; value: string };

function unescapeC(s: string, i: number): { value: string; end: number } {
  // s[i] is the opening quote.
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j]!;
    if (ch === '"') return { value: out, end: j + 1 };
    if (ch === "\\" && j + 1 < s.length) {
      const n = s[j + 1]!;
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", v: "\v", f: "\f", '"': '"', "\\": "\\", a: "\x07", b: "\b" };
      if (n in simple) {
        out += simple[n];
        j += 2;
        continue;
      }
      if (n === "x") {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2, j + 4))?.[0] ?? "";
        out += String.fromCharCode(parseInt(hex || "0", 16));
        j += 2 + hex.length;
        continue;
      }
      if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4))![0];
        out += String.fromCharCode(parseInt(oct, 8));
        j += 1 + oct.length;
        continue;
      }
      out += n;
      j += 2;
      continue;
    }
    out += ch;
    j += 1;
  }
  return { value: out, end: s.length };
}

function parseArgs(s: string): Arg[] {
  let i = 0;
  const skipWs = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  const parseOne = (): Arg => {
    skipWs();
    if (s[i] === '"') {
      const { value, end } = unescapeC(s, i);
      i = end;
      let truncated = false;
      if (s.startsWith("...", i)) {
        truncated = true;
        i += 3;
      }
      return { kind: "str", value, truncated };
    }
    if (s[i] === "[") {
      i++;
      const items: Arg[] = [];
      let truncated = false;
      while (i < s.length) {
        skipWs();
        if (s[i] === "]") {
          i++;
          break;
        }
        if (s.startsWith("...", i)) {
          truncated = true;
          i += 3;
          continue;
        }
        if (s.startsWith("/*", i)) {
          const end = s.indexOf("*/", i);
          i = end < 0 ? s.length : end + 2;
          continue;
        }
        items.push(parseOne());
        skipWs();
        if (s[i] === ",") i++;
      }
      return { kind: "arr", items, truncated };
    }
    let depth = 0;
    const start = i;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      else if (ch === '"') {
        i = unescapeC(s, i).end;
        continue;
      }
      i++;
    }
    return { kind: "raw", value: s.slice(start, i).trim() };
  };
  const out: Arg[] = [];
  while (i < s.length) {
    skipWs();
    if (i >= s.length) break;
    out.push(parseOne());
    skipWs();
    if (s[i] === ",") i++;
    else if (i < s.length) i++;
  }
  return out;
}

// ---- line handling ------------------------------------------------------------

const LINE_RE = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/;
const CALL_RE = /^([a-z_0-9]+)\((.*)\)\s+=\s+(-?\d+|\?|0x[0-9a-f]+)(?:\s+([A-Z][A-Z0-9_]*))?/;
const UNFINISHED_RE = /^([a-z_0-9]+)\((.*?)\s*<unfinished \.\.\.>$/;
const RESUMED_RE = /^<\.\.\. ([a-z_0-9]+) resumed>(.*)$/;

interface Call {
  pid: number;
  name: string;
  args: string;
  ret: number | null;
  /** strace -ttt time of the call (epoch seconds). */
  t: number;
}

/** Join `<unfinished ...>` / `<... resumed>` pairs and yield complete calls. */
export function* straceCalls(text: string, stats: StraceParse["stats"]): Generator<Call> {
  const pending = new Map<string, string>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    stats.lines++;
    const m = LINE_RE.exec(raw);
    if (!m) {
      stats.unparsed++;
      continue;
    }
    const pid = Number(m[1]);
    let body = m[3]!;
    if (body.startsWith("+++") || body.startsWith("---")) continue;
    const un = UNFINISHED_RE.exec(body);
    if (un) {
      pending.set(`${pid}:${un[1]}`, `${un[1]}(${un[2]}`);
      continue;
    }
    const re = RESUMED_RE.exec(body);
    if (re) {
      const key = `${pid}:${re[1]}`;
      const head = pending.get(key);
      pending.delete(key);
      if (head === undefined) {
        stats.unparsed++;
        continue;
      }
      // strace prints the remainder exactly as it would have followed the head.
      body = head + re[2]!;
    }
    const c = CALL_RE.exec(body);
    if (!c) {
      stats.unparsed++;
      continue;
    }
    const ret = c[3] === "?" ? null : c[3]!.startsWith("0x") ? parseInt(c[3]!, 16) : Number(c[3]);
    yield { pid, name: c[1]!, args: c[2]!, ret, t: Number(m[2]) };
  }
}

function str(a: Arg | undefined): string | null {
  return a && a.kind === "str" ? a.value : null;
}

function resolvePath(p: string, cwd: string | null): string | null {
  if (p.startsWith("/")) return normalize(p);
  if (!cwd) return null;
  return normalize(`${cwd}/${p}`);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;

function inInstallTree(path: string): boolean {
  return INSTALL_TREE_PREFIXES.some((p) => path.startsWith(p)) || path === "/dev/null";
}

export interface StraceOptions {
  phase: Phase;
  /** The harness's cwd when it started the traced command. */
  initialCwd: string;
}

export function parseStrace(text: string, opts: StraceOptions): StraceParse {
  const stats = { lines: 0, unparsed: 0, droppedProcesses: 0, droppedFiles: 0 };
  const processes: ProcessEventData[] = [];
  const files: FileEventData[] = [];
  const datagrams = new Set<string>();
  const seenFiles = new Set<string>();
  const ppid = new Map<number, number>();
  const cwd = new Map<number, string | null>();
  let rootPid: number | null = null;

  const cwdOf = (pid: number): string | null => {
    if (rootPid === null) rootPid = pid;
    if (!cwd.has(pid)) cwd.set(pid, pid === rootPid ? opts.initialCwd : null);
    return cwd.get(pid) ?? null;
  };

  // Time of the call being handled, carried onto the events it produces.
  let curAt: number | undefined;
  const addFile = (op: FileEventData["op"], path: string, pid: number) => {
    const key = `${op}:${path}`;
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    // Past the display cap only score-relevant events are kept, so a flood of
    // benign file events can never push a decoy read or persistence write out.
    if (files.length >= MAX_FILE_EVENTS && !isScoreRelevantFile(op, path)) {
      stats.droppedFiles++;
      return;
    }
    files.push({ phase: opts.phase, op, path, pid, ...(curAt ? { at: curAt } : {}) });
  };

  for (const call of straceCalls(text, stats)) {
    const { pid, name, ret } = call;
    curAt = Number.isFinite(call.t) && call.t > 0 ? Math.round(call.t * 1000) : undefined;
    const here = cwdOf(pid);
    if (name === "sendto" || name === "sendmsg" || name === "sendmmsg") {
      const d = datagramDestination(call.args);
      if (d && datagrams.size < 100) datagrams.add(d);
      continue;
    }
    if (name === "clone" || name === "clone3" || name === "fork" || name === "vfork") {
      if (ret !== null && ret > 0) {
        ppid.set(ret, pid);
        cwd.set(ret, here);
      }
      continue;
    }
    if (ret === null || ret < 0) continue;
    const args = parseArgs(call.args);
    switch (name) {
      case "execve":
      case "execveat": {
        const arr = args[name === "execve" ? 1 : 2];
        const argv: string[] = [];
        if (arr && arr.kind === "arr") {
          let total = 0;
          for (const it of arr.items) {
            const v = it.kind === "str" ? it.value : it.kind === "raw" ? it.value : "";
            if (total + v.length > MAX_ARGV_CHARS) {
              argv.push(v.slice(0, Math.max(0, MAX_ARGV_CHARS - total)));
              break;
            }
            total += v.length;
            argv.push(v);
          }
        }
        if (argv.length === 0) {
          const p = str(args[name === "execve" ? 0 : 1]);
          if (p) argv.push(p);
        }
        if (processes.length >= MAX_PROCESS_EVENTS && !isScoreRelevantProcess(argv)) {
          stats.droppedProcesses++;
          break;
        }
        processes.push({ phase: opts.phase, pid, ppid: ppid.get(pid) ?? 0, argv, ...(curAt ? { at: curAt } : {}) });
        break;
      }
      case "chdir": {
        const p = str(args[0]);
        if (p !== null) cwd.set(pid, resolvePath(p, here));
        break;
      }
      case "open":
      case "openat":
      case "creat": {
        const rel = str(args[name === "openat" ? 1 : 0]);
        if (rel === null) break;
        const dirfd = name === "openat" ? args[0] : undefined;
        const base = dirfd && dirfd.kind === "raw" && dirfd.value !== "AT_FDCWD" && !rel.startsWith("/") ? null : here;
        const path = resolvePath(rel, base);
        if (path === null) break;
        if (DECOYS.has(path)) {
          addFile("read_decoy", path, pid);
          break;
        }
        const flags = name === "creat" ? "O_CREAT" : (args[name === "openat" ? 2 : 1] as { value?: string } | undefined)?.value ?? "";
        if (!WRITE_FLAGS.test(flags) || inInstallTree(path)) break;
        addFile(/O_CREAT/.test(flags) ? "create" : "write", path, pid);
        break;
      }
      case "unlink":
      case "unlinkat": {
        const rel = str(args[name === "unlinkat" ? 1 : 0]);
        const path = rel === null ? null : resolvePath(rel, here);
        if (path && !inInstallTree(path)) addFile("unlink", path, pid);
        break;
      }
      case "rename":
      case "renameat":
      case "renameat2": {
        const rel = str(args[name === "rename" ? 1 : 3]);
        const path = rel === null ? null : resolvePath(rel, here);
        if (path && !inInstallTree(path)) addFile("rename", path, pid);
        break;
      }
      case "chmod":
      case "fchmodat": {
        const rel = str(args[name === "chmod" ? 0 : 1]);
        const path = rel === null ? null : resolvePath(rel, here);
        if (path && !inInstallTree(path)) addFile("chmod", path, pid);
        break;
      }
      default:
        break;
    }
  }
  return { processes, files, datagrams: [...datagrams].sort(), stats };
}

const V4_DEST = /sin_port=htons\((\d+)\),\s*sin_addr=inet_addr\("([0-9.]+)"\)/;
const V6_DEST = /sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6,\s*"([0-9a-fA-F:.]+)"/;

/** "udp <addr>:<port>" for a datagram send to a non-loopback, non-DNS destination; null otherwise. */
export function datagramDestination(args: string): string | null {
  const m4 = V4_DEST.exec(args);
  const m6 = m4 ? null : V6_DEST.exec(args);
  const m = m4 ?? m6;
  if (!m) return null;
  const port = Number(m[1]);
  const addr = m[2]!;
  if (port === 53 || port === 5353) return null;
  if (m4 && addr.startsWith("127.")) return null;
  if (m6 && (addr === "::1" || addr.startsWith("::ffff:127."))) return null;
  return m6 ? `udp [${addr}]:${port}` : `udp ${addr}:${port}`;
}
