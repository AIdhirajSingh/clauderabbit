import { useId, type CSSProperties } from "react";

/**
 * The ClaudeRabbit mark: a dark ring, a gradient V, and three dots (blue,
 * green, red). Ported from the Claude Design export (p3/Gate.dc.html). Each
 * instance defines its own gradients under a unique id so several marks can
 * share one page without colliding.
 */

const VIEWBOX = "-340.4 -340.4 680.8 680.8";
const LEFT = { x: -122.25, y: -68.41 };
const RIGHT = { x: 122.25, y: -68.41 };
const BOTTOM = { x: 0, y: 140.09 };

function Stops() {
  return (
    <>
      <stop offset="0" stopColor="#B12ED1" />
      <stop offset=".52" stopColor="#DE37AF" />
      <stop offset="1" stopColor="#F5A84E" />
    </>
  );
}

type MarkProps = {
  /** Rendered width and height in px. Omit to size via `style` / CSS. */
  size?: number;
  className?: string;
  style?: CSSProperties;
};

export function Mark({ size, className, style }: MarkProps) {
  const id = useId().replace(/:/g, "");
  const a = `crA${id}`;
  const b = `crB${id}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEWBOX}
      aria-hidden="true"
      className={className}
      style={style}
      focusable="false"
    >
      <defs>
        <linearGradient
          id={a}
          x1={LEFT.x}
          y1={LEFT.y}
          x2={BOTTOM.x}
          y2={BOTTOM.y}
          gradientUnits="userSpaceOnUse"
        >
          <Stops />
        </linearGradient>
        <linearGradient
          id={b}
          x1={RIGHT.x}
          y1={RIGHT.y}
          x2={BOTTOM.x}
          y2={BOTTOM.y}
          gradientUnits="userSpaceOnUse"
        >
          <Stops />
        </linearGradient>
      </defs>
      <circle r="300" fill="none" stroke="#121212" strokeWidth="32.8" />
      <g strokeWidth="32.8" strokeLinecap="round">
        <line x1={LEFT.x} y1={LEFT.y} x2={BOTTOM.x} y2={BOTTOM.y} stroke={`url(#${a})`} />
        <line x1={RIGHT.x} y1={RIGHT.y} x2={BOTTOM.x} y2={BOTTOM.y} stroke={`url(#${b})`} />
      </g>
      <circle cx={LEFT.x} cy={LEFT.y} r="53" fill="#1B77F3" />
      <circle cx={RIGHT.x} cy={RIGHT.y} r="53" fill="#00BF63" />
      <circle cx={BOTTOM.x} cy={BOTTOM.y} r="53" fill="#FF4829" />
    </svg>
  );
}

/** The small ring-and-dots glyph used inside the MCP chat card (no V). */
export function MarkDots({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VIEWBOX} aria-hidden="true" focusable="false">
      <circle r="300" fill="none" stroke="#121212" strokeWidth="40" />
      <circle cx={LEFT.x} cy={LEFT.y} r="60" fill="#1B77F3" />
      <circle cx={RIGHT.x} cy={RIGHT.y} r="60" fill="#00BF63" />
      <circle cx={BOTTOM.x} cy={BOTTOM.y} r="60" fill="#FF4829" />
    </svg>
  );
}

type LockupProps = {
  /** Mark size in px (header: 24). */
  size?: number;
  /** Wordmark font size in px (header: 19). */
  fontSize?: number;
  color?: string;
  className?: string;
};

/** Mark + "ClaudeRabbit" wordmark, as in the site header. */
export function Lockup({ size = 24, fontSize = 19, color, className }: LockupProps) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 10, color }}
    >
      <Mark size={size} />
      <span style={{ fontSize, fontWeight: 600, letterSpacing: "-0.035em" }}>ClaudeRabbit</span>
    </span>
  );
}
