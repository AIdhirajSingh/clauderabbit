/**
 * Unit tests for the SPA navigation/report persistence helper
 * (`lib/spa-persist.ts`) — the dependency-free core of the tab-switch fix.
 *
 * These prove the load/save round-trip, the rehydration gate (a report snapshot
 * with no active id is rejected, a report with an id is restored), version
 * invalidation, malformed-input rejection, and the screen-narrowing logic. The
 * module reads `window.sessionStorage`; we install a minimal in-memory fake on
 * `globalThis.window` so the pure logic runs under `node --test` with no DOM.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Report } from "../lib/types.ts";
import {
  asPersistedScreen,
  clearNavSnapshot,
  loadNavSnapshot,
  saveNavSnapshot,
  shouldRestore,
  snapshotFrom,
  type NavSnapshot,
} from "../lib/spa-persist.ts";

// ── minimal in-memory sessionStorage fake ──
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    sessionStorage: new MemoryStorage(),
  };
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

/** A minimal valid Report for the live-report cache. */
function makeReport(id: string, owner: string, name: string, score: number): Report {
  return {
    id,
    owner,
    name,
    score,
    verdict: "Trusted",
    cached: false,
    deep: false,
    summary: "",
    ownerHistory: { handle: owner, name: owner, age: "5 yr", established: true, repos: 10, note: "" },
    reputation: { stars: "1k", forks: "100", sentiment: "positive", sentScore: 80 },
    stats: { loc: "1,000", packages: 5, stars: "1k", created: "2019" },
    packages: [],
    risky: [],
    logs: [],
  };
}

test("asPersistedScreen narrows only durable content screens", () => {
  assert.equal(asPersistedScreen("home"), "home");
  assert.equal(asPersistedScreen("report"), "report");
  assert.equal(asPersistedScreen("leaderboard"), "leaderboard");
  assert.equal(asPersistedScreen("processing"), null);
  assert.equal(asPersistedScreen("dashboard"), null);
  assert.equal(asPersistedScreen("login"), null);
  assert.equal(asPersistedScreen(42), null);
  assert.equal(asPersistedScreen(undefined), null);
});

test("shouldRestore rejects a report snapshot with no active id", () => {
  const noId: NavSnapshot = { screen: "report", activeRepoId: null, sourceScreen: "home", liveReports: {} };
  const emptyId: NavSnapshot = { screen: "report", activeRepoId: "", sourceScreen: "home", liveReports: {} };
  const withId: NavSnapshot = { screen: "report", activeRepoId: "psf/requests", sourceScreen: "home", liveReports: {} };
  assert.equal(shouldRestore(noId), false);
  assert.equal(shouldRestore(emptyId), false);
  assert.equal(shouldRestore(withId), true);
});

test("shouldRestore always allows home and leaderboard", () => {
  assert.equal(shouldRestore({ screen: "home", activeRepoId: null, sourceScreen: "home", liveReports: {} }), true);
  assert.equal(shouldRestore({ screen: "leaderboard", activeRepoId: null, sourceScreen: "home", liveReports: {} }), true);
});

test("snapshotFrom returns null for a non-content screen", () => {
  assert.equal(
    snapshotFrom({ screen: "processing", activeRepoId: "a/b", sourceScreen: "home", liveReports: {} }),
    null,
  );
  assert.equal(
    snapshotFrom({ screen: "dashboard", activeRepoId: null, sourceScreen: "home", liveReports: {} }),
    null,
  );
});

test("snapshotFrom clamps an unpersistable source screen to home", () => {
  const snap = snapshotFrom({
    screen: "report",
    activeRepoId: "a/b",
    sourceScreen: "dashboard",
    liveReports: {},
  });
  assert.ok(snap);
  assert.equal(snap.sourceScreen, "home");
  assert.equal(snap.screen, "report");
});

test("save then load round-trips a report snapshot with its live report", () => {
  const report = makeReport("octocat/hello", "octocat", "hello", 91);
  const snapshot: NavSnapshot = {
    screen: "report",
    activeRepoId: "octocat/hello",
    sourceScreen: "home",
    liveReports: { "octocat/hello": report },
  };
  saveNavSnapshot(snapshot);
  const loaded = loadNavSnapshot();
  assert.deepEqual(loaded, snapshot);
  // The cached report survives so a revisit re-serves it instantly.
  assert.equal(loaded?.liveReports["octocat/hello"]?.score, 91);
});

test("loadNavSnapshot returns null after clear", () => {
  saveNavSnapshot({ screen: "home", activeRepoId: null, sourceScreen: "home", liveReports: {} });
  assert.ok(loadNavSnapshot());
  clearNavSnapshot();
  assert.equal(loadNavSnapshot(), null);
});

test("loadNavSnapshot rejects a report snapshot persisted without an id", () => {
  // A report snapshot with no id should never have been written, but if a stale
  // one exists it must not rehydrate an empty report shell.
  saveNavSnapshot({ screen: "report", activeRepoId: null, sourceScreen: "home", liveReports: {} });
  assert.equal(loadNavSnapshot(), null);
});

test("loadNavSnapshot rejects a wrong-version or malformed envelope", () => {
  const win = (globalThis as unknown as { window: { sessionStorage: MemoryStorage } }).window;
  win.sessionStorage.setItem("cr-nav-state", JSON.stringify({ v: 999, snapshot: { screen: "report", activeRepoId: "a/b", sourceScreen: "home", liveReports: {} } }));
  assert.equal(loadNavSnapshot(), null);
  win.sessionStorage.setItem("cr-nav-state", "{ not json");
  assert.equal(loadNavSnapshot(), null);
  win.sessionStorage.setItem("cr-nav-state", JSON.stringify({ v: 1, snapshot: { screen: "dashboard", activeRepoId: null, sourceScreen: "home", liveReports: {} } }));
  assert.equal(loadNavSnapshot(), null);
});

test("save/load is a no-op (null) when window/sessionStorage is unavailable", () => {
  (globalThis as { window?: unknown }).window = undefined;
  // Must not throw, and must report nothing persisted.
  saveNavSnapshot({ screen: "home", activeRepoId: null, sourceScreen: "home", liveReports: {} });
  assert.equal(loadNavSnapshot(), null);
});

test("malformed liveReports is dropped to an empty cache, not rejected", () => {
  const win = (globalThis as unknown as { window: { sessionStorage: MemoryStorage } }).window;
  win.sessionStorage.setItem(
    "cr-nav-state",
    JSON.stringify({ v: 1, snapshot: { screen: "report", activeRepoId: "a/b", sourceScreen: "home", liveReports: { bad: { nope: true } } } }),
  );
  const loaded = loadNavSnapshot();
  assert.ok(loaded);
  assert.equal(loaded.screen, "report");
  assert.deepEqual(loaded.liveReports, {});
});
