/**
 * Forge capture parsing and canary search (DESIGN.md sections 3.3 step 4, 3.4).
 *
 * The forge writes one JSON record per request, DNS query, refused TLS
 * handshake and raw TCP connection (`capture.jsonl`, format fixed by
 * sandbox/e2b/guest/forge_core.py `capture_record`). This module parses that
 * file, searches every record for the per-run canary values (raw and common
 * encodings), and produces `forged_call` event data. Only install- and
 * entry-phase records are behaviour; probe and collect records belong to the
 * harness and are counted, never scored.
 */

import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { ForgedCallData, Phase } from "../types";

export interface CaptureRecord {
  t: number;
  phase: string;
  proto: string;
  host: string;
  port: number;
  method: string | null;
  path: string | null;
  sni: string | null;
  req_headers: Record<string, string>;
  req_bytes: number;
  req_body_b64: string;
  forged_kind: string;
  tls: string | null;
  status?: number;
  integrity?: string;
}

export interface CaptureParse {
  records: CaptureRecord[];
  invalid: number;
}

export const MAX_FORGED_EVENTS = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseCapture(text: string): CaptureParse {
  const records: CaptureRecord[] = [];
  let invalid = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      invalid++;
      continue;
    }
    if (!isRecord(v) || typeof v.host !== "string" || typeof v.proto !== "string" || typeof v.forged_kind !== "string") {
      invalid++;
      continue;
    }
    const headers: Record<string, string> = {};
    if (isRecord(v.req_headers)) for (const [k, val] of Object.entries(v.req_headers)) headers[k.toLowerCase()] = String(val);
    records.push({
      t: typeof v.t === "number" ? v.t : 0,
      phase: typeof v.phase === "string" ? v.phase : "install",
      proto: v.proto,
      host: v.host.toLowerCase().replace(/\.$/, ""),
      port: typeof v.port === "number" ? v.port : 0,
      method: typeof v.method === "string" ? v.method : null,
      path: typeof v.path === "string" ? v.path : null,
      sni: typeof v.sni === "string" ? v.sni : null,
      req_headers: headers,
      req_bytes: typeof v.req_bytes === "number" ? v.req_bytes : 0,
      req_body_b64: typeof v.req_body_b64 === "string" ? v.req_body_b64 : "",
      forged_kind: v.forged_kind,
      tls: typeof v.tls === "string" ? v.tls : null,
      ...(typeof v.status === "number" ? { status: v.status } : {}),
      ...(typeof v.integrity === "string" ? { integrity: v.integrity } : {}),
    });
  }
  return { records, invalid };
}

// ---- canaries -------------------------------------------------------------------

export const CANARY_NAMES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"] as const;
export type CanaryName = (typeof CANARY_NAMES)[number];
export type Canaries = Record<CanaryName, string>;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function pick(alphabet: string, n: number, rnd: (n: number) => Uint8Array): string {
  const bytes = rnd(n);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/**
 * Fresh canary credentials for one run, shaped like the real formats so code
 * that validates a token's shape before stealing it still takes the bait. Every
 * value carries 20+ random characters, so a match cannot be a coincidence.
 */
export function makeCanaries(rnd: (n: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n))): Canaries {
  return {
    AWS_ACCESS_KEY_ID: "AKIA" + pick(B32, 16, rnd),
    AWS_SECRET_ACCESS_KEY: pick(ALNUM, 40, rnd),
    NPM_TOKEN: "npm_" + pick(ALNUM, 36, rnd),
    GITHUB_TOKEN: "ghp_" + pick(ALNUM, 36, rnd),
    OPENAI_API_KEY: "sk-proj-" + pick(ALNUM, 48, rnd),
  };
}

/** `KEY=VALUE` lines for the root-only canary file the harness reads. */
export function canaryEnvFile(c: Canaries): string {
  return CANARY_NAMES.map((k) => `${k}=${c[k]}`).join("\n") + "\n";
}

/** Encoded forms searched for in captured traffic and written files. */
export function canaryVariants(value: string): string[] {
  const b = Buffer.from(value, "utf8");
  const b64 = b.toString("base64");
  const out = new Set<string>([
    value,
    b64,
    b64.replace(/=+$/, ""),
    b.toString("base64url"),
    b.toString("hex"),
    b.toString("hex").toUpperCase(),
    encodeURIComponent(value),
    [...value].reverse().join(""),
  ]);
  return [...out].filter((v) => v.length >= 16);
}

/** One pattern per line for `grep -F -f` inside the VM. */
export function canaryPatternsFile(c: Canaries): string {
  return CANARY_NAMES.flatMap((k) => canaryVariants(c[k])).join("\n") + "\n";
}

export interface CanaryMatcher {
  /** Canary names whose value (or an encoding of it) occurs in `text`. */
  hits(text: string): CanaryName[];
}

export function canaryMatcher(c: Canaries): CanaryMatcher {
  const table = CANARY_NAMES.map((k) => ({ name: k, variants: canaryVariants(c[k]) }));
  return {
    hits(text: string) {
      if (!text) return [];
      const out: CanaryName[] = [];
      for (const { name, variants } of table) if (variants.some((v) => text.includes(v))) out.push(name);
      return out;
    },
  };
}

