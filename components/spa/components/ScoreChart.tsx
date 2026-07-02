"use client";

/**
 * Score-distribution chart for the danger board — a dependency-free SVG bar
 * chart of how many scanned repos fall in each score band, latest-per-repo
 * (the `v_score_distribution` view via `state.board.distribution`).
 *
 * Drives entirely off real counts: with no data every bar is zero-height and
 * the chart reads as honestly empty (a flat baseline + a quiet note), never a
 * fabricated shape. Colors follow the one fixed band logic and recolor per
 * theme via the CSS band vars (green = secure … red = dangerous).
 */

import type { ScoreDistribution } from "@/lib/board-data";
import { formatCount } from "@/lib/format";

interface ScoreChartProps {
  distribution: ScoreDistribution;
  loaded: boolean;
}

interface Bar {
  label: string;
  range: string;
  value: number;
  color: string;
}

/** Chart geometry (SVG user units; scales responsively via viewBox). */
const W = 360;
const H = 150;
const PAD_X = 16;
const PAD_TOP = 14;
const BASELINE = H - 30;
const BAR_GAP = 20;

export function ScoreChart({ distribution, loaded }: ScoreChartProps) {
  const bars: Bar[] = [
    { label: "Dangerous", range: "<60", value: distribution.red, color: "var(--red)" },
    { label: "Caution", range: "60–79", value: distribution.amber, color: "var(--amber)" },
    { label: "Likely safe", range: "80–89", value: distribution.blue, color: "var(--blue)" },
    { label: "Secure", range: "90+", value: distribution.green, color: "var(--green)" },
  ];

  const total = bars.reduce((s, b) => s + b.value, 0);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const usableW = W - PAD_X * 2;
  const barW = (usableW - BAR_GAP * (bars.length - 1)) / bars.length;
  const usableH = BASELINE - PAD_TOP;

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 18,
        background: "var(--s1)",
        padding: "20px 22px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
          Score distribution
        </span>
        <span className="tnum" style={{ fontSize: 12, color: "var(--t4)" }}>
          {loaded ? `${formatCount(total)} repos` : "loading…"}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Distribution of scanned repositories across the four score bands"
        style={{ display: "block", height: "auto" }}
      >
        {/* Baseline */}
        <line x1={PAD_X} y1={BASELINE} x2={W - PAD_X} y2={BASELINE} stroke="var(--line2)" strokeWidth={1} />
        {bars.map((b, i) => {
          const x = PAD_X + i * (barW + BAR_GAP);
          const h = total === 0 ? 0 : Math.round((b.value / max) * usableH);
          const y = BASELINE - h;
          return (
            <g key={b.label}>
              {h > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={5}
                  fill={b.color}
                  opacity={0.92}
                />
              )}
              {/* Count above the bar (or at baseline when zero). */}
              <text
                x={x + barW / 2}
                y={(h > 0 ? y : BASELINE) - 6}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                fill={b.value > 0 ? b.color : "var(--t5)"}
                className="tnum"
              >
                {b.value}
              </text>
              {/* Band label + range below the baseline. */}
              <text x={x + barW / 2} y={BASELINE + 14} textAnchor="middle" fontSize={10.5} fill="var(--t3)">
                {b.label}
              </text>
              <text x={x + barW / 2} y={BASELINE + 26} textAnchor="middle" fontSize={9.5} fill="var(--t5)" className="tnum">
                {b.range}
              </text>
            </g>
          );
        })}
      </svg>

      {loaded && total === 0 && (
        <p style={{ margin: "8px 2px 2px", fontSize: 12, color: "var(--t5)", lineHeight: 1.5, textAlign: "center" }}>
          No repositories scored yet. The bars fill as real scans land.
        </p>
      )}
    </div>
  );
}
