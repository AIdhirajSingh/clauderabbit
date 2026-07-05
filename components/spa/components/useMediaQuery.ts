"use client";

import { useSyncExternalStore } from "react";

/**
 * Real, live viewport-width match — the design was built as a single fixed
 * desktop layout with no responsive breakpoints at all (verified: no
 * `@media` in spa.module.css, no viewport hook anywhere), so several
 * multi-column `gridTemplateColumns` sections and the fixed-width scan bar
 * genuinely overflow a phone viewport (their grid tracks default to
 * `min-width: auto` and never shrink below their content's intrinsic
 * width). This hook lets a screen collapse those specific inline styles on
 * narrow viewports without a wholesale CSS-module rewrite of a faithfully-
 * ported design. Same `matchMedia` signal already used for the OS
 * `prefers-color-scheme` listener (state.tsx), read via `useSyncExternalStore`
 * — the correct React API for subscribing to an external, browser-only data
 * source, so there is no setState-in-effect (a real lint violation the naive
 * useState+useEffect version tripped) and no hydration mismatch.
 *
 * SSR-safe: the server snapshot is always `false` (desktop layout) and syncs
 * to the real viewport on the client's first paint, so the server-rendered
 * markup never guesses a client's width.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (!window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** The one narrow-viewport breakpoint this port actually needs — below this,
 * multi-column grids collapse to a single column and fixed side-by-side
 * layouts stack. Chosen to clear a real 375px phone viewport with margin. */
export const MOBILE_BREAKPOINT = "(max-width: 720px)";

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT);
}
