import type { CSSProperties } from "react";
import { Mark } from "./Logo";
import s from "./orbit.module.css";

/**
 * The rotating orbit from the Claude Design export (p3/Gate.dc.html hero and
 * p3/Login.dc.html left side): the ClaudeRabbit mark at the centre, five
 * counter-rotating tiles (GitHub, npm, the web, servers, keys) on a 90 s ring,
 * three drifting colour blobs behind, and flow pulses running from each tile
 * into the centre. Pure CSS motion; all of it stops under reduced motion.
 */

export const GITHUB_PATH =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

const NPM_PATH =
  "M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z";

/** Spoke from each tile toward the centre, in the 0–100 ring viewBox. */
const SPOKES: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [
  { x1: 50, y1: 21.2, x2: 50, y2: 37.4, color: "#121212" },
  { x1: 77.4, y1: 41.1, x2: 62, y2: 46.1, color: "#CB3837" },
  { x1: 66.9, y1: 73.3, x2: 57.4, y2: 60.2, color: "#1B77F3" },
  { x1: 33.1, y1: 73.3, x2: 42.6, y2: 60.2, color: "#00BF63" },
  { x1: 22.6, y1: 41.1, x2: 38, y2: 46.1, color: "#FF4829" },
];

/** Two pulses per spoke; the second set is offset by 1300 ms, as drawn. */
const PULSES = [0, 1300].flatMap((base) =>
  SPOKES.map((sp, i) => ({ ...sp, delay: base + i * 520 })),
);

const TILE_POS: CSSProperties[] = [
  { left: "50%", top: "14%" },
  { left: "84.2%", top: "38.9%" },
  { left: "71.2%", top: "79.1%" },
  { left: "28.8%", top: "79.1%" },
  { left: "15.8%", top: "38.9%" },
];

function TileIcon({ index }: { index: number }) {
  switch (index) {
    case 0:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#121212" d={GITHUB_PATH} />
        </svg>
      );
    case 1:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#CB3837" d={NPM_PATH} />
        </svg>
      );
    case 2:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <g fill="none" stroke="#1B77F3" strokeWidth="1.6">
            <circle cx="12" cy="12" r="8" />
            <ellipse cx="12" cy="12" rx="3.4" ry="8" />
            <line x1="4" y1="12" x2="20" y2="12" />
          </g>
        </svg>
      );
    case 3:
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#00BF63"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="4.5" width="16" height="6" rx="2" />
          <rect x="4" y="13.5" width="16" height="6" rx="2" />
          <circle cx="7.5" cy="7.5" r=".6" fill="#00BF63" />
          <circle cx="7.5" cy="16.5" r=".6" fill="#00BF63" />
        </svg>
      );
    default:
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#FF4829"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="5" y="10.5" width="14" height="9.5" rx="3" />
          <path d="M8.25 10.5V8a3.75 3.75 0 017.5 0v2.5" />
          <circle cx="12" cy="15.2" r="1.3" fill="#FF4829" stroke="none" />
        </svg>
      );
  }
}

export function Orbit({ className }: { className?: string }) {
  return (
    <div
      className={className ? `${s.orbit} ${className}` : s.orbit}
      role="img"
      aria-label="ClaudeRabbit at the centre of a ring: npm, GitHub, the web, servers and keys, each checked before you run it"
    >
      <div className={`${s.blob} ${s.blobA}`} />
      <div className={`${s.blob} ${s.blobB}`} />
      <div className={`${s.blob} ${s.blobC}`} />
      <div className={s.ring} aria-hidden="true">
        <svg viewBox="0 0 100 100" className={s.lines}>
          <g stroke="rgba(18,18,18,0.16)" strokeWidth="0.35" strokeLinecap="round">
            {SPOKES.map((sp) => (
              <line key={`${sp.x1}-${sp.y1}`} x1={sp.x1} y1={sp.y1} x2={sp.x2} y2={sp.y2} />
            ))}
          </g>
          <g strokeWidth="0.9" strokeLinecap="round" fill="none">
            {PULSES.map((p) => (
              <line
                key={p.delay}
                className={s.flow}
                x1={p.x1}
                y1={p.y1}
                x2={p.x2}
                y2={p.y2}
                stroke={p.color}
                style={{ animationDelay: `${p.delay}ms` }}
              />
            ))}
          </g>
        </svg>
        {TILE_POS.map((pos, i) => (
          <div key={i} className={s.slot} style={pos}>
            <div className={s.tile}>
              <TileIcon index={i} />
            </div>
          </div>
        ))}
      </div>
      <div className={s.center}>
        <Mark className={s.centerMark} />
      </div>
    </div>
  );
}
