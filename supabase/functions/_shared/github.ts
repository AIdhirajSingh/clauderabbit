/**
 * GitHub fetch layer for the fast-path scan.
 *
 * Responsibilities:
 *  - Resolve owner/repo[/ref] to a canonical owner, repo, and commit SHA + repo
 *    metadata (the "Clone" step of the scan lifecycle).
 *  - Fetch a bounded, high-signal set of files for the read model to inspect.
 *  - Fetch the OWNER reputation signal (account age, public repos, type).
 *
 * Reputation (owner) and code (files) are returned in separate structures so the
 * orchestrator can keep reputation signals structurally separate from
 * code/behavior signals (a CLAUDE.md rail).
 *
 * Auth: uses GITHUB_TOKEN (edge-function secret) when present for the 5000/hr
 * authenticated rate limit; degrades to unauthenticated (60/hr) otherwise.
 */

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const USER_AGENT = "claude-rabbit-scanner";
const MAX_SOURCE_FILES = 15;
const MAX_FILE_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const LFS_POINTER_PREFIX = "version https://git-lfs";

/** A fetched file: path + (possibly truncated) text content. */
export interface FetchedFile {
  path: string;
  content: string;
  /** True if the content was capped at MAX_FILE_BYTES. */
  truncated: boolean;
}

/** Repository metadata — the "Clone" + reputation-adjacent facts. */
export interface RepoMetadata {
  ownerLogin: string;
  repoName: string;
  fullName: string;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  sizeKb: number;
  createdAt: string | null;
  pushedAt: string | null;
  license: string | null;
  hasLockfile: boolean;
  /** True when GitHub reports the repo as private. Claude Rabbit only scans
   * public repos — a private repo must be refused before any fetch/model/persist. */
  isPrivate: boolean;
  /** GitHub's repo visibility ("public" | "private" | "internal"). */
  visibility: string;
}

/** Owner reputation signal — kept separate from code/behavior. */
export interface OwnerSignal {
  login: string;
  type: string;
  name: string | null;
  createdAt: string | null;
  ageLabel: string;
  ageDays: number;
  publicRepos: number;
  established: boolean;
}

export interface ResolvedRepo {
  metadata: RepoMetadata;
  commitSha: string;
  ref: string;
  files: FetchedFile[];
  treeTruncated: boolean;
}

/** Thrown when the repo (or ref) does not exist. */
export class RepoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoNotFoundError";
  }
}

/** Thrown when GitHub rate-limits us. */
export class GitHubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

/**
 * Thrown when the resolved repo is NOT public. Claude Rabbit is a public-repo
 * product and publishes its reports publicly, so a private repo must be refused
 * before any file fetch, model call, or DB write happens.
 */
export class PrivateRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateRepoError";
  }
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Distinguish a true 403 (rate limit) from a 404 and surface clear errors. */
function assertNotRateLimited(res: Response): void {
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (remaining === "0" || res.status === 429) {
      throw new GitHubRateLimitError(
        "GitHub API rate limit reached. Configure GITHUB_TOKEN or retry later.",
      );
    }
    throw new GitHubRateLimitError("GitHub API access forbidden (403).");
  }
}

interface GhRepoResponse {
  name: string;
  full_name: string;
  owner: { login: string; type: string };
  default_branch: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  size: number;
  created_at: string | null;
  pushed_at: string | null;
  license: { spdx_id?: string; name?: string } | null;
  private: boolean;
  visibility?: string;
}

interface GhUserResponse {
  login: string;
  type: string;
  name: string | null;
  created_at: string | null;
  public_repos: number;
}

interface GhTreeResponse {
  tree: Array<{ path: string; type: string; size?: number }>;
  truncated: boolean;
}

function ageLabelFromDate(createdAt: string | null): {
  label: string;
  days: number;
} {
  if (!createdAt) return { label: "unknown", days: -1 };
  const created = new Date(createdAt).getTime();
  const days = Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: "unknown", days: -1 };
  if (days < 31) return { label: `${days} day${days === 1 ? "" : "s"}`, days };
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  if (years === 0) return { label: `${months} mo`, days };
  return { label: `${years} yr${months > 0 ? ` ${months} mo` : ""}`, days };
}

