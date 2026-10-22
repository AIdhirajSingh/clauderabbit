/**
 * GitHub target resolution (DESIGN.md sections 2.2, 4).
 *
 * ref -> commit SHA through the REST API, then the codeload tarball for exactly
 * that SHA (no clone). The archive is accepted only when its pax global header
 * `comment` equals the resolved SHA: git archive writes the commit id there, so
 * this binds the bytes we scan to the commit we report.
 */

import type { ParsedArchive } from "../archive";
import { EngineError } from "../types";
import { USER_AGENT, fetchWithDeadline, readCapped, type FetchLike } from "./http";

const GITHUB_API = "https://api.github.com";
const CODELOAD = "https://codeload.github.com";

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface GithubTargetSpec {
  owner: string;
  repo: string;
  ref?: string;
}

function validName(owner: string, repo: string): boolean {
  return OWNER_RE.test(owner) && REPO_RE.test(repo) && repo !== "." && repo !== "..";
}

/**
 * Parse `owner/repo`, `github:owner/repo[#ref]`, or a github.com URL
 * (`/tree/<ref>` and `/commit/<sha>` honored). Returns null for anything else.
 */
export function parseGithubTarget(input: string): GithubTargetSpec | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  let ref: string | undefined;

  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(tree|commit)\/([^?#\s]+))?\/?(?:[?#].*)?$/i.exec(s);
  if (url) {
    const owner = url[1]!;
    const repo = url[2]!;
    if (url[4]) ref = decodeURIComponent(url[4]);
    return validName(owner, repo) ? { owner, repo, ...(ref ? { ref } : {}) } : null;
  }
  const explicit = /^github:(.+)$/i.exec(s);
  if (explicit) s = explicit[1]!.trim();
  const hash = s.indexOf("#");
  if (hash > 0) {
    ref = s.slice(hash + 1) || undefined;
    s = s.slice(0, hash);
  }
  const m = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(s);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!;
  if (owner.startsWith("@")) return null; // a scoped npm name, not a repo
  return validName(owner, repo) ? { owner, repo, ...(ref ? { ref } : {}) } : null;
}

export interface GithubRepoInfo {
  ownerLogin: string;
  ownerType: string;
  repoName: string;
  defaultBranch: string;
  description: string | null;
  /** null when unknown (resolved without the API, see resolveViaGit). */
  stars: number | null;
  forks: number | null;
  createdAt: string | null;
  pushedAt: string | null;
  license: string | null;
  language: string | null;
}

export interface GithubResolution {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  info: GithubRepoInfo;
}

export interface GithubContext {
  fetch: FetchLike;
  token: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

function apiHeaders(token: string | null, accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function failFor(res: Response, what: string): Promise<never> {
  await res.body?.cancel();
  if (res.status === 404 || res.status === 422) throw new EngineError("not_found", `${what} was not found on GitHub`);
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    throw new EngineError("rate_limited", "GitHub API rate limit reached; retry later");
  }
  throw new EngineError("upstream", `GitHub returned HTTP ${res.status} for ${what}`);
}

interface GhRepo {
  name: string;
  owner: { login: string; type: string };
  default_branch: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  created_at: string | null;
  pushed_at: string | null;
  license: { spdx_id?: string | null; name?: string | null } | null;
  language: string | null;
  private: boolean;
  visibility?: string;
}

export async function resolveGithub(spec: GithubTargetSpec, ctx: GithubContext): Promise<GithubResolution> {
  if (!validName(spec.owner, spec.repo)) throw new EngineError("invalid_target", "not a valid GitHub owner/repo");
  try {
    return await resolveViaApi(spec, ctx);
  } catch (err) {
    // The REST API is rate limited per IP without a token; git's own endpoint is not.
    if (err instanceof EngineError && err.code === "rate_limited") return resolveViaGit(spec, ctx);
    throw err;
  }
}

/**
 * Resolves a public repo's ref to a commit through git's smart HTTP endpoint
 * (info/refs), which the REST API rate limit does not cover: HEAD and its default
 * branch, a branch or tag, or a full commit SHA as given. A private or missing repo
 * answers 401/404 there and is not_found; 403/429 there is still a rate limit. Repo metadata the API would give (stars,
 * description, dates) is unknown on this path and left null.
 */
export async function resolveViaGit(spec: GithubTargetSpec, ctx: GithubContext): Promise<GithubResolution> {
  const url = `https://github.com/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repo)}.git/info/refs?service=git-upload-pack`;
  const res = await fetchWithDeadline(ctx.fetch, url, { headers: { "User-Agent": "git/2.45.0", "Git-Protocol": "version=1" } }, ctx.timeoutMs, ctx.signal);
  if (res.status === 401 || res.status === 404) {
    await res.body?.cancel();
    throw new EngineError("not_found", `${spec.owner}/${spec.repo} was not found on GitHub, or it is private`);
  }
  if (res.status === 403 || res.status === 429) {
    await res.body?.cancel();
    throw new EngineError("rate_limited", "GitHub rate limit reached; retry later");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new EngineError("upstream", `GitHub returned HTTP ${res.status} for ${spec.owner}/${spec.repo}`);
  }
  const refs = parseUploadPackRefs(await res.text());
  const defaultBranch = refs.headTarget?.replace(/^refs\/heads\//, "") ?? "HEAD";
  let ref = spec.ref ?? defaultBranch;
  let sha: string | undefined;
  if (spec.ref && SHA_RE.test(spec.ref.toLowerCase())) sha = spec.ref.toLowerCase();
  else if (!spec.ref) sha = refs.head;
  else sha = refs.byName.get(`refs/tags/${ref}^{}`) ?? refs.byName.get(`refs/tags/${ref}`) ?? refs.byName.get(`refs/heads/${ref}`) ?? refs.byName.get(ref);
  if (!sha || !SHA_RE.test(sha)) throw new EngineError("not_found", `ref "${ref}" was not found on GitHub`);
  if (!spec.ref) ref = defaultBranch;
  return {
    owner: spec.owner,
    repo: spec.repo,
    ref,
    sha,
    info: { ownerLogin: spec.owner, ownerType: "User", repoName: spec.repo, defaultBranch, description: null, stars: null, forks: null, createdAt: null, pushedAt: null, license: null, language: null },
  };
}

/** The refs in a git-upload-pack info/refs advertisement (pkt-line format). */
export function parseUploadPackRefs(body: string): { head?: string; headTarget?: string; byName: Map<string, string> } {
  const byName = new Map<string, string>();
  let head: string | undefined;
  let headTarget: string | undefined;
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.slice(i, i + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      i += 4;
      continue;
    }
    const line = body.slice(i + 4, i + len).replace(/\n$/, "");
    i += len;
    if (line.startsWith("#")) continue;
    const [main, caps] = line.split("\0");
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(main ?? "");
    if (!m) continue;
    const [, sha, name] = m;
    if (name === "HEAD") {
      head = sha;
      const sym = /symref=HEAD:(\S+)/.exec(caps ?? "");
      if (sym) headTarget = sym[1];
    } else byName.set(name!, sha!);
  }
  return { head, headTarget, byName };
}

async function resolveViaApi(spec: GithubTargetSpec, ctx: GithubContext): Promise<GithubResolution> {
  const base = `${GITHUB_API}/repos/${encodeURIComponent(spec.owner)}/${encodeURIComponent(spec.repo)}`;
  const res = await fetchWithDeadline(ctx.fetch, base, { headers: apiHeaders(ctx.token) }, ctx.timeoutMs, ctx.signal);
  if (!res.ok) await failFor(res, `${spec.owner}/${spec.repo}`);
  const repo = (await res.json()) as GhRepo;
  if (repo.private || (repo.visibility !== undefined && repo.visibility !== "public")) {
    throw new EngineError("private_repo", "only public repositories can be scanned");
  }
  const ref = spec.ref ?? repo.default_branch;
  const shaRes = await fetchWithDeadline(
    ctx.fetch,
    `${base}/commits/${encodeURIComponent(ref)}`,
    { headers: apiHeaders(ctx.token, "application/vnd.github.sha") },
    ctx.timeoutMs,
    ctx.signal,
  );
  if (!shaRes.ok) await failFor(shaRes, `ref "${ref}"`);
  const sha = (await shaRes.text()).trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new EngineError("upstream", "GitHub did not return a commit SHA for the ref");
  const license = repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION" ? repo.license.spdx_id : (repo.license?.name ?? null);
  return {
    owner: repo.owner.login,
    repo: repo.name,
    ref,
    sha,
    info: {
      ownerLogin: repo.owner.login,
      ownerType: repo.owner.type,
      repoName: repo.name,
      defaultBranch: repo.default_branch,
      description: repo.description,
      stars: repo.stargazers_count ?? 0,
      forks: repo.forks_count ?? 0,
      createdAt: repo.created_at,
      pushedAt: repo.pushed_at,
      license,
      language: repo.language,
    },
  };
}

export function codeloadUrl(owner: string, repo: string, sha: string): string {
  return `${CODELOAD}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${sha}`;
}

/**
 * File count and total file bytes at one commit (git trees API, recursive), used to
 * size the scan VM before it boots. `truncated` means GitHub cut a very large tree.
 */
export async function githubTreeSize(owner: string, repo: string, sha: string, ctx: GithubContext): Promise<{ files: number; bytes: number; truncated: boolean }> {
  if (!SHA_RE.test(sha)) throw new EngineError("invalid_target", "commit SHA must be 40 lowercase hex characters");
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`;
  const res = await fetchWithDeadline(ctx.fetch, url, { headers: apiHeaders(ctx.token) }, ctx.timeoutMs, ctx.signal);
  if (!res.ok) await failFor(res, `tree for ${owner}/${repo}@${sha.slice(0, 12)}`);
  const body = (await res.json()) as { tree?: Array<{ type?: string; size?: number }>; truncated?: boolean };
  let files = 0;
  let bytes = 0;
  for (const e of body.tree ?? []) {
    if (e.type !== "blob") continue;
    files++;
    if (typeof e.size === "number") bytes += e.size;
  }
  return { files, bytes, truncated: body.truncated === true };
}

/** Download the codeload tarball for one commit, capped. */
export async function fetchGithubTarball(
  owner: string,
  repo: string,
  sha: string,
  ctx: GithubContext,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!SHA_RE.test(sha)) throw new EngineError("invalid_target", "commit SHA must be 40 lowercase hex characters");
  const url = codeloadUrl(owner, repo, sha);
  const res = await fetchWithDeadline(ctx.fetch, url, { headers: { "User-Agent": USER_AGENT } }, ctx.timeoutMs, ctx.signal);
  if (!res.ok) await failFor(res, `tarball for ${owner}/${repo}@${sha.slice(0, 12)}`);
  if (res.url) {
    const host = new URL(res.url).host;
    if (host !== "codeload.github.com") {
      await res.body?.cancel();
      throw new EngineError("integrity", `tarball was served from ${host}, not codeload.github.com`);
    }
  }
  return readCapped(res, maxBytes);
}

/** Bind the parsed archive to the commit: the pax global comment must be the SHA. */
export function verifyGithubArchive(archive: ParsedArchive, sha: string): void {
  if (archive.paxComment === null) {
    throw new EngineError("integrity", "GitHub archive carries no pax commit comment");
  }
  if (archive.paxComment.trim().toLowerCase() !== sha.toLowerCase()) {
    throw new EngineError("integrity", "GitHub archive commit comment does not match the resolved SHA");
  }
}
