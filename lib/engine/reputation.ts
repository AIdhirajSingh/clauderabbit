/**
 * Reputation signals (DESIGN.md section 5.3, group R).
 *
 * Kept apart from code and behaviour everywhere: these facts describe who
 * publishes the code, never what the code does. A signal whose source was
 * unreachable is reported as unavailable, never guessed.
 */

import type { NpmResolution, VersionPublish } from "./resolve/npm";
import { encodeNpmName } from "./resolve/npm";
import { USER_AGENT, fetchWithDeadline, type FetchLike } from "./resolve/http";

const DAY_MS = 86_400_000;

export interface OwnerInfo {
  login: string;
  type: string;
  createdAt: string | null;
  publicRepos: number;
}

/** Owner cache backed by the `owners` table (read before the GitHub call, written after). */
export interface OwnerCache {
  get(login: string): Promise<OwnerInfo | null>;
  put(info: OwnerInfo): Promise<void>;
}

export interface ReputationSignals {
  ownerAgeDays: number | null;
  ownerEstablished: boolean | null;
  npmFirstPublishDays: number | null;
  maintainerChangedWithin30d: boolean | null;
  weeklyDownloads: number | null;
  evidence: string[];
  unavailable: string[];
}

interface Ctx {
  fetch: FetchLike;
  timeoutMs: number;
  token?: string | null;
  signal?: AbortSignal;
}

export async function fetchGithubOwner(login: string, ctx: Ctx, cache?: OwnerCache): Promise<OwnerInfo | null> {
  if (cache) {
    try {
      const hit = await cache.get(login);
      if (hit) return hit;
    } catch {
      // A cache miss or cache error falls through to the live lookup.
    }
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
  let res: Response;
  try {
    res = await fetchWithDeadline(ctx.fetch, `https://api.github.com/users/${encodeURIComponent(login)}`, { headers }, ctx.timeoutMs, ctx.signal);
  } catch {
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const u = (await res.json()) as { login?: unknown; type?: unknown; created_at?: unknown; public_repos?: unknown };
  if (typeof u.login !== "string") return null;
  const info: OwnerInfo = {
    login: u.login,
    type: typeof u.type === "string" ? u.type : "User",
    createdAt: typeof u.created_at === "string" ? u.created_at : null,
    publicRepos: typeof u.public_repos === "number" ? u.public_repos : 0,
  };
  if (cache) {
    try {
      await cache.put(info);
    } catch {
      // Caching is an optimization; the live answer stands.
    }
  }
  return info;
}

export async function fetchWeeklyDownloads(name: string, ctx: Ctx): Promise<number | null> {
  try {
    const res = await fetchWithDeadline(
      ctx.fetch,
      `https://api.npmjs.org/downloads/point/last-week/${encodeNpmName(name)}`,
      { headers: { "User-Agent": USER_AGENT } },
      ctx.timeoutMs,
      ctx.signal,
    );
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const j = (await res.json()) as { downloads?: unknown };
    return typeof j.downloads === "number" ? j.downloads : null;
  } catch {
    return null;
  }
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/**
 * True when any version published in the last `days` days lists a different
 * maintainer set than the newest version published before that window.
 * Null when the history is empty.
 */
export function maintainerChangedWithin(history: VersionPublish[], now: number, days = 30): boolean | null {
  if (history.length === 0) return null;
  const cutoff = now - days * DAY_MS;
  const before = history.filter((h) => Date.parse(h.publishedAt) < cutoff);
  const within = history.filter((h) => Date.parse(h.publishedAt) >= cutoff);
  const baseline = before[before.length - 1];
  if (!baseline || within.length === 0) return false;
  const key = (list: string[]) => [...new Set(list.map((n) => n.toLowerCase()))].sort().join(",");
  const base = key(baseline.maintainers);
  return within.some((h) => key(h.maintainers) !== base);
}

export function ownerEstablished(owner: OwnerInfo, now: number): boolean {
  const age = daysSince(owner.createdAt, now);
  return age !== null && age >= 365 && owner.publicRepos >= 3;
}

export interface ReputationInput {
  owner?: OwnerInfo | null;
  /** True when a GitHub owner lookup was attempted (target or linked repo). */
  ownerLookedUp: boolean;
  npm?: NpmResolution | null;
  weeklyDownloads?: number | null;
}

export function computeReputation(input: ReputationInput, now: number): ReputationSignals {
  const evidence: string[] = [];
  const unavailable: string[] = [];
  let ownerAgeDays: number | null = null;
  let established: boolean | null = null;
  if (input.owner) {
    ownerAgeDays = daysSince(input.owner.createdAt, now);
    established = ownerEstablished(input.owner, now);
    evidence.push(
      `GitHub owner ${input.owner.login} (${input.owner.type}) account age ${ownerAgeDays ?? "unknown"} days, ${input.owner.publicRepos} public repositories`,
    );
  } else if (input.ownerLookedUp) {
    unavailable.push("GitHub owner history (lookup failed)");
  }
  let firstDays: number | null = null;
  let changed: boolean | null = null;
  if (input.npm) {
    firstDays = daysSince(input.npm.firstPublishedAt, now);
    changed = maintainerChangedWithin(input.npm.history, now);
    if (firstDays !== null) evidence.push(`npm package first published ${firstDays} days ago, ${input.npm.versionCount} versions`);
    else unavailable.push("npm first publish date");
    if (input.npm.maintainers.length > 0) evidence.push(`npm maintainers: ${input.npm.maintainers.slice(0, 10).join(", ")}`);
    if (changed) evidence.push("npm maintainer set changed within the last 30 days");
  }
  const weekly = input.weeklyDownloads ?? null;
  if (input.npm) {
    if (weekly !== null) evidence.push(`npm weekly downloads: ${weekly}`);
    else unavailable.push("npm download counts");
  }
  return {
    ownerAgeDays,
    ownerEstablished: established,
    npmFirstPublishDays: firstDays,
    maintainerChangedWithin30d: changed,
    weeklyDownloads: weekly,
    evidence,
    unavailable,
  };
}
