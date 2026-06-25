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
