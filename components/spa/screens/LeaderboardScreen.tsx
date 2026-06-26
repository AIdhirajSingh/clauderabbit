"use client";

/**
 * Danger board — faithful port of `design-source/Claude Rabbit.dc.html`
 * lines ~768–835: a worst-offender hero card (giant ghost "1", 92px serif
 * score), the ranked table below, and the four-band legend. Score coloring is
 * the one shared band logic.
 */

import { useEffect, useRef } from "react";
import { onActivate, useApp } from "../state";
import { buildForensicsView } from "@/lib/report-view";
import type { Forensics } from "@/lib/types";
import styles from "../spa.module.css";
import { Chevron } from "../components/glyphs";
import { BoardStatsStrip } from "../components/BoardStats";
import { ScoreChart } from "../components/ScoreChart";
import { WorldMap } from "../components/WorldMap";

/**
 * Concise board marker for a caught repo, derived from its forensic record:
 * the C2 host (and geo) the sandbox caught it calling, or a credential-theft
 * note. Returns null when there is no forensic record (demo rows) — the board
 * then shows only its existing reason, faithful to the original design.
 */
function boardMarker(forensics: Forensics | undefined): string | null {
  return buildForensicsView(forensics)?._boardMarker ?? null;
}

export function LeaderboardScreen() {
  const app = useApp();
  const hero = app.leaderHero;

  // Ensure the real board data is loaded whenever this screen mounts — covers a
  // tab-restore / rehydration where the screen reappears without going through
  // `openLeaderboard`. Idempotent: a no-op when already loaded or loading.
  const { ensureBoardLoaded } = app;
  useEffect(() => {
    ensureBoardLoaded();
  }, [ensureBoardLoaded]);

  return (
    <div style={{ minHeight: "100vh", position: "relative", animation: "screenIn .5s var(--ease) both" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          height: 560,
          pointerEvents: "none",
          background: "radial-gradient(700px 360px at 50% -6%, oklch(0.645 0.205 23 / 0.1), transparent 64%)",
        }}
      />

      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "15px 24px",
          backdropFilter: "blur(18px) saturate(1.4)",
          background: "var(--glass)",
          borderBottom: "1px solid var(--line)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
        }}
      >
        <button
          onClick={app.backFromLeaderboard}
          className={styles.lbBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--s1)",
            border: "1px solid var(--line2)",
            color: "var(--t2)",
            fontSize: 13,
            padding: "9px 14px",
            borderRadius: 11,
            cursor: "pointer",
            transition: "border-color .16s var(--ease), background .16s, transform .14s",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
        <span style={{ fontSize: 14, fontWeight: 500, color: "var(--t1)" }}>The danger board</span>
      </div>

      <div style={{ position: "relative", maxWidth: 920, margin: "0 auto", padding: "56px 24px 110px" }}>
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <span style={{ position: "relative", width: 8, height: 8 }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--red)" }} />
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--red)", animation: "pulseRing 2s ease-out infinite" }} />
            </span>
            <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
              Most dangerous repositories caught
            </span>
          </div>
          <h1 className="serif" style={{ fontSize: "clamp(40px,6vw,64px)", margin: "0 0 16px", color: "var(--t1)", lineHeight: 1, letterSpacing: "-0.018em" }}>
            The danger board
          </h1>
          <p style={{ fontSize: 15.5, color: "var(--t3)", lineHeight: 1.6, margin: "0 auto", maxWidth: 540 }}>
            The lowest-scoring repositories our sandbox has run and caught, re-checked as they change. Malware, named and
            ranked, so you can see exactly what we run into.
          </p>
        </div>

        <BoardStatsStrip stats={app.boardStats} loading={app.boardLoading} loaded={app.boardLoaded} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 16,
            marginBottom: 34,
          }}
        >
          <ScoreChart distribution={app.boardDistribution} loaded={app.boardLoaded} />
          <WorldMap dots={app.boardDots} loaded={app.boardLoaded} />
        </div>

        {hero && (
          <div
            {...onActivate(hero.onOpen)}
            className={styles.lbHero}
            style={{
              position: "relative",
              border: `1px solid ${hero._color}`,
              borderRadius: 24,
              padding: 34,
              marginBottom: 24,
              background: hero._tint,
              overflow: "hidden",
              cursor: "pointer",
              transition: "transform .2s var(--ease), box-shadow .2s",
            }}
          >
            <div style={{ position: "absolute", top: -20, right: 6, pointerEvents: "none" }}>
              <span className="serif" style={{ fontSize: 200, color: hero._color, opacity: 0.1, lineHeight: 1 }}>
                1
              </span>
            </div>
            <div style={{ position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 11, color: hero._color, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 500 }}>
                  Worst on record
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
                <span className="serif tnum" style={{ fontSize: 92, color: hero._color, lineHeight: 0.82, textShadow: `0 0 40px ${hero._glow}` }}>
                  {hero.score}
                </span>
                <div style={{ flex: 1, minWidth: 240, paddingBottom: 8 }}>
                  <div className="serif" style={{ fontSize: 30, color: "var(--t1)", lineHeight: 1.05, marginBottom: 8 }}>
                    {hero.owner}/{hero.name}
                  </div>
                  <div style={{ fontSize: 14.5, color: "var(--t3)", lineHeight: 1.5 }}>{hero.reason}</div>
                  {(() => {
                    const marker = boardMarker(hero.forensics);
                    return marker ? <SandboxCatch color={hero._color} marker={marker} /> : null;
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}

        {!hero && app.leaderRest.length === 0 && (
          <div
            style={{
              border: "1px solid var(--line)",
              borderRadius: 20,
              background: "var(--s1)",
              boxShadow: "var(--shadow-lg)",
              padding: "56px 32px",
              textAlign: "center",
            }}
          >
            {app.boardLoading ? (
              <>
                <div className="serif" style={{ fontSize: 22, color: "var(--t2)", marginBottom: 10 }}>
                  Loading the board…
                </div>
                <p style={{ fontSize: 14, color: "var(--t4)", lineHeight: 1.6, margin: "0 auto", maxWidth: 460 }}>
                  Reading the latest caught repositories from the live database.
                </p>
              </>
            ) : !app.boardLoaded ? (
              <>
                <div className="serif" style={{ fontSize: 22, color: "var(--t2)", marginBottom: 10 }}>
                  Board unavailable.
                </div>
                <p style={{ fontSize: 14, color: "var(--t4)", lineHeight: 1.6, margin: "0 auto", maxWidth: 460 }}>
                  We could not reach the database to load the board right now. This is a
                  connection problem, not an all-clear — please try again shortly.
                </p>
              </>
            ) : (
              <>
                <div className="serif" style={{ fontSize: 22, color: "var(--t2)", marginBottom: 10 }}>
                  Nothing caught yet.
                </div>
                <p style={{ fontSize: 14, color: "var(--t4)", lineHeight: 1.6, margin: "0 auto", maxWidth: 460 }}>
                  The board only lists repositories the sandbox has actually run and caught scoring low. As
                  real low-scoring scans land, the worst offenders show up here, named and ranked.
                </p>
              </>
            )}
          </div>
        )}

        {app.leaderRest.length > 0 && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 20, overflow: "hidden", background: "var(--s1)", boxShadow: "var(--shadow-lg)" }}>
          {app.leaderRest.map((r) => {
            const marker = boardMarker(r.forensics);
            return (
            <div
              key={r.rank}
              {...onActivate(r.onOpen)}
              className={styles.lbRow}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                padding: "20px 26px",
                borderBottom: "1px solid var(--line)",
                cursor: "pointer",
                transition: "background .16s var(--ease), padding-left .16s",
              }}
            >
              <span className="serif tnum" style={{ fontSize: 26, color: "var(--t5)", width: 32, textAlign: "center" }}>
                {r.rank}
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 60,
                  height: 46,
                  borderRadius: 12,
                  background: r._tint,
                  border: `1px solid ${r._color}`,
                  flexShrink: 0,
                }}
              >
                <span className="serif tnum" style={{ fontSize: 25, color: r._color, lineHeight: 1 }}>
                  {r.score}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15.5, color: "var(--t1)", marginBottom: 4, fontWeight: 450 }}>
                  {r.owner}/{r.name}
                </div>
                <div style={{ fontSize: 13, color: "var(--t4)", lineHeight: 1.45 }}>{r.reason}</div>
                {marker && <SandboxCatch color={r._color} marker={marker} />}
              </div>
              <span style={{ fontSize: 11, color: r._color, padding: "4px 10px", border: `1px solid ${r._color}`, borderRadius: 100, whiteSpace: "nowrap", flexShrink: 0 }}>
                {r._band}
              </span>
              <span style={{ flexShrink: 0, color: "var(--t5)" }}>
                <Chevron size={16} />
              </span>
            </div>
            );
          })}
        </div>
        )}

        {app.leaderRest.length > 0 && (
          <BoardLoadMore
            hasMore={app.boardHasMore}
            loading={app.boardMoreLoading}
            onLoadMore={app.loadMoreBoard}
          />
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 22, marginTop: 32, flexWrap: "wrap" }}>
          <LegendDot color="var(--green)" label="90+ secure" />
          <LegendDot color="var(--blue)" label="80–89 likely safe" />
          <LegendDot color="var(--amber)" label="60–79 caution" />
          <LegendDot color="var(--red)" label="under 60 dangerous" />
        </div>
      </div>
    </div>
  );
}

