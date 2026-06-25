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
import { ACTIVITY, LEADERBOARD, REPOS, useCases } from "@/lib/demo-data";
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
  profileName: "Ana Mirza",
  profileEmail: "ana@mirza.dev",
  editName: false,
  editDraft: "",
  starCount: "0",
  focused: false,
  scannedIds: ["r1", "r6"],
  stage1Used: 1,
  dynamicUsed: 0,
  lbReturn: "home",
  pendingRepo: null,
  theme: "light",
  sidebarCollapsed: false,
  liveReports: {},
  procLive: false,
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
// These live in the prototype's main `renderVals()` scope (lines ~1297–1320),
// distinct from Orbit's own internal cards. Ported verbatim.

const PAGE_COL_A: SnapProps[] = [
  { kind: "web", title: "verdant.dev", sub: "Routing that just works.", accent: "var(--green)" },
  { kind: "repo", title: "verdant/ratchet", lang: "TypeScript", langColor: "var(--blue)", stars: "41.2k", score: "96", color: "var(--green)" },
  {
    kind: "code",
    title: "install.sh",
    score: "18",
    color: "var(--red)",
    lines: [
      { n: "1", w: "72%", c: "var(--t4)" },
      { n: "2", w: "92%", c: "var(--red)" },
      { n: "3", w: "48%", c: "var(--t5)" },
      { n: "4", w: "66%", c: "var(--t4)" },
    ],
  },
  { kind: "design", title: "Design system", sub: "Instrument Serif · Geist", accent: "var(--blue)" },
  { kind: "repo", title: "fastlib/crypto-utils", lang: "JavaScript", langColor: "var(--amber)", stars: "94", score: "18", color: "var(--red)" },
  { kind: "web", title: "pomodoro.cli", sub: "Focus, one tomato at a time.", accent: "var(--amber)" },
];

const PAGE_COL_B: SnapProps[] = [
  {
    kind: "code",
    title: "postinstall.js",
    score: "71",
    color: "var(--amber)",
    lines: [
      { n: "1", w: "60%", c: "var(--t4)" },
      { n: "2", w: "85%", c: "var(--amber)" },
      { n: "3", w: "70%", c: "var(--t5)" },
      { n: "4", w: "52%", c: "var(--t4)" },
    ],
  },
  { kind: "repo", title: "claude-rabbit/rabbit", lang: "TypeScript", langColor: "var(--blue)", stars: "24.3k", score: "99", color: "var(--green)" },
  { kind: "web", title: "envguard.io", sub: "Validate every variable.", accent: "var(--blue)" },
  { kind: "repo", title: "AdhirajSinghEntrepreneur/pockit", lang: "Dart", langColor: "var(--blue)", stars: "1.2k", score: "88", color: "var(--blue)" },
  {
    kind: "code",
    title: "index.ts",
    score: "96",
    color: "var(--green)",
    lines: [
      { n: "1", w: "80%", c: "var(--t4)" },
      { n: "2", w: "55%", c: "var(--green)" },
      { n: "3", w: "68%", c: "var(--t5)" },
      { n: "4", w: "44%", c: "var(--t4)" },
    ],
  },
  { kind: "repo", title: "marlow/envguard", lang: "TypeScript", langColor: "var(--blue)", stars: "3.4k", score: "88", color: "var(--blue)" },
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

/** Repo ids shown as suggestion chips, in order (prototype's `suggestions`). */
const SUGGESTION_CHIPS: Array<{ id: string; label: string }> = [
  { id: "r1", label: "verdant/ratchet" },
  { id: "r2", label: "marlow/envguard" },
  { id: "r3", label: "quickdev/setup-helper" },
  { id: "r5", label: "fastlib/crypto-utils" },
];

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
  procChapters: ProcChapterView[];
  procName: string;
  procPhase: string;
  suggestions: SuggestionView[];
  leaderboard: LeaderboardView[];
  leaderTop: LeaderboardView[];
  leaderHero: LeaderboardView | undefined;
  leaderRest: LeaderboardView[];
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
  backFromReport: () => void;
  openLogs: () => void;
  closeLogs: () => void;
  openLeaderboard: () => void;
  backFromLeaderboard: () => void;
  doLogin: () => void;
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

  const patch = useCallback((p: Partial<State>) => dispatch({ type: "PATCH", patch: p }), []);

  const toast = useCallback(
    (msg: string, color: string = "var(--t3)") => {
      patch({ toast: msg, toastColor: color });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => patch({ toast: null }), TOAST_MS);
    },
    [patch],
  );

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
   * Match the current input against a seeded DEMO repo (r1–r6). Returns the demo
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

      const deviceId = stateRef.current.loggedIn ? undefined : getDeviceId();
      runScan({ owner, repo, ...(ref ? { ref } : {}), ...(deviceId ? { deviceId } : {}) })
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
      patch({ activeRepoId: id, sourceScreen: from ?? stateRef.current.screen, screen: "report", showLogs: false });
    },
    [patch],
  );

  const goHome = useCallback(() => patch({ screen: "home", showLogs: false }), [patch]);
  const goLogin = useCallback(() => patch({ screen: "login" }), [patch]);
  const backFromReport = useCallback(
    () => patch({ screen: stateRef.current.sourceScreen || "home", showLogs: false }),
    [patch],
  );
  const openLogs = useCallback(() => patch({ showLogs: true }), [patch]);
  const closeLogs = useCallback(() => patch({ showLogs: false }), [patch]);
  const openLeaderboard = useCallback(() => patch({ lbReturn: stateRef.current.screen, screen: "leaderboard" }), [patch]);
  const backFromLeaderboard = useCallback(
    () => patch({ screen: stateRef.current.lbReturn || (stateRef.current.loggedIn ? "dashboard" : "home") }),
    [patch],
  );

  const doLogin = useCallback(() => {
    patch({ loggedIn: true, screen: "dashboard", pendingRepo: null });
    toast("Signed in. Welcome back, Ana.", "var(--green)");
  }, [patch, toast]);

  const logout = useCallback(() => {
    patch({ loggedIn: false, screen: "home", editName: false });
    toast("Signed out.");
  }, [patch, toast]);

  const exportPDF = useCallback(() => toast("PDF report generated.", "var(--green)"), [toast]);
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
    patch({ profileName: (cur.editDraft || "").trim() || cur.profileName, editName: false });
    toast("Profile updated.", "var(--green)");
  }, [patch, toast]);
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

  const leaderboard = useMemo<LeaderboardView[]>(
    () =>
      LEADERBOARD.map((x, i) => ({
        ...x,
        rank: i + 1,
        _color: bandColor(x.score),
        _glow: bandGlow(x.score),
        _tint: bandTint(x.score),
        _band: bandLabel(x.score),
        onOpen: x.id
          ? () => openReport(x.id as string, "leaderboard")
          : () => toast("That report is not in this demo set."),
      })),
    [openReport, toast],
  );

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
      procChapters,
      procName,
      procPhase,
      suggestions,
      leaderboard,
      leaderTop: leaderboard.slice(0, 5),
      leaderHero: leaderboard[0],
      leaderRest: leaderboard.slice(1),
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
      backFromReport,
      openLogs,
      closeLogs,
      openLeaderboard,
      backFromLeaderboard,
      doLogin,
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
      backFromReport,
      openLogs,
      closeLogs,
      openLeaderboard,
      backFromLeaderboard,
      doLogin,
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
