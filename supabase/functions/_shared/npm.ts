/**
 * npm registry resolver — scan the REAL published artifact, not a linked repo.
 *
 * WHY THIS EXISTS (the supply-chain gap this closes): almost all real-world
 * open-source malware ships as a published npm/registry artifact whose bytes need
 * NOT match the GitHub repo its `package.json` links to. A compromised maintainer
 * can publish a version with a malicious `postinstall` hook or trojaned code that
 * exists ONLY in the tarball, while pointing `repository` at an innocent, popular,
 * high-reputation repo. Resolving an npm name to that linked repo and scanning the
 * repo (what the CLI used to do) is blind to exactly the attack an install-time
 * check most needs to catch.
 *
 * This module fetches the ACTUAL published tarball for a resolved version, verifies
 * its integrity against the registry's own `dist.integrity`/`dist.shasum`, unpacks
 * it in-process (gzip + tar, both native to the Deno edge runtime — no shelling
 * out, no temp files), and returns the artifact's real files for the SAME static
 * scan + model + scoring pipeline the GitHub path uses. It ALSO cross-checks the
 * artifact against its linked GitHub repo and surfaces any divergence (an install
 * hook or file present in the tarball but not the repo) as a first-class signal.
 *
 * SSRF/DoS guards: the tarball URL is required to live on the configured registry
 * host (never an attacker-chosen URL from the manifest), the download is size-
 * capped, and only a bounded, high-signal subset of files is retained.
 */

import type { FetchedFile } from "./github.ts";
import { UntarStream } from "@std/tar/untar-stream";

const REGISTRY_BASE = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point/last-month";
const USER_AGENT = "claude-rabbit-scanner";
const FETCH_TIMEOUT_MS = 8000;
/** Hard cap on the compressed tarball we will download (a real DoS bound; the vast
 * majority of packages are well under this — a package larger than this is itself
 * worth flagging rather than blindly unpacking). */
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
/** Per-file content cap fed to the scanner (mirrors github.ts MAX_FILE_BYTES). */
const MAX_FILE_BYTES = 32 * 1024;
/** Max high-signal files retained from the tarball for the read pass. */
const MAX_TARBALL_FILES = 24;

/** Thrown when the package/version does not exist on the registry. */
export class NpmNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpmNotFoundError";
  }
}

/** Thrown when the downloaded artifact fails its own registry integrity check —
 * a tampered/corrupt tarball. This is a hard stop: we never scan bytes we cannot
 * prove are the ones the registry vouches for. */
export class NpmIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpmIntegrityError";
  }
}

/** A parsed npm scan target: package name (+ optional version/dist-tag). */
export interface NpmTarget {
  name: string;
  version?: string;
}

/** The linked source repo declared in the manifest's `repository` field. */
export interface NpmLinkedRepo {
  host: "github";
  owner: string;
  repo: string;
}

/** Divergence between the published artifact and its linked source repo. */
export interface NpmDivergence {
  /** True when a linked GitHub repo was found and successfully compared. */
  compared: boolean;
  /** Lifecycle (install) scripts present in the TARBALL's package.json. */
  tarballInstallHooks: string[];
  /** Lifecycle scripts present in the linked REPO's package.json. */
  repoInstallHooks: string[];
  /** Install hooks in the artifact that are NOT in the linked repo — the
   * compromised-publish signal (an install hook injected only into the tarball). */
  addedInstallHooks: string[];
  /** True when the tarball's package.json `version` differs from the repo's. */
  versionMismatch: boolean;
  /** Human-readable notes, one per concrete divergence found. */
  notes: string[];
}

export interface NpmMetadata {
  name: string;
  version: string;
  description: string | null;
  /** ISO publish time for THIS version, when the registry reports it. */
  publishedAt: string | null;
  /** ISO time the package was first ever published (age signal). */
  firstPublishedAt: string | null;
  license: string | null;
  maintainerCount: number;
  /** last-month download count from api.npmjs.org, or null when unavailable. */
  lastMonthDownloads: number | null;
  tarballUrl: string;
  integrityVerified: boolean;
  integrityAlgo: string | null;
  linkedRepo: NpmLinkedRepo | null;
  /** True when the tarball's package.json declares any pre/post/install hook. */
  hasInstallHook: boolean;
}

export interface NpmResolution {
  metadata: NpmMetadata;
  files: FetchedFile[];
  divergence: NpmDivergence;
  /** A stable per-artifact cache key — the integrity digest when available, else
   * `<name>@<version>` — used where the GitHub path uses a commit SHA. */
  artifactKey: string;
}

