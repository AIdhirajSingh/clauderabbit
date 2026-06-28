"use client";

/**
 * The danger-board world map — a dependency-free equirectangular SVG with one
 * colored dot per caught repo's captured destination country. Dots come ONLY
 * from real forensic geolocations (`state.board.dots`, derived from the
 * `v_board_dots` view); a repo with no resolved country places no dot. With
 * nothing caught yet the map renders the outline alone over an honest note —
 * never scattered with fake points.
 *
 * Dot color follows the one fixed band logic (red dangerous … green secure) via
 * the CSS band vars, so it recolors per theme. The map is pannable (drag) and
 * zoomable (wheel / buttons) by transforming a <g>; the transform is clamped so
 * the map cannot be lost off-canvas. `prefers-reduced-motion` is respected by
 * using no transitions on the transform (the pan/zoom is direct, not animated).
 */

import { useCallback, useRef, useState } from "react";
import { MAP_H, MAP_W, WORLD_OUTLINE_PATH } from "@/lib/world-geo";
import type { BoardDot } from "@/lib/board-data";

interface WorldMapProps {
  dots: BoardDot[];
  loaded: boolean;
}

/** Band → CSS color var (the fixed score-color logic; yellow maps to --amber). */
const BAND_COLOR: Record<BoardDot["band"], string> = {
  red: "var(--red)",
  yellow: "var(--amber)",
  blue: "var(--blue)",
  green: "var(--green)",
};

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.5;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const INITIAL_VIEW: View = { scale: 1, tx: 0, ty: 0 };

/** Clamp the pan so at least the map stays within the viewBox at any scale. */
function clampView(v: View): View {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale));
  // At scale s the content spans MAP_W*s; the max pan keeps it covering [0,MAP_W].
  const maxTx = MAP_W * (scale - 1);
  const maxTy = MAP_H * (scale - 1);
  return {
    scale,
    tx: Math.max(-maxTx, Math.min(0, v.tx)),
    ty: Math.max(-maxTy, Math.min(0, v.ty)),
  };
}

export function WorldMap({ dots, loaded }: WorldMapProps) {
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const zoomBy = useCallback((factor: number) => {
    setView((v) => {
      const scale = v.scale * factor;
      // Zoom around the map center so the focus stays put.
      const cx = MAP_W / 2;
      const cy = MAP_H / 2;
      const k = scale / v.scale;
      return clampView({
        scale,
        tx: cx - (cx - v.tx) * k,
        ty: cy - (cy - v.ty) * k,
      });
    });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    },
    [zoomBy],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      setDragging(true);
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [view.tx, view.ty],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const svg = svgRef.current;
    if (!svg) return;
    // Convert client-pixel delta to viewBox units so the drag tracks the cursor.
    const rect = svg.getBoundingClientRect();
    const sx = rect.width > 0 ? MAP_W / rect.width : 1;
    const sy = rect.height > 0 ? MAP_H / rect.height : 1;
    setView((v) =>
      clampView({
        scale: v.scale,
        tx: d.tx + (e.clientX - d.x) * sx,
        ty: d.ty + (e.clientY - d.y) * sy,
      }),
    );
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    setDragging(false);
    svgRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  const resetView = useCallback(() => setView(INITIAL_VIEW), []);
  const hasDots = dots.length > 0;

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 18,
        background: "var(--s1)",
        padding: "20px 22px 16px",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
          Where caught code phones home
        </span>
        <span className="tnum" style={{ fontSize: 12, color: "var(--t4)" }}>
          {loaded ? `${dots.length.toLocaleString()} destination${dots.length === 1 ? "" : "s"}` : "loading…"}
        </span>
      </div>

      <div style={{ position: "relative" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${MAP_W} ${MAP_H}`}
          width="100%"
          role="img"
          aria-label="World map of captured command-and-control destinations for caught repositories"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          style={{
            display: "block",
            height: "auto",
            cursor: dragging ? "grabbing" : "grab",
            touchAction: "none",
            background: "var(--s2)",
            borderRadius: 12,
          }}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            <path d={WORLD_OUTLINE_PATH} fill="var(--s3)" stroke="var(--line2)" strokeWidth={0.4} />
            {(() => {
              // A dot is "newly added" for ~10 minutes after its repo was first
              // scanned; it pulses, then settles. Computed once per render.
              const now = Date.now();
              return dots.map((d) => {
                const color = BAND_COLOR[d.band];
                const isNew = d.createdAt != null && now - Date.parse(d.createdAt) < 600_000;
                // Hover: repo name + where. Egress dots say what it was caught
                // calling; origin dots just name the owner's location.
                const title =
                  d.source === "egress"
                    ? `${d.owner}/${d.name} — caught calling ${d.host ?? "a destination"} in ${d.place}`
                    : `${d.owner}/${d.name}${d.place ? ` — ${d.place}` : ""}`;
                return (
                  // Clickable: opens the repo's public report in a NEW TAB. An SVG
                  // <a> navigates on a click; a map drag does not trigger it.
                  <a key={d.id} href={`/${d.owner}/${d.name}`} target="_blank" rel="noopener noreferrer" style={{ cursor: "pointer" }}>
                    <g transform={`translate(${d.point.x} ${d.point.y})`}>
                      <circle r={3.4 / view.scale} fill={color} opacity={0.18} />
                      {isNew && (
                        <circle
                          r={1.7 / view.scale}
                          fill={color}
                          opacity={0.55}
                          style={{ animation: "pulseRing 2s ease-out infinite" }}
                        />
                      )}
                      <circle r={1.7 / view.scale} fill={color}>
                        <title>
                          {title}
                          {isNew ? " · just added" : ""}
                        </title>
                      </circle>
                    </g>
                  </a>
                );
              });
            })()}
          </g>
        </svg>

        {/* Honest empty overlay: only when the fetch is done and there is no geo. */}
        {loaded && !hasDots && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              padding: 24,
            }}
          >
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--t4)", textAlign: "center", lineHeight: 1.5, maxWidth: 340 }}>
              No repos with a resolvable location yet. Every scanned repo gets a dot at
              its owner&apos;s location, or where its code was caught calling out. Hover a
              dot for the repo, click to open its report.
            </p>
          </div>
        )}

        {/* Zoom controls — only meaningful when there is something to inspect. */}
        {hasDots && (
          <div style={{ position: "absolute", right: 10, bottom: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <MapButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>+</MapButton>
            <MapButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</MapButton>
            <MapButton label="Reset view" onClick={resetView}>⤢</MapButton>
          </div>
        )}
      </div>
    </div>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        border: "1px solid var(--line2)",
        background: "var(--glass)",
        color: "var(--t2)",
        fontSize: 15,
        lineHeight: 1,
        cursor: "pointer",
        backdropFilter: "blur(8px)",
      }}
    >
      {children}
    </button>
  );
}