/** GET /users/{owner} → reputation signal. Kept separate from code. */
export async function ownerSignal(owner: string): Promise<OwnerSignal> {
  const res = await fetchWithTimeout(
    `${GITHUB_API}/users/${encodeURIComponent(owner)}`,
    { headers: apiHeaders() },
  );
  if (res.status === 404) {
    await res.body?.cancel();
    throw new RepoNotFoundError(`GitHub user "${owner}" not found`);
  }
  assertNotRateLimited(res);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GitHub /users lookup failed (status ${res.status})`);
  }
  const u = (await res.json()) as GhUserResponse;
  const age = ageLabelFromDate(u.created_at);
  // "Established" heuristic: account older than ~1 year with multiple repos.
  const established = age.days >= 365 && (u.public_repos ?? 0) >= 3;
  return {
    login: u.login,
    type: u.type,
    name: u.name,
    createdAt: u.created_at,
    ageLabel: age.label,
    ageDays: age.days,
    publicRepos: u.public_repos ?? 0,
    established,
  };
}

const SOURCE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "php", "sh", "ps1",
]);

const ALWAYS_FETCH = new Set([
  "package.json",
  "setup.py",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "go.mod",
  "Cargo.toml",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
]);

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function extOf(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i === -1 ? "" : b.slice(i + 1).toLowerCase();
}

/** Choose the high-signal subset of paths to fetch (manifests + scripts + src). */
function selectPaths(
  paths: string[],
): { selected: string[]; hasLockfile: boolean } {
  const hasLockfile = paths.some((p) => LOCKFILES.has(basename(p)));
  const selected: string[] = [];
  const seen = new Set<string>();

  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      selected.push(p);
    }
  };

  // 1. Always-fetch manifests, anywhere in the tree.
  for (const p of paths) {
    if (ALWAYS_FETCH.has(basename(p))) add(p);
  }
  // 2. READMEs.
  for (const p of paths) {
    if (/^readme(\.|$)/i.test(basename(p))) add(p);
  }
  // 3. Shell / install scripts.
  for (const p of paths) {
    if (extOf(p) === "sh" || extOf(p) === "ps1") add(p);
  }
  // 4. Top-level / shallow source files first (more likely entry points).
  const sources = paths
    .filter((p) => SOURCE_EXT.has(extOf(p)) && !seen.has(p))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  for (const p of sources) {
    if (selected.length >= MAX_SOURCE_FILES) break;
    add(p);
  }
  return { selected: selected.slice(0, MAX_SOURCE_FILES + 8), hasLockfile };
}

/** Per-segment URL-encode a repo path for the raw CDN. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function fetchRawFile(
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<FetchedFile | null> {
  const url = `${RAW_BASE}/${encodeURIComponent(owner)}/${
    encodeURIComponent(repo)
  }/${sha}/${encodePath(path)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
  } catch {
    return null; // timeout / network — skip this file, do not sink the batch
  }
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const raw = await res.text();
  // Skip Git LFS pointer files (they are not the real content).
  if (raw.startsWith(LFS_POINTER_PREFIX)) return null;
  const truncated = raw.length > MAX_FILE_BYTES;
  return {
    path,
    content: truncated ? raw.slice(0, MAX_FILE_BYTES) : raw,
    truncated,
  };
}

/** Fallback: fetch a single manifest by direct path when the tree is truncated. */
async function fetchManifestDirect(
  owner: string,
  repo: string,
  sha: string,
  name: string,
): Promise<FetchedFile | null> {
  return await fetchRawFile(owner, repo, sha, name);
}

/**
 * Resolve owner/repo[/ref] → canonical names + commit SHA + metadata + the
 * bounded set of high-signal files. Uses the canonical casing GitHub returns.
 */
