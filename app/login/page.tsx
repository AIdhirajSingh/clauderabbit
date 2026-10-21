import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/cr/Logo";
import { Orbit } from "@/components/cr/Orbit";
import { GoogleButton } from "@/components/cr/login/GoogleButton";
import s from "@/components/cr/login/login.module.css";

/**
 * `/login` — sign in or sign up, ported from the Claude Design export
 * p3/Login.dc.html. Signing in is optional: it only saves scan history.
 */

export const metadata: Metadata = {
  title: "Sign in to ClaudeRabbit",
  robots: { index: false, follow: true },
};

export default function LoginPage() {
  return (
    <div className={s.l}>
      <div className={s.top}>
        <Link href="/" className={`${s.press} ${s.ghost} ${s.back}`}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
          Back
        </Link>
        <Link href="/app" className={`${s.press} ${s.ghost} ${s.notNow}`}>
          Not now
        </Link>
      </div>

      <main className={s.stage}>
        <div className={s.side}>
          <Orbit />
          <p className={s.tagline}>Cybersecurity for builders.</p>
        </div>
        <div className={s.card}>
          <span className={s.markTile}>
            <Mark size={44} />
          </span>
          <h1 className={s.h1}>Sign in or sign up</h1>
          <p className={s.sub}>Your scans are saved to your account.</p>
          <GoogleButton />
          <p className={s.legal}>
            By continuing you agree to the{" "}
            <Link href="/terms" className={s.legalLink}>
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className={s.legalLink}>
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
