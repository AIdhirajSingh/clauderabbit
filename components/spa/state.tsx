"use client";

/**
 * The Claude Rabbit SPA "brain" — a faithful React port of the DC prototype's
 * single-component logic (`design-source/Claude Rabbit.dc.html`, the
 * <script> at lines ~983–1374).
 *
 * Everything the prototype kept on `this.state`, in its handler methods, and in
 * `renderVals()`/`viewRepo()` is reproduced here: a `useReducer` holds state, a
 * ref bag holds the imperative timers (proc/ad/toast) cleared-before-start
 * exactly as the prototype did, and mount effects own the star count-up rAF,
 * the `.reveal` IntersectionObserver, and the OS-theme `matchMedia` listener
 * (each with cleanup, so React Strict Mode double-mount does not duplicate
 * them). Selectors mirror the prototype's computed values 1:1.
 *
 * Score coloring goes through `lib/score.ts` everywhere (its band helpers are
 * the same logic the prototype's `C`/`band*` carried).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { ACTIVITY, LEADERBOARD, REPOS, SUGGESTION_IDS, useCases } from "@/lib/demo-data";
import { bandColor, bandGlow, bandLabel, bandTint } from "@/lib/score";
import {
  buildReportView,
  logColor,
  type LogChapterView,
  type PackageScoreView,
  type RepoView,
  type RiskyItemView,
} from "@/lib/report-view";
import { parseRepoInput } from "@/lib/parse-repo";
import { runScan } from "@/lib/scan";
import { decideReportFetch, fetchLatestReportRest } from "@/lib/report-fetch";
import {
  EMPTY_BOARD_DATA,
  fetchBoardData,
  fetchBoardPage,
  type BoardData,
  type BoardDot,
  type BoardStats,
  type ScoreDistribution,
} from "@/lib/board-data";
import {
  clearNavSnapshot,
  loadNavSnapshot,
  saveNavSnapshot,
  snapshotFrom,
} from "@/lib/spa-persist";
import { createClient } from "@/lib/supabase/client";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type {
  ActivityEntry,
  LeaderboardEntry,
  LogChapter,
  Report,
  UseCase,
} from "@/lib/types";
import type { SnapProps } from "./components/Snap";

export type { LogChapterView, PackageScoreView, RepoView, RiskyItemView };

// ───────────────────────────── constants ─────────────────────────────

/** Star count-up target and duration, from the prototype's componentDidMount. */
const STAR_TARGET = 24318;
const STAR_DUR = 1200;
/** Per-step processing interval (ms): deep scans tick slower. */
const PROC_STEP_MS = 740;
const PROC_STEP_DEEP_MS = 880;
/** Delay after the last log step before the report renders. */
const PROC_TAIL_MS = 560;
/** Ad countdown starts here (seconds). */
const AD_SECONDS = 15;
/** Toast auto-dismiss (ms). */
const TOAST_MS = 3400;
/** Delay between picking a suggestion chip and firing the scan. */
const SUGGESTION_PICK_MS = 140;
/**
 * localStorage key for the repo the user was about to scan when the login gate
 * fired. Persisted here (not just in reducer state) because a real OAuth/magic-
 * link sign-in is a full-page redirect that wipes React state — on return we
 * restore it so the user lands ready to scan what they came for.
 */
const PENDING_REPO_KEY = "cr-pending-repo";

// Public Supabase config (inlined by Next at build). Used for the anonymous
// on-demand report read (reports are public; see fetchLatestReportRest).
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export type Screen =
  | "home"
  | "ad"
  | "processing"
  | "report"
  | "leaderboard"
  | "login"
  | "dashboard"
  | "profile";

export type Theme = "light" | "dark";

// ───────────────────────────── state ─────────────────────────────

interface State {
  screen: Screen;
  loggedIn: boolean;
  scanCount: number;
  input: string;
  activeRepoId: string | null;
  sourceScreen: Screen;
  showLogs: boolean;
  adCount: number;
  procStep: number;
  procDeep: boolean;
  procRepoId: string | null;
  failed: boolean;
  toast: string | null;
  toastColor: string;
  profileName: string;
  profileEmail: string;
  editName: boolean;
  editDraft: string;
  starCount: string;
  focused: boolean;
  scannedIds: string[];
  stage1Used: number;
  dynamicUsed: number;
  lbReturn: Screen;
  pendingRepo: string | null;
  theme: Theme;
  sidebarCollapsed: boolean;
  /** Live scan results keyed by "owner/repo" id (real repos, not demo). */
  liveReports: Record<string, Report>;
  /**
   * True while a REAL scan's network request is in flight: the processing
   * screen runs the generic chapter timeline (no pre-known demo logs) and the
   * report is shown when `runScan` resolves rather than on a fixed timer.
   */
  procLive: boolean;
  /**
   * The danger-board bundle (real DB data: ranked caught repos, map dots, live
   * counts, score histogram). Lazily fetched on first board navigation — never
   * on the homepage — so the marketing/SEO surface stays cheap. Starts empty
   * (`loaded: false`) and is replaced once the fetch resolves.
   */
  board: BoardData;
  /** True while the initial board bundle is being fetched (distinct from empty). */
  boardLoading: boolean;
  /** The highest list page already loaded (for infinite-scroll appends). */
  boardPage: number;
  /** True while a "load more" page request is in flight. */
  boardMoreLoading: boolean;
  /**
   * The report id (owner/repo) currently being fetched on demand because the
   * report screen was opened for a repo not yet in `liveReports` (e.g. a
   * danger-board click, a deep-link, or a rehydrated session). Drives the
   * report-screen loading state so it NEVER renders blank.
   */
  reportLoadingId: string | null;
  /**
   * A report id whose on-demand fetch failed (no row, or client unavailable).
   * Acts as a negative cache so the screen shows a graceful "couldn't load"
   * card instead of blanking, and does not auto-retry on every effect run.
   */
  reportErrorId: string | null;
}

const initialState: State = {
  screen: "home",
  loggedIn: false,
  scanCount: 0,
  input: "",
  activeRepoId: null,
  sourceScreen: "home",
  showLogs: false,
  adCount: AD_SECONDS,
  procStep: -1,
  procDeep: false,
  procRepoId: null,
  failed: false,
  toast: null,
  toastColor: "var(--t3)",
  // Identity is populated from the real Supabase session on sign-in (see the
  // auth effect in AppProvider); empty until then.
  profileName: "",
  profileEmail: "",
  editName: false,
  editDraft: "",
  starCount: "0",
  focused: false,
  // Pre-seed history with two real cached scans (keys in lib/demo-data REPOS),
  // so the dashboard/sidebar history is non-empty with real repos on first load.
  scannedIds: ["expressjs/express", "pallets/flask"],
  stage1Used: 1,
  dynamicUsed: 0,
  lbReturn: "home",
  pendingRepo: null,
  theme: "light",
  sidebarCollapsed: false,
  liveReports: {},
  procLive: false,
  board: EMPTY_BOARD_DATA,
  boardLoading: false,
  boardPage: 0,
  boardMoreLoading: false,
  reportLoadingId: null,
  reportErrorId: null,
};

type Action = { type: "PATCH"; patch: Partial<State> };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "PATCH":
      return { ...state, ...action.patch };
    default:
      return state;
  }
}


// ───────────────────────── derived view types ─────────────────────────
// RiskyItemView / PackageScoreView / LogChapterView / RepoView are defined in
// lib/report-view.ts (the shared derivation used by both the SPA and the
// server-rendered report page) and re-exported above.

/** A processing-timeline chapter with derived dot/line/loader/check styling. */
export interface ProcChapterView {
  ch: string;
  lines: string[];
  _dotBg: string;
  _dotBorder: string;
  _titleColor: string;
  _lineColor: string;
  _showLines: boolean;
  _showLoader: boolean;
  _showCheck: boolean;
  _lineThrough: string;
}

/** A homepage suggestion chip. */
export interface SuggestionView {
  id: string;
  label: string;
  color: string;
  onPick: () => void;
}

