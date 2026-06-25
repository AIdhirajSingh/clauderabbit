"use client";

/**
 * Centered bottom glass toast with a glowing status dot. Faithful port of
 * `design-source/Claude Rabbit.dc.html` lines ~974–979. The color of the dot is
 * score-colored when reporting a verdict; auto-dismiss is owned by the brain.
 */

import { useApp } from "../state";

export function Toast() {
  const { state } = useApp();
  if (!state.toast) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 30,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        gap: 13,
        background: "var(--glass)",
        backdropFilter: "blur(24px) saturate(1.5)",
        border: "1px solid var(--line2)",
        padding: "13px 19px",
        borderRadius: 14,
        boxShadow: "var(--shadow)",
        animation: "riseIn .34s var(--ease) both",
        maxWidth: "90vw",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: state.toastColor,
          boxShadow: `0 0 9px ${state.toastColor}`,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 13.5, color: "var(--t2)" }}>{state.toast}</span>
    </div>
  );
}
