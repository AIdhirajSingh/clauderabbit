"use client";

/**
 * The danger-board live-counts strip — REAL figures from the DB (the
 * `v_board_stats` view via `state.board.stats`). Each figure is a precise,
 * defensible fact about the accumulating reports cache; counters with no honest
 * source (e.g. concurrent VMs running) are simply not shown rather than faked.
 *
 * Honest states:
 *   - while the bundle is loading → a muted "Counting…" placeholder (NOT zeros).
 *   - loaded with data → the real serif figures.
 *   - loaded but the stats query failed (stats === null after load) → omitted.
 * A genuine zero renders as "0" (0 is a real fact), never blanked.
 */

import type { BoardStats } from "@/lib/board-data";

interface BoardStatsStripProps {
  stats: BoardStats | null;
  loading: boolean;
  loaded: boolean;
}

interface StatDef {
  label: string;
  value: number;
  /** A score band color accent for the figure, or a neutral ink tone. */
  color: string;
}

export function BoardStatsStrip({ stats, loading, loaded }: BoardStatsStripProps) {
  // Before any load completes, show a neutral counting state — not zeros, which
  // would misrepresent "we have not looked yet" as "nothing exists".
  if (!loaded && (loading || !stats)) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 10,
          marginBottom: 30,
          fontSize: 12.5,
          color: "var(--t5)",
          letterSpacing: "0.04em",
        }}
      >
        {loading ? "Counting real scans…" : "Counts load when the board opens."}
      </div>
    );
  }

  // Loaded but the stats query did not return — omit the strip rather than fake.
  if (!stats) return null;

  const items: StatDef[] = [
    { label: "Repos with reports", value: stats.distinctRepos, color: "var(--t1)" },
    { label: "Distinct owners", value: stats.distinctOwners, color: "var(--t1)" },
    { label: "Dangerous found", value: stats.dangerousRepos, color: "var(--red)" },
    { label: "Deep sandbox runs", value: stats.deepRepos, color: "var(--blue)" },
    { label: "Report snapshots", value: stats.reportSnapshots, color: "var(--t1)" },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
        gap: 1,
        marginBottom: 34,
        border: "1px solid var(--line)",
        borderRadius: 18,
        overflow: "hidden",
        background: "var(--line)",
      }}
    >
      {items.map((it) => (
        <div
          key={it.label}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            padding: "20px 14px",
            background: "var(--s1)",
            textAlign: "center",
          }}
        >
          <span
            className="serif tnum"
            style={{ fontSize: 34, lineHeight: 1, color: it.color }}
          >
            {it.value.toLocaleString()}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--t4)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {it.label}
          </span>
        </div>
      ))}
    </div>
  );
}