/** A leaderboard row enriched with rank, band colors, and an open handler. */
export interface LeaderboardView extends LeaderboardEntry {
  rank: number;
  _color: string;
  _glow: string;
  _tint: string;
  _band: string;
  onOpen: () => void;
}

/** A homepage activity entry with its band color. */
export interface ActivityView extends ActivityEntry {
  _color: string;
}

/** A scan-history row (dashboard + sidebar). */
export interface HistoryItem {
  id: string;
  owner: string;
  name: string;
  score: number;
  _color: string;
  verdict: string;
  onOpen: () => void;
}

/** A time-grouped block of history rows. */
export interface HistoryGroup {
  label: string;
  items: HistoryItem[];
}

// ───────────────── page-level decorative card data ─────────────────
// Site-wide background card chrome. `repo` cards name REAL repos with their
// real live-scan scores/stars (from lib/demo-data, plus the project's own real
// repos); `web`/`design`/`code` cards are abstract illustration only — no repo
// is named and no fabricated verdict score is shown. Nothing here is invented.

const PAGE_COL_A: SnapProps[] = [
  { kind: "web", title: "expressjs.com", sub: "Fast, minimalist web framework.", accent: "var(--green)" },
  { kind: "repo", title: "expressjs/express", lang: "JavaScript", langColor: "var(--amber)", stars: "69.2k", score: "98", color: "var(--green)" },
  {
    kind: "code",
    title: "router.js",
    color: "var(--blue)",
    lines: [
      { n: "1", w: "72%", c: "var(--t4)" },
      { n: "2", w: "92%", c: "var(--blue)" },
      { n: "3", w: "48%", c: "var(--t5)" },
      { n: "4", w: "66%", c: "var(--t4)" },
    ],
  },
  { kind: "design", title: "Design system", sub: "Instrument Serif · Geist", accent: "var(--blue)" },
  { kind: "repo", title: "gorilla/mux", lang: "Go", langColor: "var(--amber)", stars: "21.8k", score: "95", color: "var(--green)" },
  { kind: "web", title: "palletsprojects.com", sub: "Web development, one drop at a time.", accent: "var(--blue)" },
];

const PAGE_COL_B: SnapProps[] = [
  {
    kind: "code",
    title: "app.py",
    color: "var(--blue)",
    lines: [
      { n: "1", w: "60%", c: "var(--t4)" },
      { n: "2", w: "85%", c: "var(--blue)" },
      { n: "3", w: "70%", c: "var(--t5)" },
      { n: "4", w: "52%", c: "var(--t4)" },
    ],
  },
  { kind: "repo", title: "claude-rabbit/rabbit", lang: "TypeScript", langColor: "var(--blue)", stars: "24.3k", score: "99", color: "var(--green)" },
  { kind: "web", title: "requests.readthedocs.io", sub: "HTTP for humans.", accent: "var(--blue)" },
  { kind: "repo", title: "AdhirajSinghEntrepreneur/pockit", lang: "Dart", langColor: "var(--blue)", stars: "1.2k", score: "88", color: "var(--blue)" },
  {
    kind: "code",
    title: "index.ts",
    color: "var(--green)",
    lines: [
      { n: "1", w: "80%", c: "var(--t4)" },
      { n: "2", w: "55%", c: "var(--green)" },
      { n: "3", w: "68%", c: "var(--t5)" },
      { n: "4", w: "44%", c: "var(--t4)" },
    ],
  },
  { kind: "repo", title: "psf/requests", lang: "Python", langColor: "var(--blue)", stars: "54k", score: "98", color: "var(--green)" },
];

/** Non-null index helper so noUncheckedIndexedAccess stays satisfied. */
function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) {
    throw new Error(`Missing decorative card at index ${i}`);
  }
  return v;
}

// The three site-wide background columns, each doubled for the seamless marquee.
const BG_COL_A = [at(PAGE_COL_A, 0), at(PAGE_COL_B, 1), at(PAGE_COL_A, 2), at(PAGE_COL_B, 3)];
const BG_COL_B = [at(PAGE_COL_B, 0), at(PAGE_COL_A, 1), at(PAGE_COL_B, 2), at(PAGE_COL_A, 4)];
const BG_COL_C = [at(PAGE_COL_A, 3), at(PAGE_COL_B, 4), at(PAGE_COL_A, 5), at(PAGE_COL_B, 2)];
export const BG_COL_A_DBL = [...BG_COL_A, ...BG_COL_A];
export const BG_COL_B_DBL = [...BG_COL_B, ...BG_COL_B];
export const BG_COL_C_DBL = [...BG_COL_C, ...BG_COL_C];

export const FOOTER_COLS: Array<{ links: string[] }> = [
  { links: ["How it works", "Features", "FAQ", "Pricing"] },
  { links: ["X (Twitter)", "LinkedIn", "Instagram", "GitHub"] },
  { links: ["Privacy Policy", "Terms of Service", "Cookie Policy", "Support"] },
];

/**
 * Repo ids shown as suggestion chips, in order. Derived from the real cached
 * scans in `lib/demo-data.ts` (SUGGESTION_IDS) — the id IS "owner/name", which
 * is also the chip label. No invented repos.
 */
const SUGGESTION_CHIPS: Array<{ id: string; label: string }> = SUGGESTION_IDS.map(
  (id) => ({ id, label: id }),
);

/**
 * Generic fast-path timeline shown while a REAL scan is in flight (the live
 * scan has no pre-known demo logs). Mirrors the fast-path chapters the edge
 * function actually runs: clone → static scan → reputation → read. The step
 * advances on the same timer as the demo flow; the report is shown when the
 * network call resolves, not when the timer ends.
 */
const LIVE_PROC_CHAPTERS: LogChapter[] = [
  {
    ch: "Clone",
    kind: "ok",
    lines: ["Resolving the repository and its latest commit", "Reading the tree at the resolved SHA"],
  },
  {
    ch: "Static scan",
    kind: "ok",
    lines: ["Scanning for install hooks, obfuscation, and credential access", "Flagging regions for the read model"],
  },
  {
    ch: "Reputation",
    kind: "ok",
    lines: ["Checking owner account age and history", "Folding in community signal (kept separate from code)"],
  },
  {
    ch: "Read",
    kind: "ok",
    lines: ["Read model reading only the flagged regions", "Blending the score and finalizing the verdict"],
  },
];

// ───────────────── report-view derivation (shared) ─────────────────
// finalNote / notVerified / sev* / kindLabel / logColor / buildReportView all
// live in lib/report-view.ts so the SPA and the server page derive identically.
// `logColor` is imported above for the processing timeline. The SPA holds live
// reports (from real scans) by id in `liveReports`, falling back to demo REPOS.

/**
 * Stable per-device id for rate-limiting pre-auth scans (the edge function's
 * `deviceId`). Persisted in localStorage; charset bounded to what the function
 * accepts (`[A-Za-z0-9_-]`). Returns undefined if storage/crypto is unavailable.
 */
function getDeviceId(): string | undefined {
  try {
    const KEY = "cr-device-id";
    let id = localStorage.getItem(KEY);
    if (!id) {
      const rand =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36);
      id = rand.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      localStorage.setItem(KEY, id);
    }
    return id || undefined;
  } catch {
    return undefined;
  }
}

/** Derive a display name from a Supabase session user (metadata → email local part). */
function nameFromSession(session: Session): string {
  const u = session.user;
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  const fromMeta =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    "";
  if (fromMeta) return fromMeta;
  const email = u.email ?? "";
  const local = email.split("@")[0];
  return local || "Account";
}

/** The auth-derived fields the SPA mirrors into reducer state on sign-in. */
interface AuthProfile {
  loggedIn: boolean;
  profileName: string;
  profileEmail: string;
}

/** Build the reducer patch for a session (or the signed-out defaults when null). */
function profileFromSession(session: Session | null): AuthProfile {
  if (!session) {
    return { loggedIn: false, profileName: "", profileEmail: "" };
  }
  return {
    loggedIn: true,
    profileName: nameFromSession(session),
    profileEmail: session.user.email ?? "",
  };
}