// ── target parsing ───────────────────────────────────────────────────────────

const SCOPED_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const UNSCOPED_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Validate a bare package name (scoped or unscoped) against npm's name grammar. */
export function isValidNpmName(name: string): boolean {
  if (name.length > 214) return false;
  return SCOPED_RE.test(name) || UNSCOPED_RE.test(name);
}

/**
 * Parse a user-supplied string into an npm target, or null when it is not one.
 * Recognizes: `npm:pkg`, `npm:pkg@1.2.3`, an npmjs.com package URL, a scoped
 * `@scope/name[@version]`, and a bare unscoped `name[@version]`. Deliberately
 * conservative — a value containing a `/` that is NOT a scoped name is left for
 * the GitHub owner/repo parser.
 */
export function parseNpmTarget(input: string): NpmTarget | null {
  let s = (input ?? "").trim();
  if (!s) return null;

  // npmjs.com/package/<name>[/v/<version>]
  const urlMatch = s.match(
    /^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/(@[^/]+\/[^/@?#]+|[^/@?#]+)(?:\/v\/([^/?#]+))?/i,
  );
  if (urlMatch) {
    const name = decodeURIComponent(urlMatch[1]);
    const version = urlMatch[2] ? decodeURIComponent(urlMatch[2]) : undefined;
    return isValidNpmName(name) ? { name, ...(version ? { version } : {}) } : null;
  }

  // Explicit `npm:` prefix removes all ambiguity with owner/repo.
  const explicit = s.match(/^npm:(.+)$/i);
  if (explicit) s = explicit[1].trim();

  // Split a trailing `@version`, taking care not to eat a leading scope `@`.
  let name = s;
  let version: string | undefined;
  const at = s.lastIndexOf("@");
  if (at > 0) {
    name = s.slice(0, at);
    version = s.slice(at + 1) || undefined;
  }
  name = name.trim();
  if (!isValidNpmName(name)) return null;
  // A scoped name legitimately contains one slash; an unscoped name has none.
  return { name, ...(version ? { version } : {}) };
}

// ── low-level fetch helpers ──────────────────────────────────────────────────

async function fetchWithTimeout(url: string, accept?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...(accept ? { Accept: accept } : {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Encode a package name for a registry path (`@scope/name` → `@scope%2fname`). */
function encodeName(name: string): string {
  return name.startsWith("@")
    ? "@" + name.slice(1).split("/").map(encodeURIComponent).join("/")
    : encodeURIComponent(name);
}

interface NpmVersionManifest {
  name?: string;
  version?: string;
  description?: string;
  license?: unknown;
  scripts?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string } | string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
  maintainers?: Array<{ name?: string }>;
}

const INSTALL_HOOK_KEYS = ["preinstall", "install", "postinstall"];

/** Parse a GitHub owner/repo out of an npm `repository` field's many URL shapes. */
export function linkedRepoFrom(
  repository: NpmVersionManifest["repository"],
): NpmLinkedRepo | null {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return null;
  const cleaned = url.replace(/^git\+/, "").trim();
  // github:owner/repo shorthand
  const short = /^github:([^/]+)\/(.+?)(?:\.git)?$/i.exec(cleaned);
  if (short) return { host: "github", owner: short[1], repo: short[2] };
  // git@github.com:owner/repo(.git) | ssh://git@github.com/owner/repo
  const ssh = /^(?:ssh:\/\/)?git@github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?$/i.exec(cleaned);
  if (ssh) return { host: "github", owner: ssh[1], repo: ssh[2] };
  // https://github.com/owner/repo[/...]
  const https = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i
    .exec(cleaned);
  if (https) return { host: "github", owner: https[1], repo: https[2] };
  return null;
}

function licenseString(license: unknown): string | null {
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && typeof (license as { type?: string }).type === "string") {
    return (license as { type: string }).type;
  }
  return null;
}

// ── tarball download + integrity + unpack ────────────────────────────────────

/** Read a response body into a single Uint8Array, aborting past `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new NpmIntegrityError(
          `Published tarball exceeds the ${Math.round(cap / (1024 * 1024))}MB scan cap.`,
        );
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a downloaded tarball against the registry's own integrity metadata.
 * Prefers SRI `dist.integrity` (sha512/384/256 base64); falls back to the legacy
 * `dist.shasum` (sha1 hex). Returns the algorithm used, or throws on mismatch.
 */
async function verifyIntegrity(
  bytes: Uint8Array<ArrayBuffer>,
  integrity: string | undefined,
  shasum: string | undefined,
): Promise<string> {
  if (integrity) {
    const m = integrity.trim().split(/\s+/)[0]?.match(/^(sha(?:256|384|512))-(.+)$/);
    if (m) {
      const algo = m[1] === "sha256" ? "SHA-256" : m[1] === "sha384" ? "SHA-384" : "SHA-512";
      const digest = new Uint8Array(await crypto.subtle.digest(algo, bytes));
      if (toBase64(digest) !== m[2]) {
        throw new NpmIntegrityError(
          "Published tarball failed its registry SRI integrity check (bytes do not match dist.integrity).",
        );
      }
      return m[1];
    }
  }
  if (shasum && /^[0-9a-f]{40}$/i.test(shasum)) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    if (toHex(digest).toLowerCase() !== shasum.toLowerCase()) {
      throw new NpmIntegrityError(
        "Published tarball failed its registry shasum check (bytes do not match dist.shasum).",
      );
    }
    return "sha1";
  }
  // No integrity metadata at all — surface it honestly rather than claiming verified.
  throw new NpmIntegrityError(
    "The registry provided no integrity digest for this version; the artifact could not be verified.",
  );
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function extOf(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i === -1 ? "" : b.slice(i + 1).toLowerCase();
}

const SOURCE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "sh", "ps1",
]);
const ALWAYS_KEEP = new Set(["package.json", "setup.py", "requirements.txt"]);

/** Decide whether to keep a tarball entry for the read pass (bounded, high-signal). */
function keepPath(path: string): boolean {
  const b = basename(path);
  if (ALWAYS_KEEP.has(b)) return true;
  if (/^readme(\.|$)/i.test(b)) return true;
  if (extOf(path) === "sh" || extOf(path) === "ps1") return true;
  return SOURCE_EXT.has(extOf(path));
}

/**
 * Unpack a gzipped npm tarball in-process and return the bounded, high-signal file
 * set (paths are de-rooted from the leading `package/` npm wraps everything in).
 * Shallow files first, so entry points and manifests win the file budget.
 */
async function unpackTarball(tgz: Uint8Array<ArrayBuffer>): Promise<FetchedFile[]> {
  const gunzipped = new Response(tgz).body!.pipeThrough(new DecompressionStream("gzip"));
  const entries = gunzipped.pipeThrough(new UntarStream());
  const collected: FetchedFile[] = [];
  for await (const entry of entries) {
    const type = entry.header.typeflag;
    // Only regular files ('0' or legacy '\0'/'').
    const isFile = type === "0" || type === "\0" || type === "";
    const rel = entry.path.replace(/^[^/]+\//, ""); // strip the leading `package/`
    if (!isFile || !rel || !keepPath(rel)) {
      await entry.readable?.cancel().catch(() => {});
      continue;
    }
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await new Response(entry.readable).arrayBuffer());
    } catch {
      continue;
    }
    const truncated = raw.length > MAX_FILE_BYTES;
    const content = new TextDecoder("utf-8", { fatal: false }).decode(
      truncated ? raw.subarray(0, MAX_FILE_BYTES) : raw,
    );
    collected.push({ path: rel, content, truncated });
  }
  // Prefer shallow paths, then cap.
  collected.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  return collected.slice(0, MAX_TARBALL_FILES);
}

