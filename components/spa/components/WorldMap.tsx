"use client";

/**
 * The danger-board world map — REAL Natural Earth country boundaries (the
 * world-atlas countries-110m dataset, baked at build time into lib/world-geo-data
 * by scripts/gen-world-map.mjs and projected equirectangular to match
 * lib/world-geo's project()), with one colored dot per scanned repo at its real
 * resolved location. Dots come ONLY from real geo (`state.board.dots`): a repo
 * with no resolvable location places no dot. With nothing placed yet the map
 * renders the real continents alone over an honest note — never fake points.
 *
 * Co-located repos (the "San Francisco problem" — many repos at one city
 * centroid) are fanned out by `clusterOffsets` so each stays individually
 * visible, hoverable and clickable rather than collapsing into one blob; a faint
 * spider-leg ties each fanned dot back to its shared location.
 *
 * Dot color follows the one fixed band logic (red dangerous … green secure) via
 * the CSS band vars, so it recolors per theme. The map is pannable (drag) and
 * zoomable (wheel / buttons) by transforming a <g>; the transform is clamped so
 * the map cannot be lost off-canvas. `prefers-reduced-motion` is respected by
 * using no transitions on the transform (the pan/zoom is direct, not animated).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAP_H, MAP_W, clusterOffsets } from "@/lib/world-geo";
import { WORLD_COUNTRIES, WORLD_GRATICULE } from "@/lib/world-geo-data";
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

/** What the styled hover card shows for the currently-hovered dot. */
interface HoverInfo {
  id: string;
  /** Position relative to the map container, computed once in the event
   * handler (never read from a ref during render). */
  left: number;
  top: number;
  owner: string;
  name: string;
  place: string;
  host: string | null;
  source: BoardDot["source"];
  clusterSize: number;
  isNew: boolean;
}

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
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  // The "newly added" pulse anchor: a stable timestamp captured ONCE at mount
  // (React-pure — Date.now() in render is impure). Repos scanned within ~10 min of
  // opening the board pulse, then settle.
  const [now] = useState(() => Date.now());
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Escape closes full-screen mode; only listens while it's actually open.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

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
      // Pointer capture routes all subsequent pointer events to the SVG
      // regardless of which dot the cursor is physically over, so a stale
      // hover card would otherwise stick or fail to update mid-drag. Clear it.
      setHover(null);
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

  const clearHover = useCallback(() => setHover(null), []);

  // The real-geography layer never changes — memoize it so a pan/zoom (which only
  // changes the parent <g> transform) doesn't re-diff 177 country paths.
  const mapLayer = useMemo(
    () => (
      <>
        <path d={WORLD_GRATICULE} fill="none" stroke="var(--line)" strokeWidth={0.12} opacity={0.45} />
        {WORLD_COUNTRIES.map((c, i) => (
          <path
            key={i}
            d={c.d}
            fill="var(--s3)"
            stroke="var(--line2)"
            strokeWidth={0.22}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </>
    ),
    [],
  );

  // Fan co-located dots so the same city never collapses into one blob. The
  // offsets are in scale-1 map units; the renderer divides by view.scale so the
  // fan stays a constant on-screen size at any zoom.
  const slots = useMemo(() => clusterOffsets(dots.map((d) => d.point)), [dots]);

  return (
    <div
      style={
        fullscreen
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 85,
              border: "none",
              borderRadius: 0,
              background: "var(--bg)",
              padding: "20px 22px 16px",
              display: "flex",
              flexDirection: "column",
              animation: "drawerIn .4s var(--drawer) both",
            }
          : {
              border: "1px solid var(--line)",
              borderRadius: 18,
              background: "var(--s1)",
              padding: "20px 22px 16px",
              position: "relative",
            }
      }
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: "var(--t4)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
          Where caught code phones home
        </span>
        <span className="tnum" style={{ fontSize: 12, color: "var(--t4)" }}>
          {loaded ? `${dots.length.toLocaleString()} destination${dots.length === 1 ? "" : "s"}` : "loading…"}
        </span>
      </div>

      <div
        ref={containerRef}
        style={{ position: "relative", flex: fullscreen ? 1 : undefined, minHeight: fullscreen ? 0 : undefined }}
      >
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
            height: fullscreen ? "100%" : "auto",
            width: fullscreen ? "100%" : "100%",
            cursor: dragging ? "grabbing" : "grab",
            touchAction: "none",
            background: "var(--s2)",
            borderRadius: 12,
          }}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            {mapLayer}
            {/* Spider-legs (under the dots): tie each fanned dot back to its shared
                location so a cluster reads as "several repos, one place". */}
            {dots.map((d, i) => {
              const s = slots[i];
              if (!s || s.clusterSize <= 1) return null;
              return (
                <line
                  key={`leg-${d.id}`}
                  x1={d.point.x}
                  y1={d.point.y}
                  x2={d.point.x + s.dx / view.scale}
                  y2={d.point.y + s.dy / view.scale}
                  stroke="var(--line2)"
                  strokeWidth={0.4 / view.scale}
                  opacity={0.55}
                />
              );
            })}
            {dots.map((d, i) => {
              const s = slots[i];
              const ox = s ? s.dx / view.scale : 0;
              const oy = s ? s.dy / view.scale : 0;
              const color = BAND_COLOR[d.band];
              // A dot is "newly added" for ~10 minutes after its repo was first
              // scanned; it pulses, then settles. `now` is the stable mount anchor.
              const isNew = d.createdAt != null && now - Date.parse(d.createdAt) < 600_000;
              const clusterSize = s ? s.clusterSize : 1;
              const showHoverCard = (e: { clientX: number; clientY: number }) => {
                // While dragging, pointer capture routes events to the SVG
                // regardless of the physical cursor target — never show the
                // card mid-pan, it would appear to stick to the wrong dot.
                if (dragRef.current) return;
                // Convert to container-relative coordinates now, in the event
                // handler — never read the ref during render.
                const rect = containerRef.current?.getBoundingClientRect();
                const left = rect ? e.clientX - rect.left : e.clientX;
                const top = rect ? e.clientY - rect.top : e.clientY;
                setHover({
                  id: d.id,
                  left,
                  top,
                  owner: d.owner,
                  name: d.name,
                  place: d.place,
                  host: d.host,
                  source: d.source,
                  clusterSize,
                  isNew,
                });
              };
              return (
                // Clickable: opens the repo's public report in a NEW TAB. An SVG
                // <a> navigates on a click; a map drag does not trigger it.
                <a
                  key={d.id}
                  href={`/${d.owner}/${d.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ cursor: "pointer" }}
                  onPointerEnter={showHoverCard}
                  onPointerMove={showHoverCard}
                  onPointerLeave={clearHover}
                  onFocus={(e) => {
                    // Keyboard focus: position the card at the dot's own
                    // on-screen location rather than a cursor position.
                    const rect = e.currentTarget.getBoundingClientRect();
                    showHoverCard({ clientX: rect.left + rect.width / 2, clientY: rect.top });
                  }}
                  onBlur={clearHover}
                >
                  <g transform={`translate(${d.point.x + ox} ${d.point.y + oy})`}>
                    <circle r={3.4 / view.scale} fill={color} opacity={0.18} />
                    {isNew && (
                      <circle
                        r={1.7 / view.scale}
                        fill={color}
                        opacity={0.55}
                        style={{ animation: "pulseRing 2s ease-out infinite" }}
                      />
                    )}
                    {/* a thin ring in the panel color keeps overlapping dots separable */}
                    <circle r={1.7 / view.scale} fill={color} stroke="var(--s1)" strokeWidth={0.5 / view.scale} />
                  </g>
                </a>
              );
            })}
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

        {/* Full-screen toggle — top-right, out of the way of the zoom cluster. */}
        <div style={{ position: "absolute", right: 10, top: 10 }}>
          <MapButton
            label={fullscreen ? "Exit full screen" : "Expand to full screen"}
            onClick={() => setFullscreen((f) => !f)}
          >
            {fullscreen ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </MapButton>
        </div>

        {/* Styled hover card — replaces the native SVG <title> tooltip. Kept
            outside the SVG so it composes in both normal and full-screen mode;
            pointerEvents:none so it never intercepts the click-through to a dot. */}
        {hover && (
          <div
            role="tooltip"
            style={{
              position: "absolute",
              left: hover.left,
              top: hover.top,
              transform: "translate(-50%, -100%) translateY(-12px)",
              pointerEvents: "none",
              zIndex: 5,
              minWidth: 180,
              maxWidth: 260,
              background: "var(--glass)",
              backdropFilter: "blur(18px)",
              border: "1px solid var(--line2)",
              borderRadius: 11,
              boxShadow: "var(--shadow)",
              padding: "10px 12px",
              fontSize: 12.5,
              color: "var(--t2)",
              lineHeight: 1.45,
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--t1)", fontSize: 13, marginBottom: 2 }}>
              {hover.owner}/{hover.name}
            </div>
            {hover.source === "egress" ? (
              <div>
                caught calling {hover.host ?? "a destination"} in {hover.place}
              </div>
            ) : (
              hover.place && <div>{hover.place}</div>
            )}
            {hover.clusterSize > 1 && (
              <div style={{ color: "var(--t4)", marginTop: 2 }}>{hover.clusterSize} repos at this location</div>
            )}
            {hover.isNew && <div style={{ color: "var(--t4)", marginTop: 2 }}>just added</div>}
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
