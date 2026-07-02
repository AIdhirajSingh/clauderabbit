"use client";

/**
 * Lightweight loading placeholder shown while a lazily-loaded screen chunk is
 * fetched (see AppRoot's next/dynamic imports). It is intentionally tiny — no
 * heavy imports — so it never adds weight to the initial homepage bundle. It
 * fills the viewport with the themed background and a single quiet, animated
 * rabbit-dot pulse (reusing the design's `rabbitDot` keyframe), so a screen
 * transition reads as a brief settle rather than a blank flash.
 */
export function ScreenFallback() {
  return (
    <div
      aria-hidden="true"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: "var(--t4)",
          animation: "rabbitDot 1.1s var(--ease) infinite",
        }}
      />
    </div>
  );
}