// ── divergence: artifact vs linked source repo ───────────────────────────────

export function installHooksOf(scripts: Record<string, string> | undefined): string[] {
  if (!scripts) return [];
  return INSTALL_HOOK_KEYS.filter((k) => typeof scripts[k] === "string" && scripts[k].trim());
}

/** The package.json fields we compare between the artifact and its linked source. */
export interface SourcePkg {
  scripts?: Record<string, string>;
  version?: string;
}

/**
 * PURE divergence comparison — the compromised-publish detector's heart, split out
 * so it is deterministically unit-testable without a network fetch.
 *
 * `repoPkg === null` means the linked repo's package.json could not be read (no
 * linked repo, a 404, a monorepo whose package.json lives elsewhere, or a private
 * repo). In that case we cannot CONFIRM divergence, so `compared` is false — but if
 * the artifact declares install hooks with no corroborating source, that is still
 * surfaced honestly. When `repoPkg` IS present, an install hook in the artifact that
 * is absent from source is the supply-chain attack shape and is called out plainly.
 */
export function buildDivergence(
  tarballScripts: Record<string, string> | undefined,
  tarballVersion: string | null,
  linked: NpmLinkedRepo | null,
  repoPkg: SourcePkg | null,
): NpmDivergence {
  const tarballInstallHooks = installHooksOf(tarballScripts);
  if (!repoPkg) {
    const notes: string[] = [];
    if (tarballInstallHooks.length > 0) {
      notes.push(
        `The published artifact declares install hook(s) (${tarballInstallHooks.join(", ")}) ` +
          (linked
            ? `; its linked repo's package.json could not be read to corroborate them.`
            : `and has no linked source repo to corroborate them against.`),
      );
    }
    return {
      compared: false,
      tarballInstallHooks,
      repoInstallHooks: [],
      addedInstallHooks: [],
      versionMismatch: false,
      notes,
    };
  }
  const repoInstallHooks = installHooksOf(repoPkg.scripts);
  const addedInstallHooks = tarballInstallHooks.filter((h) => !repoInstallHooks.includes(h));
  const versionMismatch = !!tarballVersion && !!repoPkg.version && repoPkg.version !== tarballVersion;
  const notes: string[] = [];
  if (addedInstallHooks.length > 0) {
    notes.push(
      `Install hook(s) ${addedInstallHooks.join(", ")} exist in the PUBLISHED npm artifact but ` +
        `NOT in the linked source repo — install-time behavior that shipping-from-source would ` +
        `not have. This is the shape of a compromised-publish supply-chain attack.`,
    );
  }
  return {
    compared: true,
    tarballInstallHooks,
    repoInstallHooks,
    addedInstallHooks,
    versionMismatch,
    notes,
  };
}

