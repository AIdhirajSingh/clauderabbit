import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "./Logo";
import { SilkShader } from "./SilkShader";
import s from "./footer.module.css";

/**
 * Site footer, ported from p3/Gate.dc.html (the shared Pockit footer) over the
 * dark silk shader. Sticky to the bottom so the page content above slides off
 * it, as drawn.
 */

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;

const PRODUCTS: { id: string; name: string }[] = [
  { id: "pockit", name: "Pockit" },
  { id: "clauderabbit", name: "ClaudeRabbit" },
  { id: "output", name: "Output" },
  { id: "treye", name: "Treye" },
  { id: "createvve", name: "Createvve" },
  { id: "caitailyst", name: "Caitailyst" },
];

const SOCIALS: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: "https://x.com/AIdhirajSingh",
    label: "X",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    href: "https://www.instagram.com/aidhirajsingh/",
    label: "Instagram",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    href: "https://www.facebook.com/AIdhirajSingh",
    label: "Facebook",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" />
      </svg>
    ),
  },
  {
    href: "https://www.linkedin.com/in/aidhirajsingh/",
    label: "LinkedIn",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zM7.119 20.452H3.555V9h3.564v11.452z" />
      </svg>
    ),
  },
  {
    href: "https://www.youtube.com/@AIdhirajSingh",
    label: "YouTube",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    ),
  },
];

export function Footer() {
  return (
    <footer id="contact" className={s.footer}>
      <SilkShader className={s.silk} />
      <div className={s.inner}>
        <div className={s.top}>
          <div className={s.brandRow}>
            <Link href="/#top" aria-label="ClaudeRabbit home" className={s.home}>
              <span className={s.tile}>
                <Mark className={s.tileMark} />
              </span>
              <span className={s.word}>ClaudeRabbit</span>
            </Link>
            <p className={s.made}>
              Made in India by{" "}
              <a href="https://mindndata.com" className={s.inlineLink} {...EXT}>
                MindNdata
              </a>
              .
            </p>
          </div>
          <nav aria-label="Products" className={s.row}>
            {PRODUCTS.map((p) => (
              <a
                key={p.id}
                href={`https://mindndata.com/#product-${p.id}`}
                className={s.flink}
                {...EXT}
              >
                {p.name}
              </a>
            ))}
          </nav>
        </div>
        <nav aria-label="ClaudeRabbit" className={s.legal}>
          <Link href="/privacy" className={s.flink}>
            Privacy Policy
          </Link>
          <Link href="/terms" className={s.flink}>
            Terms of Service
          </Link>
          <Link href="/privacy#delete" className={s.flink}>
            Delete account
          </Link>
          <a href="https://github.com/AIdhirajSingh/clauderabbit" className={s.flink} {...EXT}>
            View on GitHub ↗
          </a>
        </nav>
        <div className={s.bottom}>
          <span className={s.copy}>© 2026 MindNdata AInnovations Pvt. Ltd. All rights reserved.</span>
          <div className={s.contact}>
            <a href="mailto:support@clauderabbit.in" className={s.flink}>
              support@clauderabbit.in
            </a>
            <nav aria-label="Social" className={s.socials}>
              {SOCIALS.map((so) => (
                <a key={so.label} href={so.href} aria-label={so.label} className={s.social} {...EXT}>
                  {so.icon}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </div>
    </footer>
  );
}
