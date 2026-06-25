"use client";

/**
 * Shared chrome behind every screen: the fixed film-grain overlay and the
 * site-wide, low-opacity 3D card marquee. Faithful port of
 * `design-source/Claude Rabbit.dc.html` lines ~108–124. Three columns of `Snap`
 * cards drift up/down/up; the whole plane is tilted in 3D.
 */

import { BG_COL_A_DBL, BG_COL_B_DBL, BG_COL_C_DBL, useApp } from "../state";
import { Snap, type SnapProps } from "./Snap";

const GRAIN_DATA_URL =
  "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22220%22%3E%3Cfilter id=%22n%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.82%22 numOctaves=%222%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22 opacity=%220.6%22/%3E%3C/svg%3E')";

const COLUMNS: Array<{ cards: SnapProps[]; anim: string }> = [
  { cards: BG_COL_A_DBL, anim: "marqueeUp 56s linear infinite" },
  { cards: BG_COL_B_DBL, anim: "marqueeDown 64s linear infinite" },
  { cards: BG_COL_C_DBL, anim: "marqueeUp 72s linear infinite" },
];

export function Background() {
  const { bgOpacity } = useApp();
  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          pointerEvents: "none",
          opacity: "var(--grain-op)",
          mixBlendMode: "overlay",
          backgroundImage: GRAIN_DATA_URL,
        }}
      />
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
          overflow: "hidden",
          opacity: bgOpacity,
          perspective: "2000px",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "-8%",
            left: "50%",
            width: 1500,
            height: "120%",
            transform: "translateX(-50%) rotateY(-20deg) rotateX(10deg) rotateZ(3deg)",
            transformStyle: "preserve-3d",
            display: "flex",
            gap: 26,
            justifyContent: "center",
          }}
        >
          {COLUMNS.map((col, ci) => (
            <div
              key={ci}
              style={{
                flex: 1,
                maxWidth: 300,
                display: "flex",
                flexDirection: "column",
                gap: 26,
                animation: col.anim,
              }}
            >
              {col.cards.map((c, i) => (
                <div key={i} style={{ flexShrink: 0 }}>
                  <Snap
                    kind={c.kind}
                    title={c.title}
                    sub={c.sub}
                    score={c.score}
                    color={c.color}
                    lang={c.lang}
                    langColor={c.langColor}
                    stars={c.stars}
                    accent={c.accent}
                    lines={c.lines}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
