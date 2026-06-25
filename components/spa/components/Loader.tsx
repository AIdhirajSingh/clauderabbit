/**
 * Loader — the one global loader: a 3×3 grid of rounded squares running the
 * `rabbitDot` keyframe with diagonal-distance staggered delays. Faithful port
 * of the inline grids in `design-source/Claude Rabbit.dc.html` (the ad loader,
 * 5px dots, and the processing header loader, 7px dots).
 *
 * The nine delays form the diagonal wave: 0/90/180 · 90/180/270 · 180/270/360.
 */

/** Per-cell animation delay in ms, by diagonal distance from the top-left cell. */
const DELAYS = [0, 90, 180, 90, 180, 270, 180, 270, 360];

export interface LoaderProps {
  /** Dot edge length in px. */
  size?: number;
  /** Gap between dots in px. */
  gap?: number;
  /** Corner radius in px. */
  radius?: number;
}

export function Loader({ size = 7, gap = 5, radius = 2 }: LoaderProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(3, ${size}px)`,
        gridTemplateRows: `repeat(3, ${size}px)`,
        gap,
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {DELAYS.map((delay, i) => (
        <span
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: radius,
            background: "var(--t1)",
            animation: "rabbitDot 1.5s ease-in-out infinite",
            animationDelay: `${delay}ms`,
          }}
        />
      ))}
    </div>
  );
}
