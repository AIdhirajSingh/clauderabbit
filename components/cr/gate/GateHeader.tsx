"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Mark } from "../Logo";
import s from "./gate.module.css";

/**
 * Sticky glass header from p3/Gate.dc.html: logo, MindNdata, GitHub, Sign in,
 * one "Visit platform" button, and the ≤960px menu toggle.
 */

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;
const GITHUB = "https://github.com/AIdhirajSingh/clauderabbit";

export function GateHeader() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const mq = window.matchMedia("(min-width: 961px)");
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onWide);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className={s.header}>
      <div className={s.bar}>
        <a href="#top" aria-label="ClaudeRabbit home" className={s.homeLink}>
          <Mark size={24} />
          <span className={s.wordmark}>ClaudeRabbit</span>
        </a>
        <span className={s.spacer} />
        <nav aria-label="Site" className={s.nav}>
          <a href="https://mindndata.com" className={`${s.press} ${s.nl} ${s.navLink} ${s.hit}`} {...EXT}>
            MindNdata
          </a>
          <a href={GITHUB} className={`${s.press} ${s.nl} ${s.navLink} ${s.hit}`} {...EXT}>
            GitHub
          </a>
          <Link href="/login" className={`${s.press} ${s.nl} ${s.navLink} ${s.hit}`}>
            Sign in
          </Link>
        </nav>
        <Link href="/app" className={`${s.press} ${s.btnDark} ${s.platform} ${s.hit}`}>
          Visit platform
        </Link>
        <button
          type="button"
          className={`${s.press} ${s.nl} ${s.menuBtn} ${s.hit}`}
          onClick={() => setOpen((v) => !v)}
          aria-label="Menu"
          aria-expanded={open}
          aria-controls={menuId}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#121212"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M5 8h14M5 16h14" />
          </svg>
        </button>
      </div>
      {open && (
        <nav id={menuId} aria-label="Site menu" className={s.menu}>
          <a href="https://mindndata.com" className={s.menuLink} onClick={close} {...EXT}>
            MindNdata
          </a>
          <a href={GITHUB} className={s.menuLink} onClick={close} {...EXT}>
            GitHub
          </a>
          <Link href="/login" className={s.menuLink} onClick={close}>
            Sign in
          </Link>
        </nav>
      )}
    </header>
  );
}