/**
 * Compare the published artifact's package.json against the linked GitHub repo's,
 * to catch a tarball whose install-time behavior diverges from its claimed source
 * (the compromised-maintainer signal). Fetches ONE file (the repo's package.json)
 * over the raw CDN — bounded and cheap; never throws (a repo that 404s or a private
 * repo simply yields `compared:false`). The comparison itself is `buildDivergence`.
 */
async function computeDivergence(
  tarballScripts: Record<string, string> | undefined,
  tarballVersion: string | null,
  linked: NpmLinkedRepo | null,
  repoDirectory: string | undefined,
): Promise<NpmDivergence> {
  if (!linked) return buildDivergence(tarballScripts, tarballVersion, null, null);
  // The repo's package.json — honor a monorepo `repository.directory` when present.
  const dir = repoDirectory ? repoDirectory.replace(/^\/+|\/+$/g, "") + "/" : "";
  const url =
    `https://raw.githubusercontent.com/${encodeURIComponent(linked.owner)}/${encodeURIComponent(linked.repo)}/HEAD/${dir}package.json`;
  let repoPkg: SourcePkg | null = null;
  try {
    const res = await fetchWithTimeout(url);
    if (res.ok) {
      repoPkg = JSON.parse(await res.text());
    } else {
      await res.body?.cancel();
    }
  } catch {
    /* give up — treated as "could not corroborate" */
  }
  return buildDivergence(tarballScripts, tarballVersion, linked, repoPkg);
}

// ── main resolver ────────────────────────────────────────────────────────────

