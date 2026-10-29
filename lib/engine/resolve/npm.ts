/**
 * npm target resolution (DESIGN.md sections 2.2, 4, 7.3).
 *
 * One packument read gives the version (exact or dist-tag), the published
 * tarball URL and its `dist.integrity`, plus the reputation facts (first
 * publish, per-version publish time and maintainers). The tarball must live on
 * registry.npmjs.org and its bytes must match the published SRI hash before
 * anything downstream sees them.
 */

import { EngineError } from "../types";
import { USER_AGENT, fetchWithDeadline, readCapped, sha512Sri, verifySha1Hex, verifySri, type FetchLike, type SriAlgo } from "./http";

export const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_HOST = "registry.npmjs.org";

const SCOPED_RE = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/i;
const UNSCOPED_RE = /^[a-z0-9][a-z0-9._~-]*$/i;

export interface NpmTargetSpec {
  name: string;
  version?: string;
}

export function isValidNpmName(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false;
  return SCOPED_RE.test(name) || UNSCOPED_RE.test(name);
}

/**
 * Parse `npm:pkg[@v]`, an npmjs.com package URL, `@scope/name[@v]`, or a bare
 * `name[@v]`. A value with a slash that is not a scoped name is left for the
 * GitHub parser (returns null).
 */
export function parseNpmTarget(input: string): NpmTargetSpec | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  const url = /^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/(@[^/]+\/[^/@?#]+|[^/@?#]+)(?:\/v\/([^/?#]+))?/i.exec(s);
  if (url) {
    const name = decodeURIComponent(url[1]!);
    const version = url[2] ? decodeURIComponent(url[2]) : undefined;
    return isValidNpmName(name) ? { name, ...(version ? { version } : {}) } : null;
  }
  const explicit = /^npm:(.+)$/i.exec(s);
  if (explicit) s = explicit[1]!.trim();
  let name = s;
  let version: string | undefined;
  const at = s.lastIndexOf("@");
  if (at > 0) {
    name = s.slice(0, at);
    version = s.slice(at + 1) || undefined;
  }
  name = name.trim();
  if (!isValidNpmName(name)) return null;
  return { name, ...(version ? { version } : {}) };
}

export function encodeNpmName(name: string): string {
  return name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
}

export interface VersionPublish {
  version: string;
  publishedAt: string;
  maintainers: string[];
}

export interface NpmResolution {
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string | null;
  shasum: string | null;
  description: string | null;
  license: string | null;
  scripts: Record<string, string>;
  repositoryUrl: string | null;
  publisher: string | null;
  maintainers: string[];
  firstPublishedAt: string | null;
  publishedAt: string | null;
  versionCount: number;
  /** Publish history sorted oldest first (at most the 200 most recent versions). */
  history: VersionPublish[];
}

export interface NpmContext {
  fetch: FetchLike;
  timeoutMs: number;
  maxPackumentBytes: number;
  signal?: AbortSignal;
}

interface PackumentVersion {
  version?: string;
  description?: string;
  license?: unknown;
  scripts?: Record<string, unknown>;
  repository?: { url?: string } | string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
  maintainers?: Array<{ name?: string }>;
  _npmUser?: { name?: string };
}

interface Packument {
  name?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
  time?: Record<string, string>;
  maintainers?: Array<{ name?: string }>;
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (m && typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name.trim() : ""))
    .filter((n) => n.length > 0);
}

function licenseOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") return (v as { type: string }).type;
  return null;
}

/** Choose the manifest for an exact version or a dist-tag (default `latest`). */
export function pickVersion(pack: Packument, requested: string | undefined, name?: string): string {
  const versions = pack.versions ?? {};
  const wanted = requested ?? "latest";
  if (Object.prototype.hasOwnProperty.call(versions, wanted)) return wanted;
  const tagged = pack["dist-tags"]?.[wanted];
  if (tagged && Object.prototype.hasOwnProperty.call(versions, tagged)) return tagged;
  throw new EngineError("not_found", name ? `npm package "${name}" has no published version or dist-tag "${wanted}"` : `version or dist-tag "${wanted}" is not published`);
}

