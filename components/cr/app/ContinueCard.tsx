"use client";

/**
 * "This is a very large repo. Keep installing to scan it fully?" Shown when a
 * scan's install hits its time limit (a fresh scan, a stored one or a replay
 * alike). No, or no answer in ANSWER_MS, leaves the scan to finish as the
 * partial scan it is. Yes is a normal same-site link to a different path,
 * /app/scan/<id>/full: that navigation is what GPT's web interstitial (defined on
 * this page before the click) shows on, and the full page then plays back the
 * stored full scan or runs one.
 */

import { useEffect, useState } from "react";

export const ANSWER_MS = 15_000;

export function ContinueCard({ runId, show }: { runId: string; show: boolean }) {
  const [state, setState] = useState<"waiting" | "asking" | "no">("waiting");
  useEffect(() => {
    if (!show || state !== "waiting") return;
    setState("asking");
  }, [show, state]);
  useEffect(() => {
    if (state !== "asking") return;
    const t = setTimeout(() => setState("no"), ANSWER_MS);
    return () => clearTimeout(t);
  }, [state]);
  if (state !== "asking") return null;
  return (
    <div role="dialog" aria-label="Keep installing" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "20px 22px", borderRadius: 22, border: "1px solid var(--border)", background: "var(--surface, var(--bg))" }}>
      <span style={{ fontSize: 16, lineHeight: 1.45, color: "var(--text)" }}>This is a very large repo. Keep installing to scan it fully?</span>
      <div style={{ display: "flex", gap: 10 }}>
        <a href={`/app/scan/${runId}/full`} style={{ padding: "10px 22px", borderRadius: 999, background: "var(--text)", color: "var(--bg)", fontWeight: 600, fontSize: 15 }}>
          Yes
        </a>
        <button type="button" onClick={() => setState("no")} style={{ padding: "10px 22px", borderRadius: 999, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontWeight: 600, fontSize: 15, cursor: "pointer" }}>
          No
        </button>
      </div>
    </div>
  );
}
