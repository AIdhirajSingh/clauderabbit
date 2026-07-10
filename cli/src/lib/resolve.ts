/**
 * Resolve a user-supplied scan target into something the ClaudeRabbit API
 * understands — EITHER a GitHub repo (`owner/repo` + optional ref) OR an npm
 * package target (`{ package, version? }`).
 *
 * The API now scans the REAL published npm ARTIFACT (its tarball bytes, install
 * hooks and all), so an npm name is passed THROUGH as an npm target rather than
 * being redirected to its linked GitHub repo. Resolving a name to its
 * `repository` repo — what this CLI used to do — was blind to exactly the
 * compromised-publish supply-chain attack an install-time check most needs to
 * catch: a malicious version published only to the registry, pointing
 * `repository` at an innocent, high-reputation repo. The registry→GitHub
 * redirect is therefore gone; the edge function does the real npm work.
 *
 * Accepted target shapes:
 *   - owner/repo                          → GitHub { owner, repo }
 *   - owner/repo@ref  or  owner/repo#ref  → GitHub { owner, repo, ref }
 *   - https://github.com/owner/repo[/...] (also git@ and .git) → GitHub
 *   - a bare npm name (`lodash`), a scoped `@scope/name`, an explicit
 *     `npm:pkg[@version]`, or an `https://npmjs.com/package/<name>[/v/<version>]`
 *     URL → npm { package, version? }
 *
 * This parser only needs to DETECT npm and extract `{ package, version }`; the
 * edge function re-validates the npm name authoritatively. It is deliberately
 * conservative: a plain `owner/repo` (exactly one slash, NOT `@`-scoped) is
 * always a GitHub target, never npm.
 */

export type ResolvedTarget =
  | { via: "github"; owner: string; repo: string; ref?: string }
  | { via: "npm"; package: string; version?: string };

const GITHUB_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i;

// git@github.com:owner/repo(.git)  OR  ssh://git@github.com/owner/repo(.git)
const SSH_URL_RE =
  /^(?:ssh:\/\/)?git@github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?$/i;

/** Strip a trailing `@ref` / `#ref` and return [base, ref?]. */
function splitRef(token: string): { base: string; ref?: string } {
  // `#ref` is unambiguous. `@ref` is ambiguous with a scoped npm name
  // (`@scope/name`), so only treat `@` as a ref separator when it is NOT the
  // leading char (scoped package) — i.e. an `@` that appears after a `/`.
  const hashIdx = token.indexOf("#");
  if (hashIdx > 0) {
    return { base: token.slice(0, hashIdx), ref: token.slice(hashIdx + 1) || undefined };
  }
  const slashIdx = token.indexOf("/");
  const atIdx = token.lastIndexOf("@");
  if (atIdx > 0 && atIdx > slashIdx) {
    return { base: token.slice(0, atIdx), ref: token.slice(atIdx + 1) || undefined };
  }
  return { base: token };
}

/** Is this token an `owner/repo` pair (not a scoped npm name like `@a/b`)? */
function looksLikeOwnerRepo(token: string): boolean {
  if (token.startsWith("@")) return false; // @scope/name is npm's scoped form
  const parts = token.split("/");
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

// npm name grammar — mirrors the edge's `_shared/npm.ts` (isValidNpmName). The
// client only DETECTS npm and extracts the target; the edge validates for real.
const NPM_SCOPED_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const NPM_UNSCOPED_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function isValidNpmName(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false;
  return NPM_SCOPED_RE.test(name) || NPM_UNSCOPED_RE.test(name);
}

/** A parsed npm target — package name (+ optional version/dist-tag). */
interface NpmTarget {
  package: string;
  version?: string;
}

/**
 * Parse a raw string into an npm target, or null when it is not one. Mirrors
 * the edge's `parseNpmTarget` grammar (so the two never disagree about what is
 * an npm target). Recognizes: `npm:pkg`, `npm:pkg@1.2.3`, an npmjs.com package
 * URL, a scoped `@scope/name[@version]`, and a bare unscoped `name[@version]`.
 * Returns null for anything else — notably a plain `owner/repo`, which contains
 * a `/` yet is not a scoped name, so the GitHub parser handles it.
 */
function parseNpmTarget(input: string): NpmTarget | null {
  let s = input.trim();
  if (!s) return null;

  // npmjs.com/package/<name>[/v/<version>]
  const urlMatch = s.match(
    /^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/(@[^/]+\/[^/@?#]+|[^/@?#]+)(?:\/v\/([^/?#]+))?/i,
  );
  if (urlMatch) {
    const name = decodeURIComponent(urlMatch[1]);
    const version = urlMatch[2] ? decodeURIComponent(urlMatch[2]) : undefined;
    return isValidNpmName(name) ? { package: name, ...(version ? { version } : {}) } : null;
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
  return { package: name, ...(version ? { version } : {}) };
}

/**
 * Resolve a raw target string into a GitHub repo or an npm package target.
 * Synchronous — no network is touched here anymore: the npm registry work that
 * used to happen in this module is now done authoritatively (and against the
 * real published artifact) inside the edge function.
 */
export function resolveTarget(raw: string): ResolvedTarget {
  const input = raw.trim();
  if (!input) throw new Error("No scan target provided.");

  // 1. Explicit GitHub URL (ssh, https, or github.com shorthand).
  const ssh = SSH_URL_RE.exec(input);
  if (ssh) return { via: "github", owner: ssh[1], repo: stripGit(ssh[2]) };

  if (/github\.com/i.test(input)) {
    const m = GITHUB_URL_RE.exec(input);
    if (m) return { via: "github", owner: m[1], repo: stripGit(m[2]) };
    throw new Error(`Could not parse a GitHub owner/repo out of "${input}".`);
  }

  // 2. Explicit / unambiguous npm forms (npmjs.com URL, `npm:` prefix, a scoped
  //    `@scope/name`, or a bare unscoped name). parseNpmTarget returns null for
  //    a plain `owner/repo`, so this never steals a GitHub target — but it DOES
  //    correctly claim `npm:@scope/pkg`, which the owner/repo heuristic below
  //    would otherwise misread as a repo.
  const npm = parseNpmTarget(input);
  if (npm) return { via: "npm", package: npm.package, ...(npm.version ? { version: npm.version } : {}) };

  // 3. owner/repo (with optional @ref or #ref).
  const { base, ref } = splitRef(input);
  if (looksLikeOwnerRepo(base)) {
    const [owner, repo] = base.split("/");
    return { via: "github", owner, repo: stripGit(repo), ...(ref ? { ref } : {}) };
  }

  throw new Error(`Could not recognize "${input}" as a GitHub repo or npm package.`);
}

function stripGit(repo: string): string {
  return repo.replace(/\.git$/i, "");
}