/** Look up a report by id from the live scan cache first, then the demo set. */
function reportById(
  id: string | null,
  live: Record<string, Report>,
): Report | null {
  if (!id) return null;
  return live[id] ?? REPOS[id] ?? null;
}

/** Enriches a report id into the full `RepoView` (prototype's `viewRepo`). */
function viewRepo(
  id: string | null,
  live: Record<string, Report>,
): RepoView | null {
  const r = reportById(id, live);
  return r ? buildReportView(r) : null;
}

// ───────────────────────────── context shape ─────────────────────────────

export interface AppApi {
  state: State;
  // Selectors (computed view values, mirroring renderVals()).
  activeRepo: RepoView | null;
  activeRepoClean: boolean;
  /** True while the active report is being fetched on demand (loading state). */
  activeReportLoading: boolean;
  /** True when the active report could not be loaded (graceful error state). */
  activeReportError: boolean;
  procChapters: ProcChapterView[];
  procName: string;
  procPhase: string;
  suggestions: SuggestionView[];
  leaderboard: LeaderboardView[];
  leaderTop: LeaderboardView[];
  leaderHero: LeaderboardView | undefined;
  leaderRest: LeaderboardView[];
  /** Real board map dots, live counts, and score histogram (DB-sourced). */
  boardDots: BoardDot[];
  boardStats: BoardStats | null;
  boardDistribution: ScoreDistribution;
  /** True while the initial board bundle is loading (vs. genuinely empty). */
  boardLoading: boolean;
  /** True once the board fetch completed (so "empty" is honestly "nothing caught"). */
  boardLoaded: boolean;
  /** True when more list pages remain for infinite scroll. */
  boardHasMore: boolean;
  /** True while a "load more" page request is in flight. */
  boardMoreLoading: boolean;
  /** Append the next page of the ranked danger list (infinite scroll). */
  loadMoreBoard: () => void;
  /** Ensure the board bundle is loaded (idempotent) — for a rehydrated board screen. */
  ensureBoardLoaded: () => void;
  activity: ActivityView[];
  useCases: UseCase[];
  history: HistoryItem[];
  historyGroups: HistoryGroup[];
  scannedCount: number;
  protectedCount: number;
  isDark: boolean;
  appState: "out" | "exp" | "col";
  bgOpacity: number;
  inputBorder: string;
  inputGlow: string;
  // Handlers (the prototype's methods).
  goHome: () => void;
  goLogin: () => void;
  doScan: () => void;
  onInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onInputKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  noop: (e: React.MouseEvent) => void;
  skipAd: () => void;
  failProcessing: () => void;
  retryScan: () => void;
  openReport: (id: string, from?: Screen) => void;
  /** Load the active report on demand when it isn't in the store (never blank). */
  ensureActiveReport: (id: string | null) => void;
  backFromReport: () => void;
  openLogs: () => void;
  closeLogs: () => void;
  openLeaderboard: () => void;
  backFromLeaderboard: () => void;
  signInWithGoogle: () => void;
  signInWithGitHub: () => void;
  signInWithEmail: (email: string) => void;
  logout: () => void;
  exportPDF: () => void;
  copyLink: () => void;
  goDashboard: () => void;
  goProfile: () => void;
  startEditName: () => void;
  onEditName: (e: React.ChangeEvent<HTMLInputElement>) => void;
  saveName: () => void;
  cancelName: () => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  onSidebarClick: (e: React.MouseEvent) => void;
  logoClick: () => void;
}

const AppContext = createContext<AppApi | null>(null);

/**
 * Keyboard-activation helper for clickable non-button elements (e.g. card
 * `<div onClick>`s). Spreads `role="button"`, `tabIndex={0}`, the click handler,
 * and an `onKeyDown` that fires the same handler on Enter or Space (preventing
 * the default Space scroll). Keeps these interactive divs keyboard-accessible
 * without altering their visuals.
 */
export function onActivate(fn: () => void): {
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  role: "button";
  tabIndex: 0;
} {
  return {
    onClick: fn,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    },
    role: "button",
    tabIndex: 0,
  };
}

/** Hook to read the SPA brain. Throws if used outside the provider. */
export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp must be used within <AppProvider>");
  }
  return ctx;
}

