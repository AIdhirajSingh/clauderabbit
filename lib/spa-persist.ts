/**
 * SPA navigation + live-report persistence.
 *
 * The SPA "brain" (`components/spa/state.tsx`) keeps the current screen, the
 * active report id, and the in-session live-report cache in volatile React
 * state. That is lost on a remount (and historically the user was bounced to a
 * new-scan screen when returning to the tab). This module persists a small,
 * safe snapshot of that navigation state to `sessionStorage` so a return to the
 * tab — or a full remount/reload within the same tab session — restores the
 * exact screen the user was on (e.g. a report) and re-serves the cached report
 * instantly, with no refetch.
 *
 * Scope is deliberately narrow: only the screen, the active/source report ids,
 * and the live-report cache (keyed "owner/name") are persisted. Volatile,
 * timer-driven, or auth-derived state (processing/ad screens, profile identity,
 * toasts) is never persisted — those are reconstructed from the live session,
 * not from a stale snapshot. `sessionStorage` (not `localStorage`) is used so
 * the snapshot is naturally scoped to the tab session and cleared when the tab
 * closes.
 *
 * Everything here is pure / dependency-free and SSR-safe (it no-ops when
 * `window`/`sessionStorage` is unavailable), so it is unit-testable in isolation
 * from React and Supabase.
 */

import type { Report } from "./types";

/** sessionStorage key for the persisted navigation snapshot. */
const NAV_KEY = "cr-nav-state";

/** Current snapshot schema version — bump to invalidate incompatible old data. */
const NAV_VERSION = 1;

/**
 * Screens that are safe to persist and rehydrate directly. Transient,
 * timer-driven, or auth-gated screens (processing, ad, login, dashboard,
 * profile) are deliberately excluded: restoring them from a stale snapshot
 * would be wrong (a half-finished scan, an expired ad, an auth screen for an
 * already-signed-in user). Persisting only these durable, content screens keeps
 * the rehydration honest — we restore a *view of content*, never a *process*.
 */
export type PersistedScreen = "home" | "report" | "leaderboard";

const PERSISTED_SCREENS: readonly PersistedScreen[] = [
  "home",
  "report",
  "leaderboard",
] as const;

/** Narrow an arbitrary string to a persistable screen (or null if not one). */
export function asPersistedScreen(value: unknown): PersistedScreen | null {
  return typeof value === "string" &&
    (PERSISTED_SCREENS as readonly string[]).includes(value)
    ? (value as PersistedScreen)
    : null;
}

/** The persisted navigation snapshot. */
export interface NavSnapshot {
  screen: PersistedScreen;
  activeRepoId: string | null;
  sourceScreen: PersistedScreen;
  /** Live scan results keyed "owner/repo" — re-served instantly on revisit. */
  liveReports: Record<string, Report>;
}

/** The on-disk envelope (versioned) that wraps a snapshot. */
interface NavEnvelope {
  v: number;
  snapshot: NavSnapshot;
}

/**
 * Decide whether a snapshot is worth restoring. A `report` snapshot is only
 * meaningful with an `activeRepoId`; otherwise it would rehydrate an empty
 * report shell, so it is rejected (falls back to home). `home` and
 * `leaderboard` are always restorable. This is the pure rehydration gate.
 */
export function shouldRestore(snapshot: NavSnapshot): boolean {
  if (snapshot.screen === "report") {
    return snapshot.activeRepoId !== null && snapshot.activeRepoId !== "";
  }
  return true;
}

/** Type guard: is a parsed JSON value a valid `Report` map for our cache. */
function isReportRecord(value: unknown): value is Record<string, Report> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const rep = r as Partial<Report>;
    return (
      typeof rep.id === "string" &&
      typeof rep.owner === "string" &&
      typeof rep.name === "string" &&
      typeof rep.score === "number"
    );
  });
}

/** Validate + narrow a parsed envelope into a `NavSnapshot` (or null). */
function parseEnvelope(raw: string): NavSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as Partial<NavEnvelope>;
  if (env.v !== NAV_VERSION || typeof env.snapshot !== "object" || env.snapshot === null) {
    return null;
  }
  const s = env.snapshot as Partial<NavSnapshot>;
  const screen = asPersistedScreen(s.screen);
  const sourceScreen = asPersistedScreen(s.sourceScreen);
  if (!screen || !sourceScreen) return null;
  const activeRepoId =
    typeof s.activeRepoId === "string" ? s.activeRepoId : null;
  const liveReports = isReportRecord(s.liveReports) ? s.liveReports : {};
  return { screen, activeRepoId, sourceScreen, liveReports };
}

/** Get the tab-scoped storage, or null when unavailable (SSR / disabled). */
function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    // Accessing sessionStorage can throw in some sandboxed contexts.
    return null;
  }
}

/** Read + validate the persisted snapshot, or null if none/invalid/unavailable. */
export function loadNavSnapshot(): NavSnapshot | null {
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(NAV_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const snapshot = parseEnvelope(raw);
  if (!snapshot || !shouldRestore(snapshot)) return null;
  return snapshot;
}

/** Persist a navigation snapshot (no-op when storage is unavailable). */
export function saveNavSnapshot(snapshot: NavSnapshot): void {
  const storage = getStorage();
  if (!storage) return;
  const envelope: NavEnvelope = { v: NAV_VERSION, snapshot };
  try {
    storage.setItem(NAV_KEY, JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage disabled — persistence is best-effort.
  }
}

/** Clear any persisted navigation snapshot (e.g. on sign-out / hard reset). */
export function clearNavSnapshot(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(NAV_KEY);
  } catch {
    // Nothing actionable — clearing is best-effort.
  }
}

/**
 * Build the snapshot to persist from the full reducer state's relevant fields.
 * Returns null when the current screen is not a persistable one (so callers
 * clear rather than write a useless snapshot — e.g. while processing/on login).
 */
export function snapshotFrom(input: {
  screen: string;
  activeRepoId: string | null;
  sourceScreen: string;
  liveReports: Record<string, Report>;
}): NavSnapshot | null {
  const screen = asPersistedScreen(input.screen);
  if (!screen) return null;
  // The source screen is only used to navigate "back"; clamp an unpersistable
  // source (e.g. "dashboard") to "home" so back-from-report still works.
  const sourceScreen = asPersistedScreen(input.sourceScreen) ?? "home";
  return {
    screen,
    activeRepoId: input.activeRepoId,
    sourceScreen,
    liveReports: input.liveReports,
  };
}
