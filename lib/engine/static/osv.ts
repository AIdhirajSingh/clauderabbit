/**
 * OSV malicious-package lookup (DESIGN.md sections 2.2, 5.3).
 *
 * Pass 1 reads the dependencies a lockfile pins (package-lock.json v1/v2/v3,
 * requirements.txt `==` pins, uv.lock). Pass 2 reads what the detonation
 * actually installed (`npm ls --all --json`, `uv pip list --format json`).
 * Both go through `POST /v1/querybatch`, which returns ids only; an id with the
 * `MAL-` prefix is an OSV malicious-package record and drives the intel group.
 */

import { textOf } from "../archive";
import type { DependencyRef, MaliciousDependency } from "../types";
import { fetchWithDeadline, USER_AGENT, type FetchLike } from "../resolve/http";

export const OSV_QUERYBATCH = "https://api.osv.dev/v1/querybatch";
const BATCH_MAX = 1000;

function addDep(out: Map<string, DependencyRef>, ecosystem: DependencyRef["ecosystem"], name: string, version: string) {
  if (!name || !version) return;
  const n = ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
  out.set(`${ecosystem}:${n}@${version}`, { ecosystem, name: n, version });
}

/** Dependencies pinned in package-lock.json (lockfileVersion 1, 2 or 3). */
export function depsFromPackageLock(json: string): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  let lock: { packages?: Record<string, { version?: unknown; name?: unknown; link?: unknown }>; dependencies?: Record<string, unknown> };
  try {
    lock = JSON.parse(json);
  } catch {
    return [];
  }
  if (lock.packages && typeof lock.packages === "object") {
    for (const [key, v] of Object.entries(lock.packages)) {
      if (!key || !v || v.link === true || typeof v.version !== "string") continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue;
      const name = typeof v.name === "string" ? v.name : key.slice(idx + "node_modules/".length);
      addDep(out, "npm", name, v.version);
    }
  }
  const walkV1 = (deps: Record<string, unknown> | undefined) => {
    if (!deps) return;
    for (const [name, raw] of Object.entries(deps)) {
      const v = raw as { version?: unknown; dependencies?: Record<string, unknown> };
      if (typeof v?.version === "string" && !v.version.startsWith("file:") && !v.version.includes("://")) {
        addDep(out, "npm", name, v.version);
      }
      walkV1(v?.dependencies);
    }
  };
  if (!lock.packages) walkV1(lock.dependencies);
  return [...out.values()];
}

/** `name==version` pins in requirements.txt (extras and markers tolerated). */
export function depsFromRequirements(text: string): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9.!+_-]+)/.exec(line);
    if (m) addDep(out, "PyPI", m[1]!, m[2]!);
  }
  return [...out.values()];
}

/** `[[package]] name/version` entries in uv.lock. */
export function depsFromUvLock(text: string): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const editable = /^source\s*=\s*\{\s*(?:editable|virtual|directory)\s*=/m.test(block);
    if (name && version && !editable) addDep(out, "PyPI", name, version);
  }
  return [...out.values()];
}

/** Every lockfile-pinned dependency in an archive (pass 1). */
export function depsFromArchive(files: Map<string, Uint8Array>): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  const add = (list: DependencyRef[]) => {
    for (const d of list) out.set(`${d.ecosystem}:${d.name}@${d.version}`, d);
  };
  for (const [path, bytes] of files) {
    if (/(^|\/)node_modules\//.test(path)) continue;
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base !== "package-lock.json" && base !== "npm-shrinkwrap.json" && base !== "requirements.txt" && base !== "uv.lock") continue;
    const text = textOf(bytes);
    if (text === null) continue;
    if (base === "requirements.txt") add(depsFromRequirements(text));
    else if (base === "uv.lock") add(depsFromUvLock(text));
    else add(depsFromPackageLock(text));
  }
  return [...out.values()];
}

/** The installed tree from `npm ls --all --json` (pass 2). */
export function depsFromNpmLs(json: string): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  let root: { dependencies?: Record<string, unknown> };
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  const walk = (deps: Record<string, unknown> | undefined, depth: number) => {
    if (!deps || depth > 64) return;
    for (const [name, raw] of Object.entries(deps)) {
      const v = raw as { version?: unknown; dependencies?: Record<string, unknown> };
      if (typeof v?.version === "string") addDep(out, "npm", name, v.version);
      walk(v?.dependencies, depth + 1);
    }
  };
  walk(root.dependencies, 0);
  return [...out.values()];
}

/** The installed set from `uv pip list --format json` (pass 2). */
export function depsFromUvPipList(json: string): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  for (const item of list) {
    const v = item as { name?: unknown; version?: unknown; editable_project_location?: unknown };
    if (typeof v.name === "string" && typeof v.version === "string" && v.editable_project_location === undefined) {
      addDep(out, "PyPI", v.name, v.version);
    }
  }
  return [...out.values()];
}

/** `[{name, version}]` as the harness writes it for Go modules (`go list -m all`) and Cargo registry crates (`cargo metadata`). */
export function depsFromNameVersionList(json: string, ecosystem: "Go" | "crates.io"): DependencyRef[] {
  const out = new Map<string, DependencyRef>();
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  for (const item of list) {
    const v = item as { name?: unknown; version?: unknown };
    if (typeof v.name === "string" && typeof v.version === "string") addDep(out, ecosystem, v.name, v.version);
  }
  return [...out.values()];
}

interface QueryBatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string }>; next_page_token?: string }>;
}

/** Map one querybatch response onto its queries; returns per-dependency id lists. */
export function idsFromQueryBatch(deps: DependencyRef[], body: QueryBatchResponse): string[][] {
  const results = Array.isArray(body.results) ? body.results : [];
  if (results.length !== deps.length) {
    throw new Error(`OSV returned ${results.length} results for ${deps.length} queries`);
  }
  return results.map((r) => (Array.isArray(r?.vulns) ? r.vulns.map((v) => v?.id).filter((x): x is string => typeof x === "string") : []));
}

export function isMaliciousId(id: string): boolean {
  return id.startsWith("MAL-");
}

export interface OsvResult {
  queried: number;
  malicious: MaliciousDependency[];
  /** Non-malicious advisory ids (informational; they do not move the score). */
  advisories: Array<{ dep: DependencyRef; ids: string[] }>;
}

export async function queryOsv(
  deps: DependencyRef[],
  ctx: { fetch: FetchLike; timeoutMs: number; signal?: AbortSignal },
): Promise<OsvResult> {
  const malicious: MaliciousDependency[] = [];
  const advisories: OsvResult["advisories"] = [];
  for (let i = 0; i < deps.length; i += BATCH_MAX) {
    const chunk = deps.slice(i, i + BATCH_MAX);
    const res = await fetchWithDeadline(
      ctx.fetch,
      OSV_QUERYBATCH,
      {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })),
        }),
      },
      ctx.timeoutMs,
      ctx.signal,
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`OSV querybatch returned HTTP ${res.status}`);
    }
    const ids = idsFromQueryBatch(chunk, (await res.json()) as QueryBatchResponse);
    chunk.forEach((dep, j) => {
      const list = ids[j] ?? [];
      const mal = list.filter(isMaliciousId);
      if (mal.length > 0) malicious.push({ ...dep, ids: mal });
      const other = list.filter((id) => !isMaliciousId(id));
      if (other.length > 0) advisories.push({ dep, ids: other });
    });
  }
  return { queried: deps.length, malicious, advisories };
}