export async function resolveRepo(
  ownerInput: string,
  repoInput: string,
  ref?: string,
): Promise<ResolvedRepo> {
  // 1. Repo metadata (also gives us canonical casing + default branch).
  const repoRes = await fetchWithTimeout(
    `${GITHUB_API}/repos/${encodeURIComponent(ownerInput)}/${
      encodeURIComponent(repoInput)
    }`,
    { headers: apiHeaders() },
  );
  if (repoRes.status === 404) {
    await repoRes.body?.cancel();
    throw new RepoNotFoundError(
      `Repository "${ownerInput}/${repoInput}" not found`,
    );
  }
  assertNotRateLimited(repoRes);
  if (!repoRes.ok) {
    await repoRes.body?.cancel();
    throw new Error(`GitHub /repos lookup failed (status ${repoRes.status})`);
  }
  const repoData = (await repoRes.json()) as GhRepoResponse;

  // SAFETY RAIL: refuse non-public repos BEFORE any file fetch, model call, or
  // DB write. The server-side GITHUB_TOKEN can read private repos the token
  // owner has access to; analyzing one would publish its code to a public
  // /owner/repo report. Claude Rabbit only scans PUBLIC repositories.
  const visibility = repoData.visibility ?? (repoData.private ? "private" : "public");
  if (repoData.private === true || visibility !== "public") {
    // repoRes body is already consumed by .json() above; nothing left to fetch.
    throw new PrivateRepoError(
      "Claude Rabbit only scans public repositories.",
    );
  }

  // Canonical casing — avoids duplicate cache rows for Facebook/React vs facebook/react.
  const owner = repoData.owner.login;
  const repo = repoData.name;
  const resolvedRef = ref || repoData.default_branch;

  // 2. Resolve the ref to a commit SHA.
  const commitRes = await fetchWithTimeout(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(repo)
    }/commits/${encodeURIComponent(resolvedRef)}`,
    { headers: apiHeaders() },
  );
  if (commitRes.status === 404) {
    await commitRes.body?.cancel();
    throw new RepoNotFoundError(
      `Ref "${resolvedRef}" not found in ${owner}/${repo}`,
    );
  }
  assertNotRateLimited(commitRes);
  if (!commitRes.ok) {
    await commitRes.body?.cancel();
    throw new Error(`GitHub commit lookup failed (status ${commitRes.status})`);
  }
  const commitData = (await commitRes.json()) as { sha: string };
  const commitSha = commitData.sha;
  // Guard: the SHA flows into the raw CDN URL and the DB cache key. Reject any
  // unexpected value rather than constructing a URL from untrusted text.
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error("GitHub returned an unexpected commit SHA format");
  }

  // 3. List the tree at that SHA.
  let treePaths: string[] = [];
  let treeTruncated = false;
  const treeRes = await fetchWithTimeout(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(repo)
    }/git/trees/${commitSha}?recursive=1`,
    { headers: apiHeaders() },
  );
  if (treeRes.ok) {
    const tree = (await treeRes.json()) as GhTreeResponse;
    treeTruncated = tree.truncated;
    treePaths = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
  } else {
    assertNotRateLimited(treeRes);
    await treeRes.body?.cancel();
    // Non-fatal: we can still fetch known manifests by direct path below.
    treeTruncated = true;
  }

  const { selected, hasLockfile } = selectPaths(treePaths);

  // 4. Fetch selected files concurrently; one hang/404 must not sink the batch.
  const settled = await Promise.allSettled(
    selected.map((p) => fetchRawFile(owner, repo, commitSha, p)),
  );
  const files: FetchedFile[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) files.push(s.value);
  }

  // 5. Truncation/empty-tree fallback: make sure key manifests are present.
  if (treeTruncated || files.length === 0) {
    const present = new Set(files.map((f) => basename(f.path)));
    for (const name of ALWAYS_FETCH) {
      if (present.has(name)) continue;
      const f = await fetchManifestDirect(owner, repo, commitSha, name);
      if (f) files.push(f);
    }
  }

  const metadata: RepoMetadata = {
    ownerLogin: owner,
    repoName: repo,
    fullName: repoData.full_name,
    defaultBranch: repoData.default_branch,
    description: repoData.description,
    language: repoData.language,
    stars: repoData.stargazers_count ?? 0,
    forks: repoData.forks_count ?? 0,
    openIssues: repoData.open_issues_count ?? 0,
    sizeKb: repoData.size ?? 0,
    createdAt: repoData.created_at,
    pushedAt: repoData.pushed_at,
    license: repoData.license?.spdx_id ?? repoData.license?.name ?? null,
    hasLockfile,
    // Reaching here means the private/visibility guard above did NOT throw, so
    // the repo is provably public. These fields document that for downstream
    // defense-in-depth checks.
    isPrivate: false,
    visibility,
  };

  return { metadata, commitSha, ref: resolvedRef, files, treeTruncated };
}
