/** The ClaudeRabbit mark on its white tile, as drawn in the v4 canvas header and login. */
export function BrandMark({ size, glyph, radius, idPrefix }: { size: number; glyph: number; radius: number; idPrefix: string }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: radius, background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
      <svg width={glyph} height={glyph} viewBox="-340.4 -340.4 680.8 680.8" aria-hidden="true">
        <defs>
          <linearGradient id={`${idPrefix}0`} x1="-122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#B12ED1" /><stop offset=".52" stopColor="#DE37AF" /><stop offset="1" stopColor="#F5A84E" /></linearGradient>
          <linearGradient id={`${idPrefix}1`} x1="122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#B12ED1" /><stop offset=".52" stopColor="#DE37AF" /><stop offset="1" stopColor="#F5A84E" /></linearGradient>
        </defs>
        <circle r="300" fill="none" stroke="#121212" strokeWidth="32.8" />
        <g strokeWidth="32.8" strokeLinecap="round">
          <line x1="-122.25" y1="-68.41" x2="0" y2="140.09" stroke={`url(#${idPrefix}0)`} />
          <line x1="122.25" y1="-68.41" x2="0" y2="140.09" stroke={`url(#${idPrefix}1)`} />
        </g>
        <circle cx="-122.25" cy="-68.41" r="53" fill="#1B77F3" />
        <circle cx="122.25" cy="-68.41" r="53" fill="#00BF63" />
        <circle cx="0" cy="140.09" r="53" fill="#FF4829" />
      </svg>
    </span>
  );
}
