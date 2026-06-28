/**
 * Danger-board data layer — turns the anon-readable board views into the typed
 * shapes the danger board renders, and fetches them lazily from the browser
 * Supabase client on first board navigation (no homepage SSR cost).
 *
 * Honesty rails (CLAUDE.md): every row, dot, and count here comes from a REAL
 * `reports` row. There is no fabrication and no fallback demo data — when the DB
 * has no caught repos the board is genuinely empty, and the fetchers surface a
 * `loaded: false` / error signal so the UI can tell "nothing caught yet" apart
 * from "could not load". Reputation is never blended into a board row; map dots
 * are derived only from the captured forensic geolocation (a code/behavior
 * signal), never from owner location.
 *
 * The reshapers (`boardRowToEntry`, `dotFromGeoRow`) are pure and unit-tested;
 * the fetchers take an injected client so they stay testable and never import a
 * client at module scope.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { band } from "./score";
import { normalizeForensics } from "./scan";
import { buildForensicsView } from "./report-view";
import { centroidForCountry, project, resolveLocation, type MapPoint } from "./world-geo";
import type { LeaderboardEntry } from "./types";

/** Page size for the infinite-scroll ranked list. */
export const BOARD_PAGE_SIZE = 20;
/** Hard cap on dots pulled for the map (one fetch; keeps payload bounded). */
const MAX_BOARD_DOTS = 500;

/** Columns selected from v_leaderboard_full (paginated list). */
const LEADERBOARD_FULL_SELECT =
  "owner_login,repo_name,score,verdict,deep,commit_sha,created_at,forensics_json";
/** Columns selected from v_board_dots (lightweight map geo). */
const BOARD_DOTS_SELECT = "owner_login,repo_name,score,country,region,city,org,host";

// ───────────────────────────── view row shapes ─────────────────────────────

/** A raw row from `v_leaderboard_full`. */
export interface LeaderboardFullRow {
  owner_login: string;
  repo_name: string;
  score: number;
  verdict: string;
  deep: boolean;
  commit_sha: string;
  created_at: string;
  forensics_json: unknown;
}

/** A raw row from `v_board_dots` (one resolved destination country per repo). */
export interface BoardDotRow {
  owner_login: string;
  repo_name: string;
  score: number;
  country: string | null;
  region: string | null;
  city: string | null;
  org: string | null;
  host: string | null;
}

/** A raw single row from `v_board_stats`. */
export interface BoardStatsRow {
  distinct_repos: number;
  distinct_owners: number;
  dangerous_repos: number;
  deep_repos: number;
  report_snapshots: number;
}

/** A raw single row from `v_score_distribution`. */
export interface ScoreDistributionRow {
  red_count: number;
  amber_count: number;
  blue_count: number;
  green_count: number;
}

// ───────────────────────────── derived shapes ─────────────────────────────

/** A board row enriched for the ranked list (the SPA's LeaderboardEntry plus keying). */
export interface BoardEntry extends LeaderboardEntry {
  /** The resolved commit SHA — part of the stable identity for the row key. */
  commitSha: string;
}

/** A single positioned map dot for a caught repo's resolved destination. */
export interface BoardDot {
  /** Stable id: owner/repo + destination, so React keys stay unique. */
  id: string;
  owner: string;
  name: string;
  score: number;
  /** Band name (red/amber/blue/green) — for the dot color via the fixed logic. */
  band: ReturnType<typeof band>;
  /** The resolved destination country (always present — dots require real geo). */
  country: string;
  /** A human place label, e.g. "Frankfurt, Germany" when finer geo is known. */
  place: string;
  /** The captured C2 host, when known. */
  host: string | null;
  /** The projected position in the map's MAP_W×MAP_H space. */
  point: MapPoint;
  /** U4: "egress" = plotted where the code was caught calling out; "origin" =
   * plotted at the repo owner's own location (every scanned repo gets a dot). */
  source: "egress" | "origin";
  /** U4: when this repo was first scanned (reports.created_at) — drives the
   * ~10-minute "newly added" pulse. Null when unknown (egress-view rows). */
  createdAt: string | null;
}

/** Live board counts, each a precise fact about the reports cache. */
export interface BoardStats {
  distinctRepos: number;
  distinctOwners: number;
  dangerousRepos: number;
  deepRepos: number;
  reportSnapshots: number;
}

/** The score-band histogram (latest-per-repo) for the chart. */
export interface ScoreDistribution {
  red: number;
  amber: number;
  blue: number;
  green: number;
}

/** The initial board bundle fetched on first navigation. */
export interface BoardData {
  /** Whether the fetch actually completed (false ⇒ "could not load", not "empty"). */
  loaded: boolean;
  rows: BoardEntry[];
  /** True when more list pages remain (page 0 returned a full page). */
  hasMore: boolean;
  dots: BoardDot[];
  stats: BoardStats | null;
  distribution: ScoreDistribution;
}

/** The honest empty/sparse bundle (used before load and on a hard failure). */
export const EMPTY_BOARD_DATA: BoardData = {
  loaded: false,
  rows: [],
  hasMore: false,
  dots: [],
  stats: null,
  distribution: { red: 0, amber: 0, blue: 0, green: 0 },
};

