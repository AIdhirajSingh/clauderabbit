/**
 * Shared inline SVG glyphs, ported verbatim from the DC prototype. Kept thin
 * (stroke 1.2–1.8, currentColor / var(--t1)) per the design's iconography rule.
 */

/** The minimal geometric rabbit brand mark (two ears, head, eye). */
export function RabbitMark({ size = 24, stroke = "1.7" }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
      <path
        d="M10.2 14.5 C8.3 9.8 8.6 4.4 10.2 4 C11.8 3.6 13.1 8 13.3 12.3"
        stroke="var(--t1)"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
      <path
        d="M21.8 14.5 C23.7 9.8 23.4 4.4 21.8 4 C20.2 3.6 18.9 8 18.7 12.3"
        stroke="var(--t1)"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
      <circle cx="16" cy="19.6" r="7" stroke="var(--t1)" strokeWidth={stroke} />
      <circle cx="16" cy="19.8" r="1.6" fill="var(--t1)" />
    </svg>
  );
}

/** Theme toggle icon: sun in dark mode (to switch to light), moon in light mode. */
export function ThemeIcon({ isDark, size = 15 }: { isDark: boolean; size?: number }) {
  if (isDark) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="4.6" fill="currentColor" />
        <path
          d="M12 2.2v2.6M12 19.2v2.6M4.3 12H1.7M22.3 12h-2.6M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21.2 13.4A7.8 7.8 0 1 1 10.5 2.8 6.2 6.2 0 0 0 21.2 13.4z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** GitHub mark. */
export function GithubIcon({ size = 14, fill = "var(--t2)" }: { size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** A filled gold star (GitHub stars). */
export function StarIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="var(--gold)" aria-hidden="true">
      <path d="M8 .25l2.06 4.78 5.19.45-3.94 3.41 1.18 5.07L8 11.42 3.51 14l1.18-5.1L.75 5.48l5.19-.45z" />
    </svg>
  );
}

/** A right-pointing chevron (row affordance). */
export function Chevron({ size = 15, stroke = "1.5" }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A left-pointing chevron (back affordance). */
export function BackChevron({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