/**
 * Infinite-scroll driver for the ranked list. An IntersectionObserver watches a
 * sentinel just past the last row and fires `onLoadMore` when it scrolls into
 * view, so paging is automatic; a visible button is the accessible / IO-less
 * fallback and a manual control. When there are no more pages it shows a quiet
 * end-of-list line. All rows come from the real DB — paging never fabricates.
 */
function BoardLoadMore({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first && first.isIntersecting) onLoadMore();
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore]);

  if (!hasMore) {
    return (
      <div style={{ textAlign: "center", marginTop: 22, fontSize: 12.5, color: "var(--t5)" }}>
        End of the board — every caught repository on record is shown.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, marginTop: 22 }}>
      <div ref={sentinelRef} aria-hidden="true" style={{ height: 1, width: "100%" }} />
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loading}
        className={styles.lbBack}
        style={{
          background: "var(--s1)",
          border: "1px solid var(--line2)",
          color: "var(--t2)",
          fontSize: 13,
          padding: "10px 18px",
          borderRadius: 11,
          cursor: loading ? "default" : "pointer",
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

/**
 * The concise sandbox-catch marker shown beneath a row's reason when a forensic
 * record exists: a small "Sandbox" eyebrow tag plus the C2 host (and geo) the
 * run was caught calling. Score-colored per the one band logic.
 */
function SandboxCatch({ color, marker }: { color: string; marker: string }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 7, flexWrap: "wrap" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color,
          padding: "3px 9px",
          border: `1px solid ${color}`,
          borderRadius: 100,
          letterSpacing: "0.04em",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />
        Sandbox
      </span>
      <span className="tnum" style={{ fontSize: 12.5, color: "var(--t3)", wordBreak: "break-word" }}>
        {marker}
      </span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
      <span style={{ fontSize: 12, color: "var(--t4)" }}>{label}</span>
    </div>
  );
}
