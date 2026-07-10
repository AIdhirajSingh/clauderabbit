/**
 * GitHub repo reference parser.
 *
 * Accepts the shapes a user is likely to paste and normalizes them to
 * `{ owner, repo }`, or returns `null` when no valid owner/repo can be found:
 *   - `owner/repo`
 *   - `github.com/owner/repo`
 *   - `https://github.com/owner/repo`
 *   - full URLs with extra path segments (`/tree/main`, `/blob/...`, `#...`, `?...`)
 *   - trailing `.git`
 *   - leading `git@github.com:owner/repo.git` (SSH)
 *   - `www.` prefix
 *
 * The owner/repo charset matches the edge function's `isValidOwnerRepo`
 * (`/^[A-Za-z0-9._-]{1,100}$/`) so anything that parses here is acceptable to
 * the backend; invalid characters cause a `null` (treated as a bad input by the
 * caller) rather than a doomed request.
 */

export interface ParsedRepo {
  owner: string;
  repo: string;
}

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/** Strip a single trailing ".git" suffix from a repo segment. */
function stripGitSuffix(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}

function valid(owner: string, repo: string): ParsedRepo | null {
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  // A bare "." or ".." is not a real owner/repo even though the charset allows it.
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return { owner, repo };
}

/**
 * Parse a pasted GitHub reference into `{ owner, repo }`, or `null` if it does
 * not resolve to a valid owner/repo pair.
 */
export function parseRepoInput(input: string): ParsedRepo | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;

  // SSH form: git@github.com:owner/repo(.git)
  const ssh = s.match(/^git@github\.com:(.+)$/i);
  if (ssh && ssh[1]) {
    s = ssh[1];
  } else {
    // Drop a leading scheme so URL-ish and bare inputs share one code path.
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    // Drop a leading github.com host (with optional www.).
    s = s.replace(/^(www\.)?github\.com\//i, "");
  }

  // Drop any query string / fragment.
  s = s.split(/[?#]/)[0] ?? "";

  // Split into path segments, dropping empties from leading/trailing slashes.
  const parts = s.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repoRaw = parts[1];
  if (!owner || !repoRaw) return null;

  return valid(owner, stripGitSuffix(repoRaw));
}

// ─────────────────────────── npm scan targets ───────────────────────────
// The scan surface now accepts an npm PACKAGE in addition to a GitHub repo.
// This client-side parser only needs to DETECT an npm target and extract
// `{ package, version }` — the `scan` edge function re-validates authoritatively
// (supabase/functions/_shared/npm.ts, a Deno module that must NOT be imported
// here). The name grammar below mirrors that module's `isValidNpmName`.

/** A parsed scan target: either a GitHub repo or an npm package. */
export type ScanTarget =
  | { kind: "github"; owner: string; repo: string; ref?: string }
  | { kind: "npm"; package: string; version?: string };

const NPM_SCOPED = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const NPM_UNSCOPED = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * `npmjs.com` package URL — captures the (possibly scoped) name and an optional
 * `/v/<version>`. Mirrors the edge function's URL matcher so both agree on shape.
 */
const NPM_URL =
  /^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/(@[^/]+\/[^/@?#]+|[^/@?#]+)(?:\/v\/([^/?#]+))?/i;

/** Validate a bare npm package name (scoped or unscoped) against npm's grammar. */
function isValidNpmName(name: string): boolean {
  if (!name || name.length > 214) return false;
  return NPM_SCOPED.test(name) || NPM_UNSCOPED.test(name);
}

/** Best-effort percent-decode; returns the input unchanged when it is malformed. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Split a bare npm spec `name[@version]` into `{ package, version? }`, or `null`
 * when the name is not a valid npm name. Uses `lastIndexOf("@")` with an
 * `at > 0` guard so a leading scope `@` (e.g. `@scope/name`) is never mistaken
 * for a version separator — matching the edge function's parser.
 */
function splitNpmSpec(spec: string): { package: string; version?: string } | null {
  let name = spec.trim();
  if (!name) return null;
  let version: string | undefined;
  const at = name.lastIndexOf("@");
  if (at > 0) {
    version = name.slice(at + 1).trim() || undefined;
    name = name.slice(0, at).trim();
  }
  if (!isValidNpmName(name)) return null;
  return version ? { package: name, version } : { package: name };
}

/**
 * Parse a pasted scan target into a discriminated union, or `null` when it is
 * neither a recognizable npm package nor a GitHub owner/repo.
 *
 * Detection order (per the shared npm contract):
 *   1. Unambiguous npm shapes first — an `npmjs.com/package/...` URL, an explicit
 *      `npm:pkg[@version]` prefix, or a scoped `@scope/name[@version]`.
 *   2. Otherwise, the existing GitHub owner/repo parsing (`parseRepoInput`), so a
 *      plain `owner/repo`, a github.com URL, or an SSH ref stays GitHub — exactly
 *      as before.
 *   3. Finally, a single bare token with no slash that is a valid npm name is
 *      treated as an npm package.
 *
 * `parseRepoInput` is left exported and unchanged for back-compat.
 */
export function parseScanTarget(input: string): ScanTarget | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;

  // 1a. `npmjs.com/package/<name>[/v/<version>]` URL.
  const url = s.match(NPM_URL);
  if (url) {
    const raw = url[1];
    if (!raw) return null;
    const pkg = safeDecode(raw);
    if (!isValidNpmName(pkg)) return null;
    const version = url[2] ? safeDecode(url[2]) : undefined;
    return { kind: "npm", package: pkg, ...(version ? { version } : {}) };
  }

  // 1b. Explicit `npm:` prefix removes all ambiguity with owner/repo.
  const explicit = s.match(/^npm:(.+)$/i);
  if (explicit && explicit[1]) {
    const spec = splitNpmSpec(explicit[1]);
    return spec ? { kind: "npm", ...spec } : null;
  }

  // 1c. A scoped `@scope/name` is unambiguously npm (never a GitHub owner/repo).
  if (s.startsWith("@")) {
    const spec = splitNpmSpec(s);
    return spec ? { kind: "npm", ...spec } : null;
  }

  // 2. Existing GitHub parsing (unchanged) — a plain `owner/repo` stays GitHub.
  const gh = parseRepoInput(s);
  if (gh) return { kind: "github", owner: gh.owner, repo: gh.repo };

  // 3. A single bare token with no slash that is a valid npm name → npm.
  if (!s.includes("/")) {
    const spec = splitNpmSpec(s);
    if (spec) return { kind: "npm", ...spec };
  }

  return null;
}
