"use client";

/**
 * "This is a very large repo. Keep installing to scan it fully?" Shown while
 * `show` holds: the caller passes true only while a live scan's install waits at
 * its time limit, and false once the run moves on or ends. No, or no answer in
 * ANSWER_MS, leaves the scan to finish as the partial scan it is. Yes is a normal same-site link to a different path,
 * /app/scan/<id>/full: that navigation is what GPT's web interstitial (defined on
 * this page before the click) shows on, and the full page then plays back the
 * stored full scan or runs one.
 */

import { useEffect, useRef, useState } from "react";

export const ANSWER_MS = 15_000;

export function ContinueCard({ runId, show }: { runId: string; show: boolean }) {
  const [answeredNo, setAnsweredNo] = useState(false);
  const asking = show && !answeredNo;
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAnsweredNo(true), ANSWER_MS);
    return () => clearTimeout(t);
  }, [asking]);
  // No, or no answer in ANSWER_MS, tells a running install to stop now rather than
  // wait out the answer's delivery window.
  const told = useRef(false);
  useEffect(() => {
    if (!answeredNo || told.current) return;
    told.current = true;
    void fetch(`/api/scan/${runId}/continue?answer=no`, { method: "POST", headers: { "x-clauderabbit-client": "web" }, keepalive: true }).catch(() => {});
  }, [answeredNo, runId]);
  if (!asking) return null;
  return (
    <div role="dialog" aria-label="Keep installing" className="card in" style={{ marginTop: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
      <span style={{ fontSize: 15, lineHeight: 1.5, color: "#F0F0F0" }}>This is a very large repo. Keep installing to scan it fully?</span>
      <div style={{ display: "flex", gap: 10 }}>
        <a href={`/app/scan/${runId}/full`} className="btn btn-p btn-sm">
          Yes
        </a>
        <button type="button" onClick={() => setAnsweredNo(true)} className="btn btn-s btn-sm">
          No
        </button>
      </div>
    </div>
  );
}