function bodyTexts(b64: string): string[] {
  if (!b64) return [];
  const raw = Buffer.from(b64, "base64");
  const texts = [raw.toString("latin1")];
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      texts.push(gunzipSync(raw, { maxOutputLength: 4 * 1024 * 1024 }).toString("latin1"));
    } catch {
      // A truncated or corrupt gzip body is searched as captured.
    }
  }
  return texts;
}

/** Canary names found anywhere in one record: host, path, SNI, headers, body. */
export function recordCanaryHits(r: CaptureRecord, m: CanaryMatcher): CanaryName[] {
  const fields = [r.host, r.path ?? "", r.sni ?? "", ...Object.values(r.req_headers), ...bodyTexts(r.req_body_b64)];
  const found = new Set<CanaryName>();
  for (const f of fields) for (const h of m.hits(f)) found.add(h);
  return [...found].sort();
}

const PROTOS = new Set(["http", "https", "dns", "tcp"]);

/** Registry traffic served by the forge's mirror or registry handler (never scored). */
const REGISTRY_KINDS = new Set(["mirror", "registry"]);
const REGISTRY_HOST_SET = new Set(["registry.npmjs.org", "registry.yarnpkg.com", "npm.jsr.io", "pypi.org", "files.pythonhosted.org"]);

/**
 * True when a call can move the score (lib/engine/score.ts deriveBehaviour):
 * any non-DNS call that is not plain registry traffic, any refused TLS
 * handshake, and any DNS name long enough to be a tunneling shape. These are
 * kept past the display cap so a flood of benign calls can never push a
 * scored call out of the record.
 */
/** True for plain registry traffic: a registry host served by the mirror or registry handler, or its DNS lookup. */
export function isRegistryCall(c: ForgedCallData): boolean {
  if (!REGISTRY_HOST_SET.has(c.host) || c.canary_hits.length > 0 || c.tls === "refused") return false;
  return c.proto === "dns" || REGISTRY_KINDS.has(c.forged_kind);
}

export function isScoreRelevantCall(c: ForgedCallData): boolean {
  if (c.canary_hits.length > 0) return true;
  if (c.tls === "refused") return true;
  if (c.proto === "dns") return c.host.length > 40;
  return !(REGISTRY_KINDS.has(c.forged_kind) && REGISTRY_HOST_SET.has(c.host));
}

export interface CaptureSummary {
  forgedCalls: ForgedCallData[];
  /** Records from harness phases (probe, collect): excluded from behaviour. */
  harnessRecords: number;
  /** Registry blobs the forge refused because their digest did not match. */
  integrityMismatches: Array<{ host: string; path: string | null }>;
  /** Plain (not score-relevant) calls left out of the display list past MAX_FORGED_EVENTS. */
  droppedForgedCalls: number;
  /** Metadata the forge served from the seeded mirror because upstream failed. */
  mirrorMetadata: Array<{ host: string; path: string | null }>;
}

export function summarizeCapture(records: CaptureRecord[], m: CanaryMatcher): CaptureSummary {
  const forgedCalls: ForgedCallData[] = [];
  const integrityMismatches: CaptureSummary["integrityMismatches"] = [];
  const mirrorMetadata: CaptureSummary["mirrorMetadata"] = [];
  const relevantSeen = new Set<string>();
  let harness = 0;
  let dropped = 0;
  for (const r of records) {
    if (r.phase !== "install" && r.phase !== "entry") {
      harness++;
      continue;
    }
    if (r.integrity === "mismatch") integrityMismatches.push({ host: r.host, path: r.path });
    if (r.integrity === "mirror-metadata") mirrorMetadata.push({ host: r.host, path: r.path });
    const call: ForgedCallData = {
      phase: r.phase as Phase,
      proto: (PROTOS.has(r.proto) ? r.proto : "tcp") as ForgedCallData["proto"],
      host: r.host,
      port: r.port,
      ...(r.method ? { method: r.method } : {}),
      ...(r.path ? { path: r.path.slice(0, 512) } : {}),
      ...(r.sni ? { sni: r.sni } : {}),
      req_bytes: r.req_bytes,
      forged_kind: r.forged_kind,
      ...(r.tls === "intercepted" || r.tls === "refused" ? { tls: r.tls } : {}),
      canary_hits: recordCanaryHits(r, m),
      ...(r.t > 0 ? { at: Math.round(r.t * 1000) } : {}),
    };
    if (forgedCalls.length < MAX_FORGED_EVENTS) {
      forgedCalls.push(call);
      if (isScoreRelevantCall(call)) relevantSeen.add(`${call.proto}|${call.host}|${call.tls ?? ""}`);
      continue;
    }
    // Past the display cap: every canary hit is kept, and the first call per
    // distinct scored shape (proto, host, TLS outcome) is kept, so the score
    // sees exactly what an uncapped list would give it. Plain calls are dropped.
    if (call.canary_hits.length > 0) {
      forgedCalls.push(call);
      continue;
    }
    if (isScoreRelevantCall(call)) {
      const key = `${call.proto}|${call.host}|${call.tls ?? ""}`;
      if (!relevantSeen.has(key)) {
        relevantSeen.add(key);
        forgedCalls.push(call);
        continue;
      }
    }
    dropped++;
  }
  return { forgedCalls, harnessRecords: harness, integrityMismatches, droppedForgedCalls: dropped, mirrorMetadata };
}