export function summarizePackument(pack: Packument, name: string, requested: string | undefined): NpmResolution {
  const version = pickVersion(pack, requested, name);
  const m = pack.versions![version]!;
  const tarballUrl = m.dist?.tarball ?? "";
  const scripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.scripts ?? {})) if (typeof v === "string") scripts[k] = v;
  const time = pack.time ?? {};
  const history: VersionPublish[] = Object.entries(pack.versions ?? {})
    .map(([v, man]) => ({ version: v, publishedAt: time[v] ?? "", maintainers: names(man?.maintainers) }))
    .filter((h) => h.publishedAt !== "" && !Number.isNaN(Date.parse(h.publishedAt)))
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    .slice(-200);
  const repo = typeof m.repository === "string" ? m.repository : (m.repository?.url ?? null);
  const current = names(pack.maintainers);
  return {
    name,
    version,
    tarballUrl,
    integrity: typeof m.dist?.integrity === "string" ? m.dist.integrity : null,
    shasum: typeof m.dist?.shasum === "string" ? m.dist.shasum : null,
    description: typeof m.description === "string" ? m.description : null,
    license: licenseOf(m.license),
    scripts,
    repositoryUrl: repo,
    publisher: typeof m._npmUser?.name === "string" && m._npmUser.name ? m._npmUser.name : null,
    maintainers: current.length > 0 ? current : names(m.maintainers),
    firstPublishedAt: typeof time.created === "string" ? time.created : null,
    publishedAt: typeof time[version] === "string" ? time[version]! : null,
    versionCount: Object.keys(pack.versions ?? {}).length,
    history,
  };
}

export async function resolveNpm(spec: NpmTargetSpec, ctx: NpmContext): Promise<NpmResolution> {
  if (!isValidNpmName(spec.name)) throw new EngineError("invalid_target", "not a valid npm package name");
  const res = await fetchWithDeadline(
    ctx.fetch,
    `${REGISTRY}/${encodeNpmName(spec.name)}`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    ctx.timeoutMs,
    ctx.signal,
  );
  if (res.status === 404) {
    await res.body?.cancel();
    throw new EngineError("not_found", `npm package "${spec.name}" is not on the public registry`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError("upstream", `npm registry returned HTTP ${res.status}`);
  }
  const bytes = await readCapped(res, ctx.maxPackumentBytes);
  let pack: Packument;
  try {
    pack = JSON.parse(new TextDecoder().decode(bytes)) as Packument;
  } catch {
    throw new EngineError("upstream", "npm packument is not valid JSON");
  }
  if (!pack.versions || typeof pack.versions !== "object") {
    throw new EngineError("not_found", `npm package "${spec.name}" has no published versions`);
  }
  return summarizePackument(pack, spec.name, spec.version);
}

export interface VerifiedTarball {
  bytes: Uint8Array;
  algo: SriAlgo;
  /** sha512 SRI of the bytes we hold (the report key, section 7.3). */
  sha512: string;
}

/** Refuse any tarball URL that is not https on registry.npmjs.org. */
export function assertRegistryTarball(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new EngineError("upstream", "npm manifest has no usable tarball URL");
  }
  if (u.protocol !== "https:" || u.host !== REGISTRY_HOST) {
    throw new EngineError("integrity", `refusing a tarball hosted off the public registry (${u.host})`);
  }
}

export function verifyNpmBytes(bytes: Uint8Array, integrity: string | null, shasum: string | null): SriAlgo {
  if (integrity) return verifySri(bytes, integrity);
  if (shasum) return verifySha1Hex(bytes, shasum);
  throw new EngineError("integrity", "the registry published no integrity digest for this version");
}

export async function fetchNpmTarball(r: NpmResolution, ctx: NpmContext, maxBytes: number): Promise<VerifiedTarball> {
  assertRegistryTarball(r.tarballUrl);
  const res = await fetchWithDeadline(ctx.fetch, r.tarballUrl, { headers: { "User-Agent": USER_AGENT } }, ctx.timeoutMs, ctx.signal);
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError(res.status === 404 ? "not_found" : "upstream", `registry returned HTTP ${res.status} for the tarball`);
  }
  if (res.url) assertRegistryTarball(res.url);
  const bytes = await readCapped(res, maxBytes);
  const algo = verifyNpmBytes(bytes, r.integrity, r.shasum);
  return { bytes, algo, sha512: sha512Sri(bytes) };
}

/** The `commit_sha` key a report row uses for npm (section 7.3). */
export function npmCommitKey(version: string, sha512: string): string {
  return `${version}+${sha512}`;
}
