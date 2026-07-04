/**
 * Resolve a user-supplied scan target into an { owner, repo, ref? } that the
 * ClaudeRabbit API understands. The API scans GitHub repos, so an npm package
 * name is resolved to its backing GitHub repo via the public npm registry.
 *
 * Accepted target shapes:
 *   - owner/repo                      → { owner, repo }
 *   - owner/repo@ref  or  owner/repo#ref  → { owner, repo, ref }
 *   - https://github.com/owner/repo[/...] (also git@ and .git)
 *   - an npm package name (lodash, @scope/pkg) → resolved via the npm registry
 *     `repository` field to its GitHub owner/repo
 *
 * The resolver is deliberately conservative: if a bare token looks like it
 * could be either an npm package or something else, it is treated as an npm
 * package ONLY when it does not contain a slash (a slash means owner/repo,
 * except for a leading `@scope/name`, which is npm's own scoped form).
 */

export interface ResolvedTarget {
  owner: string;
  repo: string;
  ref?: string;
  /** How the target was resolved — surfaced so output can be honest about it. */
  via: "github" | "npm";
  /** The npm package name, when resolution went through the registry. */
  npmPackage?: string;
}

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

interface NpmRepository {
  type?: string;
  url?: string;
}
interface NpmRegistryDoc {
  repository?: NpmRepository | string;
  name?: string;
}

/** Pull an owner/repo out of an npm `repository` field's URL. */
function githubFromRepositoryUrl(url: string): { owner: string; repo: string } | null {
  // Normalize the many shapes npm allows:
  //   git+https://github.com/owner/repo.git, git://github.com/owner/repo.git,
  //   git@github.com:owner/repo.git, https://github.com/owner/repo, github:owner/repo
  const cleaned = url.replace(/^git\+/, "").trim();

  const shorthand = /^github:([^/]+)\/(.+?)(?:\.git)?$/i.exec(cleaned);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };

  const ssh = SSH_URL_RE.exec(cleaned);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const m = GITHUB_URL_RE.exec(cleaned);
  if (m) return { owner: m[1], repo: m[2] };

  return null;
}

/**
 * Resolve an npm package name to its GitHub owner/repo via the public npm
 * registry. Throws a clear Error if the package is missing or has no usable
 * GitHub repository field.
 */
async function resolveNpmPackage(pkg: string): Promise<{ owner: string; repo: string }> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace("%40", "@")}/latest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error(`Timed out looking up npm package "${pkg}".`);
    }
    throw new Error(`Network error looking up npm package "${pkg}": ${(err as Error).message}`);
  }
  clearTimeout(timeout);

  if (res.status === 404) {
    throw new Error(`npm package "${pkg}" was not found on the public registry.`);
  }
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status} for "${pkg}".`);
  }

  let doc: NpmRegistryDoc;
  try {
    doc = (await res.json()) as NpmRegistryDoc;
  } catch {
    throw new Error(`npm registry returned an unreadable response for "${pkg}".`);
  }

  const repository = doc.repository;
  const repoUrl = typeof repository === "string" ? repository : repository?.url;
  if (!repoUrl) {
    throw new Error(
      `npm package "${pkg}" has no "repository" field, so its source repo can't be resolved automatically. ` +
        `Pass the GitHub owner/repo directly (e.g. clauderabbit scan owner/repo).`,
    );
  }

  const gh = githubFromRepositoryUrl(repoUrl);
  if (!gh) {
    throw new Error(
      `npm package "${pkg}" points at a non-GitHub repository (${repoUrl}). ` +
        `ClaudeRabbit currently scans GitHub repos; pass a GitHub owner/repo directly.`,
    );
  }
  return gh;
}

/**
 * Resolve a raw target string into an owner/repo (+ optional ref). Async
 * because npm-name resolution hits the registry over the network.
 */
export async function resolveTarget(raw: string): Promise<ResolvedTarget> {
  const input = raw.trim();
  if (!input) throw new Error("No scan target provided.");

  // 1. Explicit GitHub URL (https, ssh, or github.com shorthand).
  const ssh = SSH_URL_RE.exec(input);
  if (ssh) return { owner: ssh[1], repo: stripGit(ssh[2]), via: "github" };

  if (/github\.com/i.test(input)) {
    const m = GITHUB_URL_RE.exec(input);
    if (m) return { owner: m[1], repo: stripGit(m[2]), via: "github" };
    throw new Error(`Could not parse a GitHub owner/repo out of "${input}".`);
  }

  // 2. owner/repo (with optional @ref or #ref).
  const { base, ref } = splitRef(input);
  if (looksLikeOwnerRepo(base)) {
    const [owner, repo] = base.split("/");
    return { owner, repo: stripGit(repo), ...(ref ? { ref } : {}), via: "github" };
  }

  // 3. Otherwise treat it as an npm package name (bare or @scoped) and resolve
  //    it through the registry to its GitHub source repo.
  const pkg = base;
  const gh = await resolveNpmPackage(pkg);
  return { owner: gh.owner, repo: stripGit(gh.repo), npmPackage: pkg, via: "npm" };
}

function stripGit(repo: string): string {
  return repo.replace(/\.git$/i, "");
}