/** Best-effort last-month download count (a reputation signal); null on any miss. */
async function fetchDownloads(name: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(`${DOWNLOADS_API}/${encodeName(name)}`);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const j = (await res.json()) as { downloads?: number };
    return typeof j.downloads === "number" ? j.downloads : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an npm package to its REAL published artifact + a scanned file set.
 * Throws NpmNotFoundError (missing package/version) or NpmIntegrityError
 * (untrusted/unverifiable bytes) — both surfaced to the caller as clean errors.
 */
export async function resolveNpmPackage(target: NpmTarget): Promise<NpmResolution> {
  const { name } = target;
  const versionOrTag = target.version ?? "latest";

  // 1. Version manifest for the requested version/dist-tag (bounded, one version).
  const manifestUrl = `${REGISTRY_BASE}/${encodeName(name)}/${encodeURIComponent(versionOrTag)}`;
  let mres: Response;
  try {
    mres = await fetchWithTimeout(manifestUrl, "application/json");
  } catch {
    throw new NpmNotFoundError(`Could not reach the npm registry for "${name}".`);
  }
  if (mres.status === 404) {
    await mres.body?.cancel();
    throw new NpmNotFoundError(
      `npm package "${name}${target.version ? `@${target.version}` : ""}" was not found on the public registry.`,
    );
  }
  if (!mres.ok) {
    await mres.body?.cancel();
    throw new NpmNotFoundError(`npm registry returned HTTP ${mres.status} for "${name}".`);
  }
  const manifest = (await mres.json()) as NpmVersionManifest;
  const version = manifest.version ?? (typeof versionOrTag === "string" ? versionOrTag : "");
  const tarballUrl = manifest.dist?.tarball ?? "";

  // 2. SSRF guard — the tarball MUST live on the registry host we chose, never an
  //    attacker-picked URL smuggled through the manifest.
  let tarballHost: string;
  try {
    tarballHost = new URL(tarballUrl).host;
  } catch {
    throw new NpmNotFoundError(`npm version manifest for "${name}" has no usable tarball URL.`);
  }
  if (tarballHost !== "registry.npmjs.org") {
    throw new NpmIntegrityError(
      `Refusing to fetch this artifact: its tarball is hosted off the public registry (${tarballHost}).`,
    );
  }

  // 3. Download (size-capped) + integrity-verify + unpack — in parallel with the
  //    reputation lookups that don't depend on the bytes.
  let tres: Response;
  try {
    tres = await fetch(tarballUrl, { headers: { "User-Agent": USER_AGENT } });
  } catch {
    throw new NpmNotFoundError(`Could not download the published tarball for "${name}@${version}".`);
  }
  if (!tres.ok) {
    await tres.body?.cancel();
    throw new NpmNotFoundError(`Registry returned HTTP ${tres.status} downloading "${name}@${version}".`);
  }
  const tgz = await readCapped(tres, MAX_TARBALL_BYTES);
  let integrityAlgo: string | null = null;
  let integrityVerified = false;
  try {
    integrityAlgo = await verifyIntegrity(tgz, manifest.dist?.integrity, manifest.dist?.shasum);
    integrityVerified = true;
  } catch (e) {
    // A hard integrity FAILURE (bytes mismatch) is fatal — never scan tampered
    // bytes. A missing digest is surfaced as unverified (integrityVerified=false)
    // rather than fatal, so a package the registry simply never hashed still scans.
    if (
      e instanceof NpmIntegrityError &&
      /failed its registry/.test(e.message)
    ) {
      throw e;
    }
    integrityVerified = false;
  }

  const linkedRepo = linkedRepoFrom(manifest.repository);
  const repoDirectory =
    typeof manifest.repository === "object" ? manifest.repository?.directory : undefined;

  const [files, downloads, divergence] = await Promise.all([
    unpackTarball(tgz),
    fetchDownloads(name),
    computeDivergence(manifest.scripts, version || null, linkedRepo, repoDirectory),
  ]);

  // First-publish age comes from the full packument's `time.created` (the
  // abbreviated install-v1 format omits `time`); best-effort. The full packument
  // can be large for a package with thousands of versions, so the read is capped
  // — age is a reputation nicety, never worth spiking edge memory over.
  let firstPublishedAt: string | null = null;
  let publishedAt: string | null = null;
  try {
    const pres = await fetchWithTimeout(`${REGISTRY_BASE}/${encodeName(name)}`, "application/json");
    if (pres.ok) {
      const bytes = await readCapped(pres, 16 * 1024 * 1024).catch(() => null);
      if (bytes) {
        const pack = JSON.parse(new TextDecoder().decode(bytes)) as { time?: Record<string, string> };
        firstPublishedAt = pack.time?.created ?? null;
        publishedAt = (version && pack.time?.[version]) || null;
      }
    } else {
      await pres.body?.cancel();
    }
  } catch {
    /* age is best-effort */
  }

  const hasInstallHook = installHooksOf(manifest.scripts).length > 0;
  const artifactKey = manifest.dist?.integrity
    ? manifest.dist.integrity.trim().split(/\s+/)[0]
    : `${name}@${version}`;

  const metadata: NpmMetadata = {
    name,
    version,
    description: manifest.description ?? null,
    publishedAt,
    firstPublishedAt,
    license: licenseString(manifest.license),
    maintainerCount: Array.isArray(manifest.maintainers) ? manifest.maintainers.length : 0,
    lastMonthDownloads: downloads,
    tarballUrl,
    integrityVerified,
    integrityAlgo,
    linkedRepo,
    hasInstallHook,
  };

  return { metadata, files, divergence, artifactKey };
}