// ───────────────────────────── pure reshapers ─────────────────────────────

/** Coerce a possibly-bigint/string count to a finite non-negative integer. */
function toCount(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Build the board row's reason line. Prefers the forensic headline / board
 * marker (what running it actually revealed) over the bare verdict, so the row
 * leads with the caught behavior. Falls back to a plain, honest sentence.
 */
function reasonFor(forensics: ReturnType<typeof normalizeForensics>, verdict: string): string {
  const view = buildForensicsView(forensics);
  if (view) {
    if (view._headline && view._headline.trim()) return view._headline.trim();
    if (view._boardMarker) return view._boardMarker;
  }
  return verdict && verdict.trim()
    ? `Scored in the dangerous band — ${verdict.trim().toLowerCase()}.`
    : "Scored in the dangerous band by our scan.";
}

/**
 * Reshape a `v_leaderboard_full` row into a `BoardEntry`. Pure; the forensic
 * record (when present) is normalized to the strict shape so the row can surface
 * the captured C2 marker exactly as the report page does. The linked report id
 * is "owner/repo" (the public report route key).
 */
export function boardRowToEntry(row: LeaderboardFullRow): BoardEntry {
  const forensics = normalizeForensics(row.forensics_json);
  return {
    owner: row.owner_login,
    name: row.repo_name,
    score: row.score,
    reason: reasonFor(forensics, row.verdict),
    id: `${row.owner_login}/${row.repo_name}`,
    commitSha: row.commit_sha,
    ...(forensics ? { forensics } : {}),
  };
}

/** A readable place label from the finest geo we have, ending in the country. */
function placeLabel(row: BoardDotRow): string {
  const parts = [row.city, row.region].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  const country = (row.country ?? "").trim();
  parts.push(country);
  return parts.join(", ");
}

/**
 * Reshape a `v_board_dots` row into a positioned `BoardDot`, or null when the
 * country cannot be resolved to a centroid (no fabricated location — the dot is
 * simply dropped). Pure.
 */
export function dotFromGeoRow(row: BoardDotRow): BoardDot | null {
  const country = (row.country ?? "").trim();
  if (!country) return null;
  const centroid = centroidForCountry(country);
  if (!centroid) return null;
  const host = row.host && row.host.trim() ? row.host.trim() : null;
  return {
    id: `${row.owner_login}/${row.repo_name}@${host ?? country}`,
    owner: row.owner_login,
    name: row.repo_name,
    score: row.score,
    band: band(row.score),
    country,
    place: placeLabel(row),
    host,
    point: project(centroid.lat, centroid.lng),
    source: "egress",
    createdAt: null,
  };
}

/** Reshape the stats view row. Pure. */
export function statsFromRow(row: BoardStatsRow | null): BoardStats | null {
  if (!row) return null;
  return {
    distinctRepos: toCount(row.distinct_repos),
    distinctOwners: toCount(row.distinct_owners),
    dangerousRepos: toCount(row.dangerous_repos),
    deepRepos: toCount(row.deep_repos),
    reportSnapshots: toCount(row.report_snapshots),
  };
}

/** Reshape the distribution view row. Pure. */
export function distributionFromRow(row: ScoreDistributionRow | null): ScoreDistribution {
  if (!row) return { red: 0, amber: 0, blue: 0, green: 0 };
  return {
    red: toCount(row.red_count),
    amber: toCount(row.amber_count),
    blue: toCount(row.blue_count),
    green: toCount(row.green_count),
  };
}

// ───────────────────────────── fetchers ─────────────────────────────

/** A minimal structural type for the bits of the Supabase client we use. */
type BoardClient = Pick<SupabaseClient, "from">;

/**
 * Fetch one page of the ranked danger list, worst-first, deterministically
 * ordered (the view's ORDER BY is unique-keyed so range pagination is stable).
 * Returns the reshaped rows and whether more pages remain. Never throws — a
 * failure yields an empty page with `hasMore: false` and `ok: false`.
 */
export async function fetchBoardPage(
  client: BoardClient,
  page: number,
): Promise<{ ok: boolean; rows: BoardEntry[]; hasMore: boolean }> {
  const from = Math.max(0, page) * BOARD_PAGE_SIZE;
  const to = from + BOARD_PAGE_SIZE - 1;
  try {
    const { data, error } = await client
      .from("v_leaderboard_full")
      .select(LEADERBOARD_FULL_SELECT)
      .range(from, to);
    if (error || !data) return { ok: false, rows: [], hasMore: false };
    const raw = data as unknown as LeaderboardFullRow[];
    const rows = raw.map(boardRowToEntry);
    return { ok: true, rows, hasMore: raw.length === BOARD_PAGE_SIZE };
  } catch {
    return { ok: false, rows: [], hasMore: false };
  }
}

/** Fetch the map dots (capped). Never throws; failure yields []. */
async function fetchBoardDots(client: BoardClient): Promise<BoardDot[]> {
  try {
    const { data, error } = await client
      .from("v_board_dots")
      .select(BOARD_DOTS_SELECT)
      .limit(MAX_BOARD_DOTS);
    if (error || !data) return [];
    const raw = data as unknown as BoardDotRow[];
    return raw
      .map(dotFromGeoRow)
      .filter((d): d is BoardDot => d !== null);
  } catch {
    return [];
  }
}

/** Fetch the live counts. Never throws; failure yields null. */
async function fetchBoardStats(client: BoardClient): Promise<BoardStats | null> {
  try {
    const { data, error } = await client
      .from("v_board_stats")
      .select("distinct_repos,distinct_owners,dangerous_repos,deep_repos,report_snapshots")
      .maybeSingle();
    if (error || !data) return null;
    return statsFromRow(data as unknown as BoardStatsRow);
  } catch {
    return null;
  }
}

/** Fetch the score-band histogram. Never throws; failure yields all-zero. */
async function fetchScoreDistribution(client: BoardClient): Promise<ScoreDistribution> {
  try {
    const { data, error } = await client
      .from("v_score_distribution")
      .select("red_count,amber_count,blue_count,green_count")
      .maybeSingle();
    if (error || !data) return { red: 0, amber: 0, blue: 0, green: 0 };
    return distributionFromRow(data as unknown as ScoreDistributionRow);
  } catch {
    return { red: 0, amber: 0, blue: 0, green: 0 };
  }
}

/** A reports row joined to its owner, for the per-repo ORIGIN dot. */
interface OriginRow {
  owner_login: string;
  repo_name: string;
  score: number;
  created_at: string;
  owners: { reputation_json: unknown } | { reputation_json: unknown }[] | null;
}

/** Reshape a report+owner row into an ORIGIN dot at the owner's location, or null
 * when the location cannot be resolved (no fabricated dot). Pure. */
export function originDotFromRow(row: OriginRow): BoardDot | null {
  const owner = Array.isArray(row.owners) ? row.owners[0] : row.owners;
  const rj = owner?.reputation_json;
  const loc = rj && typeof rj === "object"
    ? (rj as Record<string, unknown>).location
    : null;
  const location = typeof loc === "string" && loc.trim() ? loc.trim() : null;
  const coords = resolveLocation(location);
  if (!coords) return null;
  return {
    id: `${row.owner_login}/${row.repo_name}@origin`,
    owner: row.owner_login,
    name: row.repo_name,
    score: row.score,
    band: band(row.score),
    country: location ?? "",
    place: location ?? "",
    host: null,
    point: project(coords.lat, coords.lng),
    source: "origin",
    createdAt: row.created_at,
  };
}

/** Fetch an ORIGIN dot for every scanned repo (latest per repo) at its owner's
 * location. Never throws; failure yields []. U4: the map is always alive — every
 * repo gets a dot, not only the ones caught phoning home. */
async function fetchOriginDots(client: BoardClient): Promise<BoardDot[]> {
  try {
    const { data, error } = await client
      .from("reports")
      .select("owner_login,repo_name,score,created_at,owners(reputation_json)")
      .order("created_at", { ascending: false })
      .limit(MAX_BOARD_DOTS);
    if (error || !data) return [];
    const raw = data as unknown as OriginRow[];
    const seen = new Set<string>();
    const dots: BoardDot[] = [];
    for (const r of raw) {
      const key = `${r.owner_login}/${r.repo_name}`;
      if (seen.has(key)) continue; // newest-first → keep the latest per repo
      seen.add(key);
      const d = originDotFromRow(r);
      if (d) dots.push(d);
    }
    return dots;
  } catch {
    return [];
  }
}

/**
 * Fetch the full initial board bundle (list page 0 + dots + stats +
 * distribution) in parallel. `loaded` is true only when the list page query
 * itself succeeded. The map dots are EVERY scanned repo: an EGRESS dot where the
 * code was caught calling out (when captured), else an ORIGIN dot at the repo
 * owner's own location — so the map is always alive, not just for caught repos.
 * Egress overrides origin for the same repo; the origin's created_at carries the
 * "newly added" pulse onto either dot. Never throws.
 */
export async function fetchBoardData(client: BoardClient): Promise<BoardData> {
  const [page, egressDots, originDots, stats, distribution] = await Promise.all([
    fetchBoardPage(client, 0),
    fetchBoardDots(client),
    fetchOriginDots(client),
    fetchBoardStats(client),
    fetchScoreDistribution(client),
  ]);
  const byRepo = new Map<string, BoardDot>();
  for (const d of originDots) byRepo.set(`${d.owner}/${d.name}`, d);
  for (const d of egressDots) {
    const key = `${d.owner}/${d.name}`;
    // Prefer the egress dot (where it was caught calling out) but keep the origin's
    // created_at so the "newly added" pulse still fires for caught repos too.
    byRepo.set(key, { ...d, createdAt: d.createdAt ?? byRepo.get(key)?.createdAt ?? null });
  }
  return {
    loaded: page.ok,
    rows: page.rows,
    hasMore: page.hasMore,
    dots: [...byRepo.values()],
    stats,
    distribution,
  };
}
