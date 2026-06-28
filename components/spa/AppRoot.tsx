"use client";

/**
 * AppRoot — the single-page app container. Provides the brain (AppProvider) and
 * renders the shared chrome (film grain + 3D card background, the permanent
 * sidebar when logged in, the bottom toast, and the full-screen logs overlay)
 * plus the active screen.
 *
 * The `.cr-root` element carries `data-app` (out / exp / col), which globals.css
 * maps to the left padding that makes room for the floating sidebar. The theme
 * attribute lives on <html> (set by the no-flash script in layout.tsx and
 * flipped by toggleTheme), so it is deliberately NOT duplicated here.
 */

import { useEffect, useRef } from "react";
import { AppProvider, useApp } from "./state";
import { Background } from "./components/Background";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { LogsOverlay } from "./components/LogsOverlay";
import { HomeScreen } from "./screens/HomeScreen";
import { ProcessingScreen } from "./screens/ProcessingScreen";
import { ReportScreen } from "./screens/ReportScreen";
import { LeaderboardScreen } from "./screens/LeaderboardScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ProfileScreen } from "./screens/ProfileScreen";

function CurrentScreen() {
  const { state } = useApp();
  switch (state.screen) {
    case "home":
      return <HomeScreen />;
    case "processing":
      return <ProcessingScreen />;
    case "report":
      return <ReportScreen />;
    case "leaderboard":
      return <LeaderboardScreen />;
    case "login":
      return <LoginScreen />;
    case "dashboard":
      return <DashboardScreen />;
    case "profile":
      return <ProfileScreen />;
    default:
      return <HomeScreen />;
  }
}

/** Force-reveal everything still hidden (IO-unsupported fallback / safety net). */
const REVEAL_SAFETY_MS = 1500;
const REVEAL_SELECTOR = ".reveal:not(.show)";

function Shell() {
  const app = useApp();
  const rootRef = useRef<HTMLDivElement>(null);
  const screen = app.state.screen;

  // Scroll-reveal observer — faithful port of the prototype's `observeReveals()`
  // (`design-source/Claude Rabbit.dc.html` lines ~1131-1143). Runs on mount and
  // re-runs whenever the screen changes (newly mounted `.reveal` sections get
  // observed). Adds `.show` (which globals.css animates) on intersect. Cleanup
  // disconnects the observer and clears the safety timeout, so React Strict Mode
  // double-mount cancels the prior run rather than duplicating it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const els = root.querySelectorAll(REVEAL_SELECTOR);

    // Fallback: no IntersectionObserver → reveal everything immediately.
    if (typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("show"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("show");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.04 },
    );
    els.forEach((el) => io.observe(el));

    // Safety net: force-reveal anything still hidden after a beat.
    const safety = setTimeout(() => {
      root.querySelectorAll(REVEAL_SELECTOR).forEach((el) => el.classList.add("show"));
    }, REVEAL_SAFETY_MS);

    return () => {
      io.disconnect();
      clearTimeout(safety);
    };
  }, [screen]);

  return (
    <div
      ref={rootRef}
      className="cr-root"
      data-app={app.appState}
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--t2)",
        position: "relative",
        overflowX: "hidden",
      }}
    >
      <Background />
      {app.state.loggedIn && <Sidebar />}
      <CurrentScreen />
      <LogsOverlay />
      <Toast />
    </div>
  );
}

export function AppRoot() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