// ───────────────────────────── provider ─────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Whether a content view (report / leaderboard) was rehydrated from
  // sessionStorage on this mount. Used by the auth listener to decide whether a
  // Guards the one-shot rehydration so a StrictMode double-mount cannot apply
  // the snapshot twice (the second pass would re-read it harmlessly, but this
  // keeps the restore strictly idempotent and intention-revealing).
  const rehydratedRef = useRef(false);
  // Skips the persistence effect's FIRST run (the initial mount commit, where
  // `state` is still the pre-rehydration default). Without this, the mount's
  // default `home` state would overwrite a stored `report` snapshot before the
  // rehydration patch is applied on the next commit. After the skip, every real
  // navigation persists normally.
  const persistMountRef = useRef(true);

  // A live mirror of state for handlers that need the freshest value inside
  // setTimeout/setInterval callbacks (the prototype read `this.state` directly).
  // Synced in an effect (never written during render) so React's ref rules hold;
  // handler callbacks only run after commit, so they always see the latest value.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Imperative timers, cleared-before-start exactly like the prototype.
  const procTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const adTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarClickAt = useRef(0);
  // Monotonic token for the in-flight live scan; a stale resolution (retry /
  // navigated away) is ignored when its token no longer matches.
  const liveScanToken = useRef(0);
  // The pending live-scan target (owner/repo + ref) for retry.
  const liveScanTarget = useRef<{ owner: string; repo: string; ref?: string } | null>(null);
  // The report id whose on-demand fetch is in flight. A ref (set synchronously
  // before the await) dedupes concurrent ensureActiveReport calls — including a
  // React StrictMode double-mount — without waiting for an async reducer commit.
  const reportFetchRef = useRef<string | null>(null);

  // The browser Supabase client — a stable single instance (useRef, NOT useMemo)
  // so we never spawn multiple GoTrueClient instances fighting over the auth
  // lock. Created lazily inside the auth effect (refs must not be written during
  // render); null until then, and null permanently if the publishable env is
  // missing (createClient throws), in which case the app stays logged-out.
  const supabaseRef = useRef<SupabaseClient | null>(null);
  /** Get (or lazily create) the browser client. Safe to call post-mount only. */
  const getSupabase = useCallback((): SupabaseClient | null => {
    if (supabaseRef.current === null) {
      try {
        supabaseRef.current = createClient();
      } catch {
        return null;
      }
    }
    return supabaseRef.current;
  }, []);
  // The freshest session, for the scan path's Authorization token. Updated by
  // the auth listener; read inside scan handlers (which run after commit).
  const sessionRef = useRef<Session | null>(null);
  // The user id we have already "landed" (navigated to the dashboard for). Used
  // to distinguish a GENUINE sign-in transition from a re-emitted SIGNED_IN that
  // Supabase fires on tab refocus / session revalidation. Only a transition to a
  // new user id lands; a re-fire for the same already-signed-in user must NOT
  // navigate (that was the tab-switch-drops-the-report bug). `undefined` means
  // "not yet initialized" so the very first INITIAL_SESSION is handled correctly.
  const landedUserRef = useRef<string | undefined>(undefined);

  const patch = useCallback((p: Partial<State>) => dispatch({ type: "PATCH", patch: p }), []);

  const toast = useCallback(
    (msg: string, color: string = "var(--t3)") => {
      patch({ toast: msg, toastColor: color });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => patch({ toast: null }), TOAST_MS);
    },
    [patch],
  );

  // ── rehydrate the durable navigation snapshot (mount, post-hydration) ──
  // Runs in a mount effect (NOT during render) so server and client first-paint
  // agree — avoiding a hydration mismatch — then restores the persisted screen
  // and live-report cache. A restored content view (report / leaderboard) is
  // flagged so the auth listener leaves it intact for a returning logged-in
  // user. Declared before the auth effect so it commits first; the auth
  // INITIAL_SESSION arrives asynchronously (well after these sync mount effects),
  // so the flag is always set in time.
  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    const snap = loadNavSnapshot();
    if (!snap) return;
    patch({
      screen: snap.screen,
      activeRepoId: snap.activeRepoId,
      sourceScreen: snap.sourceScreen,
      liveReports: snap.liveReports,
    });
  }, [patch]);

  // ── star count-up rAF (mount, with cleanup) ──
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / STAR_DUR);
      const e = 1 - Math.pow(1 - t, 3);
      patch({ starCount: Math.round(STAR_TARGET * e).toLocaleString() });
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [patch]);

  // ── theme init + OS preference live listener (mount, with cleanup) ──
  // The no-flash script in layout.tsx already set <html data-theme>; read it so
  // React state matches the painted theme. Then follow OS changes until the
  // user has manually saved a preference (the prototype's matchMedia handler).
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("cr-theme");
    } catch {
      saved = null;
    }
    const current = document.documentElement.getAttribute("data-theme");
    const initial: Theme = current === "dark" ? "dark" : "light";
    if (initial !== stateRef.current.theme) patch({ theme: initial });

    if (saved === "light" || saved === "dark") return;
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (ev: MediaQueryListEvent) => {
      let stillUnset = true;
      try {
        stillUnset = !localStorage.getItem("cr-theme");
      } catch {
        stillUnset = true;
      }
      if (!stillUnset) return;
      const next: Theme = ev.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      patch({ theme: next });
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [patch]);

  // ── prefill the scan box from a `?repo=owner/repo` query param (mount) ──
  // The public "not yet scanned" page links home with the repo prefilled, so
  // the user lands ready to scan it. We only prefill the input (no auto-scan)
  // to keep the first-scan-free / login UX entirely in the user's hands.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const repoParam = params.get("repo");
      if (repoParam) patch({ input: repoParam });
    } catch {
      // No window / malformed URL — nothing to prefill.
    }
  }, [patch]);

  // ── real Supabase auth: session → loggedIn (mount, with cleanup) ──
  // `onAuthStateChange` fires INITIAL_SESSION immediately (covering the initial
  // read), then SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED as they happen. We
  // mirror the session into reducer state and keep `sessionRef` fresh for the
  // scan path's Authorization token. Per Supabase guidance we do NOT `await`
  // any supabase call INSIDE the callback (it holds the auth lock and can
  // deadlock) — the optional profiles-row fetch is deferred to a microtask.
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;

    const applyProfileRow = (session: Session) => {
      // Deferred (not awaited inside the auth callback). Overrides the display
      // name with the user's saved profiles.display_name when present.
      void supabase
        .from("profiles")
        .select("display_name")
        .eq("id", session.user.id)
        .maybeSingle()
        .then(({ data }) => {
          const name = (data as { display_name: string | null } | null)?.display_name;
          if (name && name.trim()) patch({ profileName: name.trim() });
        });
    };

    /**
     * Land a freshly-signed-in user on the dashboard, restoring the repo they
     * were about to scan when the login gate fired (persisted across the
     * full-page OAuth/magic-link redirect, which wiped reducer state).
     */
    const landSignedIn = () => {
      let pending: string | null = null;
      try {
        pending = localStorage.getItem(PENDING_REPO_KEY);
        if (pending) localStorage.removeItem(PENDING_REPO_KEY);
      } catch {
        pending = null;
      }
      patch({
        screen: "dashboard",
        pendingRepo: null,
        ...(pending ? { input: pending } : {}),
      });
      toast("Signed in.", "var(--green)");
    };

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      sessionRef.current = session;
      patch(profileFromSession(session));

      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        // Defer the profile-row read out of the auth-lock callback.
        setTimeout(() => applyProfileRow(session), 0);
      }

      // A real sign-in lands on the dashboard. This is SIGNED_IN for a same-tab
      // sign-in, OR the INITIAL_SESSION right after the auth-callback redirect
      // (marked with ?auth=ok) — where the browser client already holds the
      // cookie-borne session and so never emits SIGNED_IN. We read+strip the
      // marker HERE, at event time (not in the effect body), so a StrictMode
      // double-mount can't consume it before the live subscription fires, and a
      // reload (marker already stripped) won't re-land.
      let shouldLand = event === "SIGNED_IN";
      if (!shouldLand && event === "INITIAL_SESSION" && session) {
        try {
          const u = new URL(window.location.href);
          if (u.searchParams.get("auth") === "ok") {
            u.searchParams.delete("auth");
            window.history.replaceState(null, "", u.pathname + u.search + u.hash);
            shouldLand = true;
          }
        } catch {
          shouldLand = false;
        }
      }

      // ROOT-CAUSE GUARD: Supabase re-emits SIGNED_IN on tab refocus / session
      // revalidation. Landing on every SIGNED_IN bounced a user viewing their
      // report back to the dashboard on tab switch-and-return. Only land on a
      // GENUINE transition — when the session's user id differs from the one we
      // already landed. A re-fire for the same already-signed-in user is a no-op
      // for navigation, so the current screen (e.g. the report) survives.
      const nextUserId = session?.user.id;
      if (shouldLand && nextUserId && nextUserId !== landedUserRef.current) {
        landedUserRef.current = nextUserId;
        landSignedIn();
      } else if (event === "INITIAL_SESSION" && nextUserId) {
        // First INITIAL_SESSION for an existing cookie session that did NOT come
        // from the auth-callback redirect (no ?auth=ok): a returning logged-in
        // user. Record the user so a later SIGNED_IN re-fire is a navigation
        // no-op. If a meaningful content view is persisted (report / leaderboard),
        // LEAVE IT — that is the whole point of the fix. We read the snapshot
        // DIRECTLY here (not a cross-effect ref) so the decision never depends on
        // whether the rehydration effect has committed yet — it is idempotent and
        // timing-independent (review HIGH-1). Land on dashboard only when nothing
        // meaningful is persisted, silently (no "Signed in" toast).
        landedUserRef.current = nextUserId;
        const snap = loadNavSnapshot();
        if (!snap || (snap.screen !== "report" && snap.screen !== "leaderboard")) {
          patch({ screen: "dashboard" });
        }
      }

      if (event === "SIGNED_OUT") {
        landedUserRef.current = undefined;
        clearNavSnapshot();
        patch({ screen: "home", editName: false });
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [getSupabase, patch, toast]);

  // ── persist durable navigation state (screen + active/source report + live
  // report cache) to sessionStorage so a tab switch-and-return or same-session
  // remount restores the exact screen and re-serves cached reports instantly. ──
  // Only content screens (home/report/leaderboard) are persisted; on any other
  // screen (processing/ad/login/dashboard/profile) we clear the snapshot so a
  // remount does not rehydrate a stale process screen.
  useEffect(() => {
    // Skip the initial mount commit: at that point `state` is still the
    // pre-rehydration default, and saving it would clobber a stored snapshot
    // before rehydration applies. The rehydration patch (or any real
    // navigation) re-runs this effect on the next commit, where the state is
    // authoritative.
    if (persistMountRef.current) {
      persistMountRef.current = false;
      return;
    }
    const snap = snapshotFrom({
      screen: state.screen,
      activeRepoId: state.activeRepoId,
      sourceScreen: state.sourceScreen,
      liveReports: state.liveReports,
    });
    if (snap) {
      saveNavSnapshot(snap);
    } else {
      clearNavSnapshot();
    }
  }, [state.screen, state.activeRepoId, state.sourceScreen, state.liveReports]);

  // ── one-shot cleanup for any timers still pending at unmount ──
  useEffect(() => {
    return () => {
      if (procTimer.current) clearInterval(procTimer.current);
      if (adTimer.current) clearInterval(adTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (tailTimer.current) clearTimeout(tailTimer.current);
      if (pickTimer.current) clearTimeout(pickTimer.current);
    };
  }, []);

  // ── handlers ──

  /**
   * Match the current input against a real cached repo (keyed "owner/name"). Returns the demo
   * id when the input clearly names one (so the showcase flows stay instant), or
   * null when it does not — a null means "treat as a real repo and scan it live".
   * Unlike the prototype's round-robin fallback, an unmatched input now falls
   * through to a real scan rather than silently picking a random demo.
   */
  const resolveDemoId = useCallback((): string | null => {
    const v = (stateRef.current.input || "").toLowerCase().trim();
    for (const id in REPOS) {
      const r = REPOS[id];
      if (!r) continue;
      if (v.includes(r.owner + "/" + r.name) || (r.name.length > 4 && v.includes(r.name))) return id;
    }
    return null;
  }, []);

  const startProcessing = useCallback(
    (id: string, from?: Screen) => {
      const repo = REPOS[id];
      if (!repo) return;
      patch({
        screen: "processing",
        procRepoId: id,
        sourceScreen: from ?? stateRef.current.sourceScreen,
        procStep: 0,
        procDeep: repo.deep,
        failed: false,
      });
      if (procTimer.current) clearInterval(procTimer.current);
      if (adTimer.current) clearInterval(adTimer.current);
      const total = repo.logs.length;
      procTimer.current = setInterval(
        () => {
          const step = stateRef.current.procStep + 1;
          if (step >= total) {
            if (procTimer.current) clearInterval(procTimer.current);
            tailTimer.current = setTimeout(() => {
              const cur = stateRef.current;
              const s1 = cur.stage1Used + (repo.deep ? 0 : 1);
              const sd = cur.dynamicUsed + (repo.deep ? 1 : 0);
              patch({
                screen: "report",
                activeRepoId: id,
                scanCount: cur.scanCount + 1,
                scannedIds: cur.scannedIds.includes(id) ? cur.scannedIds : [...cur.scannedIds, id],
                stage1Used: s1,
                dynamicUsed: sd,
              });
            }, PROC_TAIL_MS);
          } else {
            patch({ procStep: step });
          }
        },
        repo.deep ? PROC_STEP_DEEP_MS : PROC_STEP_MS,
      );
    },
    [patch],
  );

  /**
   * Real scan: show the processing screen with the generic live timeline, fire
   * the actual edge-function call, and resolve to the report (success) or the
   * failed state (error). The timeline animates while the request is in flight;
   * the report is shown when the network resolves, not on a fixed timer. The
   * last chapter stays "active" (spinner) until the response lands.
   */
  const startLiveProcessing = useCallback(
    (owner: string, repo: string, ref: string | undefined, from: Screen) => {
      const id = `${owner}/${repo}`;
      liveScanTarget.current = { owner, repo, ...(ref ? { ref } : {}) };
      const token = ++liveScanToken.current;

      patch({
        screen: "processing",
        procRepoId: id,
        procLive: true,
        sourceScreen: from,
        procStep: 0,
        procDeep: false,
        failed: false,
      });

      if (procTimer.current) clearInterval(procTimer.current);
      if (adTimer.current) clearInterval(adTimer.current);
      const total = LIVE_PROC_CHAPTERS.length;
      // Advance through the chapters, then hold on the last one until the
      // network call resolves (do not auto-advance past it).
      procTimer.current = setInterval(() => {
        const step = stateRef.current.procStep + 1;
        if (step >= total - 1) {
          patch({ procStep: total - 1 });
          if (procTimer.current) clearInterval(procTimer.current);
        } else {
          patch({ procStep: step });
        }
      }, PROC_STEP_MS);

      // Always send the deviceId (limits are tracked by login AND device) plus
      // the session access token when signed in, so the function can verify the
      // user and enforce the per-user / per-device daily limit server-side.
      const deviceId = getDeviceId();
      const accessToken = sessionRef.current?.access_token;
      runScan({
        owner,
        repo,
        ...(ref ? { ref } : {}),
        ...(deviceId ? { deviceId } : {}),
        ...(accessToken ? { accessToken } : {}),
      })
        .then((result) => {
          // Ignore a resolution that has been superseded (newer scan / retry).
          if (token !== liveScanToken.current) return;
          if (procTimer.current) clearInterval(procTimer.current);
          if (!result.ok) {
            patch({ failed: true });
            return;
          }
          const report = result.report;
          const cur = stateRef.current;
          patch({
            screen: "report",
            procLive: false,
            activeRepoId: id,
            liveReports: { ...cur.liveReports, [id]: report },
            scanCount: cur.scanCount + 1,
            scannedIds: cur.scannedIds.includes(id) ? cur.scannedIds : [...cur.scannedIds, id],
            stage1Used: cur.stage1Used + (report.deep ? 0 : 1),
            dynamicUsed: cur.dynamicUsed + (report.deep ? 1 : 0),
            showLogs: false,
          });
          if (report.cached) {
            toast("Cached report, served instantly. No compute.", bandColor(report.score));
          }
        })
        .catch(() => {
          // runScan never rejects, but guard anyway so a thrown error still
          // surfaces the retryable failed state rather than hanging the loader.
          if (token !== liveScanToken.current) return;
          if (procTimer.current) clearInterval(procTimer.current);
          patch({ failed: true });
        });
    },
    [patch, toast],
  );

  const startAd = useCallback(
    (id: string, from: Screen) => {
      patch({ screen: "ad", adCount: AD_SECONDS, procRepoId: id, sourceScreen: from });
      if (adTimer.current) clearInterval(adTimer.current);
      if (procTimer.current) clearInterval(procTimer.current);
      adTimer.current = setInterval(() => {
        const c = stateRef.current.adCount - 1;
        if (c <= 0) {
          if (adTimer.current) clearInterval(adTimer.current);
          patch({ adCount: 0 });
          startProcessing(id, from);
        } else {
          patch({ adCount: c });
        }
      }, 1000);
    },
    [patch, startProcessing],
  );

  const doScan = useCallback(() => {
    // Cancel any pending suggestion-chip pick so a stale delayed call can't fire
    // with an outdated screen after the user has navigated away.
    if (pickTimer.current) clearTimeout(pickTimer.current);

    const fresh = stateRef.current.scanCount;
    const from: Screen = stateRef.current.screen === "dashboard" ? "dashboard" : "home";

    // Branch: a seeded DEMO repo (instant showcase) vs a REAL repo (live scan).
    const demoId = resolveDemoId();
    const parsed = demoId ? null : parseRepoInput(stateRef.current.input);

    if (!demoId && !parsed) {
      toast("Enter a GitHub repo as owner/repo or a github.com URL.", "var(--amber)");
      return;
    }

    // The id used for gating + history: the demo id, or "owner/repo" for real.
    const id = demoId ?? `${parsed!.owner}/${parsed!.repo}`;

    // Login gate (preserved exactly): after the free first scan, logged-out
    // users must sign in to continue. The pending repo (input) is restored on login.
    if (fresh >= 1 && !stateRef.current.loggedIn && stateRef.current.screen !== "dashboard") {
      // Persist the pending repo across the full-page OAuth/magic-link redirect
      // (which wipes reducer state); the auth listener restores it on SIGNED_IN.
      try {
        localStorage.setItem(PENDING_REPO_KEY, id);
      } catch {
        // Storage unavailable — pendingRepo still set in-memory for same-tab login.
      }
      patch({ screen: "login", pendingRepo: id });
      toast("Sign in to continue scanning.", "var(--blue)");
      return;
    }

    if (demoId) {
      // ── DEMO path (unchanged): instant cached view, ad gate, or instant proc. ──
      const repo = REPOS[demoId];
      if (!repo) return;
      if (repo.cached || stateRef.current.scannedIds.includes(demoId)) {
        patch({
          activeRepoId: demoId,
          sourceScreen: from,
          screen: "report",
          scanCount: stateRef.current.scanCount + 1,
          showLogs: false,
        });
        toast("Cached report, served instantly. No compute.", bandColor(repo.score));
        return;
      }
      if (fresh === 0) {
        toast("Scan started. First one is on us.", "var(--green)");
        startProcessing(demoId, from);
      } else {
        startAd(demoId, from);
      }
      return;
    }

    // ── REAL path: same first-scan-free / ad UX, but a real backend scan. ──
    // The parser yields owner/repo only; the edge function resolves the default
    // branch when no ref is given, so a live scan does not pass a ref here.
    const { owner, repo } = parsed!;
    const ref: string | undefined = undefined;
    // A repo we already scanned this session: serve the live-cached report.
    const cachedReport = stateRef.current.liveReports[id];
    if (cachedReport && stateRef.current.scannedIds.includes(id)) {
      patch({
        activeRepoId: id,
        sourceScreen: from,
        screen: "report",
        scanCount: stateRef.current.scanCount + 1,
        showLogs: false,
      });
      toast("Cached report, served instantly. No compute.", bandColor(cachedReport.score));
      return;
    }
    if (fresh === 0) {
      toast("Scan started. First one is on us.", "var(--green)");
      startLiveProcessing(owner, repo, ref, from);
    } else {
      patch({ screen: "ad", adCount: AD_SECONDS, sourceScreen: from });
      if (adTimer.current) clearInterval(adTimer.current);
      if (procTimer.current) clearInterval(procTimer.current);
      // The ad gates a real scan: when it ends, kick off the live scan.
      liveScanTarget.current = { owner, repo };
      patch({ procRepoId: id });
      adTimer.current = setInterval(() => {
        const c = stateRef.current.adCount - 1;
        if (c <= 0) {
          if (adTimer.current) clearInterval(adTimer.current);
          patch({ adCount: 0 });
          startLiveProcessing(owner, repo, ref, from);
        } else {
          patch({ adCount: c });
        }
      }, 1000);
    }
  }, [patch, resolveDemoId, startAd, startLiveProcessing, startProcessing, toast]);

  const skipAd = useCallback(() => {
    if (adTimer.current) clearInterval(adTimer.current);
    // A live scan target takes priority (the ad gated a real scan); else demo.
    const target = liveScanTarget.current;
    const cur = stateRef.current;
    if (cur.procLive || (target && (!cur.procRepoId || !REPOS[cur.procRepoId]))) {
      if (target) {
        startLiveProcessing(target.owner, target.repo, target.ref, cur.sourceScreen);
        return;
      }
    }
    startProcessing(cur.procRepoId ?? "", cur.sourceScreen);
  }, [startLiveProcessing, startProcessing]);

  const failProcessing = useCallback(() => {
    if (procTimer.current) clearInterval(procTimer.current);
    if (tailTimer.current) clearTimeout(tailTimer.current);
    // Invalidate any in-flight live scan so a late resolution can't override
    // the failed state the user just triggered.
    liveScanToken.current++;
    patch({ failed: true });
  }, [patch]);

  const retryScan = useCallback(() => {
    const cur = stateRef.current;
    const target = liveScanTarget.current;
    // Retry a real scan if the failed scan was a live one; else the demo flow.
    if (cur.procLive && target) {
      startLiveProcessing(target.owner, target.repo, target.ref, cur.sourceScreen);
    } else {
      startProcessing(cur.procRepoId ?? "", cur.sourceScreen);
    }
  }, [startLiveProcessing, startProcessing]);

  const openReport = useCallback(
    (id: string, from?: Screen) => {
      // Clear any stale on-demand fetch flags from a previous report so a new
      // open starts clean (never inherit another id's loading/error state).
      // ensureActiveReport (called by ReportScreen) loads the report when it
      // isn't already in liveReports.
      patch({
        activeRepoId: id,
        sourceScreen: from ?? stateRef.current.screen,
        screen: "report",
        showLogs: false,
        reportLoadingId: null,
        reportErrorId: null,
      });
    },
    [patch],
  );

  /**
   * Make sure the active report screen has a report to render — the guard that
   * makes the report screen NEVER blank. When `screen === "report"` for an id
   * not already in `liveReports`/REPOS (a danger-board click, a deep-link, or a
   * rehydrated session), fetch the latest report for that owner/repo and store
   * it. ReportScreen shows a loading state meanwhile and a graceful "couldn't
   * load" card on failure — it never returns null. Decision logic is the pure,
   * unit-tested `decideReportFetch`; the in-flight ref dedupes concurrent calls
   * (StrictMode-safe) and the resolve is guarded by the live activeRepoId so a
   * stale fetch for a since-navigated id is ignored.
   */
  const ensureActiveReport = useCallback((idArg: string | null) => {
    const cur = stateRef.current;
    // Use the id passed by the caller (ReportScreen), NOT stateRef: stateRef is
    // synced in an effect, so on the report screen's own mount effect (which runs
    // child-before-parent) it can still hold the PREVIOUS activeRepoId. Reading a
    // stale id here made the fetch never fire → the screen stuck on "Loading".
    const id = idArg;
    const decision = decideReportFetch(
      id,
      !!reportById(id, cur.liveReports),
      reportFetchRef.current,
      cur.reportErrorId,
    );
    switch (decision.kind) {
      case "loaded":
      case "in-flight":
      case "cached-error":
        return;
      case "bad-id":
        if (id) patch({ reportErrorId: id, reportLoadingId: null });
        return;
      case "fetch": {
        const fetchId = id as string;
        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
          // Public env missing — graceful error, never a stuck spinner.
          patch({ reportErrorId: fetchId, reportLoadingId: null });
          return;
        }
        reportFetchRef.current = fetchId;
        patch({ reportLoadingId: fetchId, reportErrorId: null });
        void fetchLatestReportRest(SUPABASE_URL, SUPABASE_ANON_KEY, decision.owner, decision.repo)
          .then((report) => {
            if (reportFetchRef.current === fetchId) reportFetchRef.current = null;
            // Ignore a resolve for a report the user has navigated away from.
            if (stateRef.current.activeRepoId !== fetchId) return;
            if (report) {
              patch({
                liveReports: { ...stateRef.current.liveReports, [fetchId]: report },
                reportLoadingId: null,
                reportErrorId: null,
              });
            } else {
              patch({ reportLoadingId: null, reportErrorId: fetchId });
            }
          })
          .catch(() => {
            if (reportFetchRef.current === fetchId) reportFetchRef.current = null;
            if (stateRef.current.activeRepoId !== fetchId) return;
            patch({ reportLoadingId: null, reportErrorId: fetchId });
          });
        return;
      }
    }
  }, [patch]);

  const goHome = useCallback(() => patch({ screen: "home", showLogs: false }), [patch]);
  const goLogin = useCallback(() => patch({ screen: "login" }), [patch]);
  const backFromReport = useCallback(
    () =>
      patch({
        screen: stateRef.current.sourceScreen || "home",
        showLogs: false,
        reportLoadingId: null,
        reportErrorId: null,
      }),
    [patch],
  );
  const openLogs = useCallback(() => patch({ showLogs: true }), [patch]);
  const closeLogs = useCallback(() => patch({ showLogs: false }), [patch]);
  /**
   * Lazily fetch the danger-board bundle (ranked caught repos + map dots + live
   * counts + score histogram) from the anon-readable DB views via the browser
   * client. Called on first board navigation so the homepage never pays for it.
   * Idempotent: a second call while already loaded (and not forced) is a no-op.
   * On a missing/failed client the board stays its honest empty state; the
   * `boardLoading` flag lets the UI distinguish "loading" from "nothing caught".
   */
  const loadBoard = useCallback(
    (force = false) => {
      const cur = stateRef.current;
      if (cur.boardLoading) return;
      if (!force && cur.board.loaded) return;
      const supabase = getSupabase();
      if (!supabase) {
        // No client (env missing) — leave the honest empty board; do not fake.
        patch({ boardLoading: false });
        return;
      }
      patch({ boardLoading: true });
      void fetchBoardData(supabase)
        .then((data) => {
          patch({ board: data, boardLoading: false, boardPage: 0 });
        })
        .catch(() => {
          // fetchBoardData never rejects, but guard so a thrown error still
          // clears the loading flag (UI then shows the could-not-load state).
          patch({ boardLoading: false });
        });
    },
    [getSupabase, patch],
  );

  /**
   * Append the next page of the ranked list (infinite scroll). No-ops when a
   * page is already in flight, the bundle has not loaded, or there are no more
   * rows. New rows are concatenated immutably; `hasMore` follows the page query.
   */
  const loadMoreBoard = useCallback(() => {
    const cur = stateRef.current;
    if (cur.boardMoreLoading || !cur.board.loaded || !cur.board.hasMore) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const nextPage = cur.boardPage + 1;
    patch({ boardMoreLoading: true });
    void fetchBoardPage(supabase, nextPage)
      .then((res) => {
        const prev = stateRef.current;
        if (!res.ok) {
          patch({ boardMoreLoading: false });
          return;
        }
        patch({
          board: {
            ...prev.board,
            rows: [...prev.board.rows, ...res.rows],
            hasMore: res.hasMore,
          },
          boardPage: nextPage,
          boardMoreLoading: false,
        });
      })
      .catch(() => patch({ boardMoreLoading: false }));
  }, [getSupabase, patch]);

  const openLeaderboard = useCallback(() => {
    patch({ lbReturn: stateRef.current.screen, screen: "leaderboard" });
    // Fetch real board data on first navigation (lazy — never on the homepage).
    loadBoard();
  }, [loadBoard, patch]);
  const backFromLeaderboard = useCallback(
    () => patch({ screen: stateRef.current.lbReturn || (stateRef.current.loggedIn ? "dashboard" : "home") }),
    [patch],
  );

  /** The app origin used for OAuth / magic-link redirect targets. */
  const authRedirectUrl = useCallback((): string => {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:2311";
    return `${origin.replace(/\/$/, "")}/auth/callback`;
  }, []);

  /** Start an OAuth provider — a full-page redirect; the callback finishes the session. */
  const signInWithProvider = useCallback(
    (provider: "google" | "github", label: string) => {
      const supabase = getSupabase();
      if (!supabase) {
        toast("Sign-in is not configured.", "var(--amber)");
        return;
      }
      void supabase.auth
        .signInWithOAuth({
          provider,
          options: { redirectTo: authRedirectUrl() },
        })
        .then(({ error }) => {
          if (error) toast(`Could not start ${label} sign-in.`, "var(--amber)");
        });
    },
    [authRedirectUrl, getSupabase, toast],
  );

  const signInWithGoogle = useCallback(
    () => signInWithProvider("google", "Google"),
    [signInWithProvider],
  );
  const signInWithGitHub = useCallback(
    () => signInWithProvider("github", "GitHub"),
    [signInWithProvider],
  );

  /** Send an email magic-link / OTP. No provider creds needed; works on its own. */
  const signInWithEmail = useCallback(
    (email: string) => {
      const addr = (email || "").trim();
      if (!addr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
        toast("Enter a valid email address.", "var(--amber)");
        return;
      }
      const supabase = getSupabase();
      if (!supabase) {
        toast("Sign-in is not configured.", "var(--amber)");
        return;
      }
      void supabase.auth
        .signInWithOtp({
          email: addr,
          options: { emailRedirectTo: authRedirectUrl() },
        })
        .then(({ error }) => {
          if (error) {
            toast("Could not send the sign-in link. Try again.", "var(--amber)");
          } else {
            toast("Check your email for the sign-in link.", "var(--blue)");
          }
        });
    },
    [authRedirectUrl, getSupabase, toast],
  );

  const logout = useCallback(() => {
    const supabase = getSupabase();
    // The SIGNED_OUT listener resets screen/loggedIn; patch immediately too so
    // the UI flips even if the network sign-out is slow, then confirm.
    patch({ loggedIn: false, screen: "home", editName: false });
    toast("Signed out.");
    if (supabase) void supabase.auth.signOut();
  }, [getSupabase, patch, toast]);

  const exportPDF = useCallback(() => {
    // Honest export: open the browser's print dialog, where the user can
    // "Save as PDF". This product never claims a success it did not perform —
    // the old handler toasted "PDF report generated" while generating nothing.
    if (typeof window === "undefined" || typeof window.print !== "function") {
      toast("Saving to PDF isn't available in this browser.", "var(--amber)");
      return;
    }
    window.print();
  }, [toast]);
  const copyLink = useCallback(() => {
    const cur = stateRef.current;
    const r = reportById(cur.activeRepoId, cur.liveReports);
    const path = r ? `${r.owner}/${r.name}` : "";
    // Copy the real public report URL (the SEO surface) when one is available.
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://claude-rabbit.dev";
    const url = `${origin}/${path}`;
    try {
      navigator.clipboard?.writeText(url);
    } catch {
      // Clipboard unavailable (insecure context / denied) — still confirm visually.
    }
    toast("Link copied: " + url.replace(/^https?:\/\//, ""), "var(--green)");
  }, [toast]);

  const goDashboard = useCallback(() => patch({ screen: "dashboard" }), [patch]);
  const goProfile = useCallback(() => patch({ screen: "profile" }), [patch]);
  const startEditName = useCallback(
    () => patch({ editName: true, editDraft: stateRef.current.profileName }),
    [patch],
  );
  const onEditName = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => patch({ editDraft: e.target.value }),
    [patch],
  );
  const saveName = useCallback(() => {
    const cur = stateRef.current;
    const next = (cur.editDraft || "").trim() || cur.profileName;
    // Optimistic local update (the UI flips immediately).
    patch({ profileName: next, editName: false });
    toast("Profile updated.", "var(--green)");
    // Persist to the user's own profiles row (RLS allows own-row update).
    const supabase = getSupabase();
    const userId = sessionRef.current?.user.id;
    if (supabase && userId) {
      void supabase
        .from("profiles")
        .update({ display_name: next })
        .eq("id", userId)
        .then(({ error }) => {
          if (error) toast("Saved locally, but the server update failed.", "var(--amber)");
        });
    }
  }, [getSupabase, patch, toast]);
  const cancelName = useCallback(() => patch({ editName: false }), [patch]);

  const toggleTheme = useCallback(() => {
    const t: Theme = stateRef.current.theme === "light" ? "dark" : "light";
    patch({ theme: t });
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("cr-theme", t);
    } catch {
      // localStorage unavailable (private mode); in-memory toggle still works.
    }
    toast(t === "dark" ? "Dark theme" : "Light theme", "var(--t3)");
  }, [patch, toast]);

  const toggleSidebar = useCallback(
    () => patch({ sidebarCollapsed: !stateRef.current.sidebarCollapsed }),
    [patch],
  );

  const onSidebarClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest && target.closest("button,a,input")) return;
      const now = Date.now();
      if (sidebarClickAt.current && now - sidebarClickAt.current < 300) return;
      sidebarClickAt.current = now;
      patch({ sidebarCollapsed: !stateRef.current.sidebarCollapsed });
    },
    [patch],
  );

  const logoClick = useCallback(
    () => patch({ screen: stateRef.current.loggedIn ? "dashboard" : "home", showLogs: false }),
    [patch],
  );

  const onInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => patch({ input: e.target.value }),
    [patch],
  );
  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") doScan();
    },
    [doScan],
  );
  const onFocus = useCallback(() => patch({ focused: true }), [patch]);
  const onBlur = useCallback(() => patch({ focused: false }), [patch]);
  const noop = useCallback((e: React.MouseEvent) => {
    if (e && e.preventDefault) e.preventDefault();
  }, []);

  // ── selectors (mirror renderVals) ──

  const active = useMemo(
    () => viewRepo(state.activeRepoId, state.liveReports),
    [state.activeRepoId, state.liveReports],
  );
  const activeRepoClean = !!(active && !active._hasRisky);

  // The processing screen drives off a demo repo's known logs OR, for a real
  // scan in flight, the generic live timeline. `procLogs` is whichever applies.
  const procDemoRepo = state.procRepoId ? REPOS[state.procRepoId] : null;
  const procLogs = useMemo<LogChapter[]>(
    () => (state.procLive ? LIVE_PROC_CHAPTERS : (procDemoRepo?.logs ?? [])),
    [state.procLive, procDemoRepo],
  );
  const procChapters = useMemo<ProcChapterView[]>(() => {
    if (procLogs.length === 0) return [];
    return procLogs.map((l, i) => {
      const st = i < state.procStep ? "done" : i === state.procStep ? "active" : "pending";
      const col = logColor(l.kind);
      const isLast = i >= procLogs.length - 1;
      return {
        ch: l.ch,
        lines: l.lines,
        _dotBg: st === "done" ? col : "transparent",
        _dotBorder: st === "pending" ? "var(--line2)" : col,
        _titleColor: st === "pending" ? "var(--t5)" : st === "active" ? "var(--t1)" : "var(--t3)",
        _lineColor: col,
        _showLines: st !== "pending",
        _showLoader: st === "active",
        _showCheck: st === "done",
        _lineThrough: isLast ? "transparent" : st === "done" ? col : "var(--line)",
      };
    });
  }, [procLogs, state.procStep]);

  // For a live scan the repo name comes from the pending id; otherwise the demo repo.
  const procName = procDemoRepo
    ? procDemoRepo.owner + "/" + procDemoRepo.name
    : state.procLive && state.procRepoId
      ? state.procRepoId
      : "";
  const procPhase = procLogs.length
    ? state.procStep >= procLogs.length - 1
      ? "Finalizing verdict"
      : state.procDeep && state.procStep >= 3
        ? "Running in the sandbox"
        : "Analyzing"
    : "";

  const pickSuggestion = useCallback(
    (id: string) => {
      const r = REPOS[id];
      if (!r) return;
      patch({ input: "github.com/" + r.owner + "/" + r.name });
      if (pickTimer.current) clearTimeout(pickTimer.current);
      pickTimer.current = setTimeout(() => doScan(), SUGGESTION_PICK_MS);
    },
    [doScan, patch],
  );

  const suggestions = useMemo<SuggestionView[]>(
    () =>
      SUGGESTION_CHIPS.map(({ id, label }) => {
        const r = REPOS[id];
        return {
          id,
          label,
          color: r ? bandColor(r.score) : "var(--t3)",
          onPick: () => pickSuggestion(id),
        };
      }),
    [pickSuggestion],
  );

  // The ranked danger list is built from REAL caught repos in `state.board.rows`
  // (the DB `v_leaderboard_full` view), enriched with rank + the fixed band
  // colors. `LEADERBOARD` (an honest `[]`) is the empty fallback before the
  // lazy board fetch lands or when nothing has been caught. No invented rows.
  const leaderboard = useMemo<LeaderboardView[]>(() => {
    const source: LeaderboardEntry[] =
      state.board.rows.length > 0 ? state.board.rows : LEADERBOARD;
    return source.map((x, i) => ({
      ...x,
      rank: i + 1,
      _color: bandColor(x.score),
      _glow: bandGlow(x.score),
      _tint: bandTint(x.score),
      _band: bandLabel(x.score),
      onOpen: x.id
        ? () => openReport(x.id as string, "leaderboard")
        : () => toast("That report is not available yet."),
    }));
  }, [state.board.rows, openReport, toast]);

  const activity = useMemo<ActivityView[]>(
    () => ACTIVITY.map((a) => ({ ...a, _color: bandColor(a.score) })),
    [],
  );

  const history = useMemo<HistoryItem[]>(
    () =>
      state.scannedIds
        .map((id) => {
          const r = reportById(id, state.liveReports);
          return r
            ? {
                id,
                owner: r.owner,
                name: r.name,
                score: r.score,
                _color: bandColor(r.score),
                verdict: r.verdict,
                onOpen: () => openReport(id, "dashboard"),
              }
            : null;
        })
        .filter((h): h is HistoryItem => h !== null)
        .reverse(),
    [state.scannedIds, state.liveReports, openReport],
  );

  const historyGroups = useMemo<HistoryGroup[]>(() => {
    const groups: HistoryGroup[] = [];
    if (history.length) {
      groups.push({ label: "Today", items: history.slice(0, 2) });
      if (history.length > 2) groups.push({ label: "Earlier", items: history.slice(2) });
    }
    return groups;
  }, [history]);

  const scannedCount = state.scannedIds.length + 5;
  const protectedCount =
    state.scannedIds.filter((id) => {
      const r = reportById(id, state.liveReports);
      return r ? r.score < 60 : false;
    }).length + 2;

  const isDark = state.theme === "dark";
  const appState: "out" | "exp" | "col" = !state.loggedIn ? "out" : state.sidebarCollapsed ? "col" : "exp";
  const bgOpacity = state.theme === "dark" ? 0.05 : 0.045;
  const inputBorder = state.focused ? "var(--line3)" : "var(--line2)";
  const inputGlow = state.focused ? "5px var(--green-t)" : "0px transparent";

  const api = useMemo<AppApi>(
    () => ({
      state,
      activeRepo: active,
      activeRepoClean,
      activeReportLoading:
        !!state.activeRepoId && state.reportLoadingId === state.activeRepoId,
      activeReportError:
        !!state.activeRepoId && state.reportErrorId === state.activeRepoId,
      procChapters,
      procName,
      procPhase,
      suggestions,
      leaderboard,
      leaderTop: leaderboard.slice(0, 5),
      leaderHero: leaderboard[0],
      leaderRest: leaderboard.slice(1),
      boardDots: state.board.dots,
      boardStats: state.board.stats,
      boardDistribution: state.board.distribution,
      boardLoading: state.boardLoading,
      boardLoaded: state.board.loaded,
      boardHasMore: state.board.hasMore,
      boardMoreLoading: state.boardMoreLoading,
      loadMoreBoard,
      ensureBoardLoaded: loadBoard,
      activity,
      useCases,
      history,
      historyGroups,
      scannedCount,
      protectedCount,
      isDark,
      appState,
      bgOpacity,
      inputBorder,
      inputGlow,
      goHome,
      goLogin,
      doScan,
      onInput,
      onInputKey,
      onFocus,
      onBlur,
      noop,
      skipAd,
      failProcessing,
      retryScan,
      openReport,
      ensureActiveReport,
      backFromReport,
      openLogs,
      closeLogs,
      openLeaderboard,
      backFromLeaderboard,
      signInWithGoogle,
      signInWithGitHub,
      signInWithEmail,
      logout,
      exportPDF,
      copyLink,
      goDashboard,
      goProfile,
      startEditName,
      onEditName,
      saveName,
      cancelName,
      toggleTheme,
      toggleSidebar,
      onSidebarClick,
      logoClick,
    }),
    [
      state,
      active,
      activeRepoClean,
      procChapters,
      procName,
      procPhase,
      suggestions,
      leaderboard,
      loadMoreBoard,
      loadBoard,
      activity,
      history,
      historyGroups,
      scannedCount,
      protectedCount,
      isDark,
      appState,
      bgOpacity,
      inputBorder,
      inputGlow,
      goHome,
      goLogin,
      doScan,
      onInput,
      onInputKey,
      onFocus,
      onBlur,
      noop,
      skipAd,
      failProcessing,
      retryScan,
      openReport,
      ensureActiveReport,
      backFromReport,
      openLogs,
      closeLogs,
      openLeaderboard,
      backFromLeaderboard,
      signInWithGoogle,
      signInWithGitHub,
      signInWithEmail,
      logout,
      exportPDF,
      copyLink,
      goDashboard,
      goProfile,
      startEditName,
      onEditName,
      saveName,
      cancelName,
      toggleTheme,
      toggleSidebar,
      onSidebarClick,
      logoClick,
    ],
  );

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>;
}
