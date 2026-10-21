"use client";

/**
 * The /app frame from p3/App.dc.html: the glass header (logo, Sign in or the
 * avatar) and the account card that opens on the right (full height, about a
 * quarter of the width; the board shifts left; on phones it slides over).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { displayName, relativeTime, TONE_STYLE, toneOf } from "@/lib/cr/verdict";
import s from "./app.module.css";

interface SessionCtx {
  session: Session | null;
  ready: boolean;
  refreshMine: () => void;
}
const Ctx = createContext<SessionCtx>({ session: null, ready: false, refreshMine: () => {} });
export const useAppSession = () => useContext(Ctx);

interface MineRow { run_id: string; subject: string; commit_sha: string; score: number | null; verdict: string | null; scanned_at: string }

export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-340.4 -340.4 680.8 680.8" aria-hidden="true">
      <defs>
        <linearGradient id="crA" x1="-122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#B12ED1" /><stop offset=".52" stopColor="#DE37AF" /><stop offset="1" stopColor="#F5A84E" /></linearGradient>
        <linearGradient id="crB" x1="122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#B12ED1" /><stop offset=".52" stopColor="#DE37AF" /><stop offset="1" stopColor="#F5A84E" /></linearGradient>
      </defs>
      <circle r="300" fill="none" stroke="#121212" strokeWidth="32.8" />
      <g strokeWidth="32.8" strokeLinecap="round"><line x1="-122.25" y1="-68.41" x2="0" y2="140.09" stroke="url(#crA)" /><line x1="122.25" y1="-68.41" x2="0" y2="140.09" stroke="url(#crB)" /></g>
      <circle cx="-122.25" cy="-68.41" r="53" fill="#1B77F3" /><circle cx="122.25" cy="-68.41" r="53" fill="#00BF63" /><circle cx="0" cy="140.09" r="53" fill="#FF4829" />
    </svg>
  );
}

function subjectName(subject: string): string {
  if (subject.startsWith("npm:")) return subject.slice(4);
  return subject;
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const supabase = useMemo(() => {
    try {
      return createClient();
    } catch {
      return null;
    }
  }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<MineRow[] | null>(null);
  const [mineTick, setMineTick] = useState(0);

  useEffect(() => {
    if (!supabase) {
      queueMicrotask(() => setReady(true));
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!session || !open) return;
    let cancelled = false;
    fetch("/api/me/scans", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { scans: [] }))
      .then((j) => !cancelled && setMine(Array.isArray(j.scans) ? j.scans : []))
      .catch(() => !cancelled && setMine([]));
    return () => {
      cancelled = true;
    };
  }, [session, open, mineTick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
    setOpen(false);
    setMine(null);
    router.refresh();
  }, [supabase, router]);

  const user = session?.user;
  const name = (user?.user_metadata?.full_name as string | undefined) ?? (user?.user_metadata?.name as string | undefined) ?? user?.email?.split("@")[0] ?? "";
  const initial = (name || user?.email || "?").slice(0, 1).toUpperCase();
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const ctx = useMemo(() => ({ session, ready, refreshMine: () => setMineTick((n) => n + 1) }), [session, ready]);

  return (
    <Ctx.Provider value={ctx}>
      <div className={s.a}>
        <div className={s.driftA} aria-hidden="true" style={{ position: "absolute", zIndex: -1, left: "-14%", top: "-18%", width: "52vmax", aspectRatio: "1", borderRadius: "50%", background: "radial-gradient(closest-side, rgba(222,120,232,0.28), rgba(222,120,232,0))" }} />
        <div className={s.driftB} aria-hidden="true" style={{ position: "absolute", zIndex: -1, right: "-16%", top: "-10%", width: "48vmax", aspectRatio: "1", borderRadius: "50%", background: "radial-gradient(closest-side, rgba(120,172,245,0.3), rgba(120,172,245,0))" }} />
        <div className={s.shell}>
          <div className={s.mainCol}>
            <header className={s.header}>
              <div className={s.pill}>
                <Link href="/" aria-label="ClaudeRabbit home" style={{ display: "flex", alignItems: "center", gap: 10, height: 48, marginRight: 8 }}>
                  <Mark />
                  <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.035em" }}>ClaudeRabbit</span>
                </Link>
                <span style={{ flex: 1 }} />
                {ready && !user && (
                  <Link href="/login" className={`${s.press} ${s.ghost}`} style={{ height: 48, padding: "0 18px", borderRadius: 999, display: "flex", alignItems: "center", fontSize: 14.5, fontWeight: 600, whiteSpace: "nowrap" }}>
                    Sign in
                  </Link>
                )}
                {user && (
                  <button type="button" className={`${s.btn} ${s.press} ${s.ghost}`} onClick={() => setOpen((v) => !v)} onMouseEnter={() => setOpen(true)} aria-label="Your account" aria-expanded={open} style={{ width: 48, height: 48, borderRadius: 999, display: "grid", placeItems: "center" }}>
                    <span style={{ width: 32, height: 32, borderRadius: 999, background: "#1B77F3", color: "#FFFFFF", display: "grid", placeItems: "center", fontSize: 14, fontWeight: 600, overflow: "hidden", boxShadow: open ? "0 0 0 2px #FFFFFF, 0 0 0 4px #1B77F3" : "none" }}>
                      {avatarUrl ? <img src={avatarUrl} alt="" width={32} height={32} referrerPolicy="no-referrer" /> : initial}
                    </span>
                  </button>
                )}
              </div>
            </header>
            <main className={s.main}>
              <div className={s.wrap}>{children}</div>
            </main>
          </div>
          {open && user && (
            <>
              <div className={s.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
              <aside aria-label="Your account" className={`${s.aside} ${s.cardIn}`}>
                <div style={{ height: "100%", borderRadius: 28, background: "#FFFFFF", boxShadow: "0 0 0 1px var(--border), 0 30px 70px -40px rgba(18,18,18,0.35)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ padding: "20px 20px 0", display: "flex", justifyContent: "flex-end" }}>
                    <button type="button" className={`${s.btn} ${s.press} ${s.ghost}`} onClick={() => setOpen(false)} aria-label="Close" style={{ width: 48, height: 48, borderRadius: 999, display: "grid", placeItems: "center" }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text)" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <div style={{ padding: "0 28px 24px", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 14, borderBottom: "1px solid var(--border)" }}>
                    <span style={{ width: 64, height: 64, borderRadius: 999, background: "#1B77F3", color: "#FFFFFF", display: "grid", placeItems: "center", fontSize: 26, fontWeight: 600, overflow: "hidden" }}>
                      {avatarUrl ? <img src={avatarUrl} alt="" width={64} height={64} referrerPolicy="no-referrer" /> : initial}
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, maxWidth: "100%" }}>
                      <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.026em" }}>{name}</span>
                      <span style={{ fontSize: 14, color: "var(--text2)", overflowWrap: "anywhere" }}>{user.email}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 40, lineHeight: 1, fontWeight: 600, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>{mine ? mine.length : "–"}</span>
                      <span style={{ fontSize: 15, color: "var(--text2)" }}>{mine && mine.length === 1 ? "scan" : "scans"}</span>
                    </div>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px" }}>
                    {mine && mine.length === 0 && <p style={{ margin: 0, padding: "16px 12px", fontSize: 15, color: "var(--text2)" }}>Your scans show here.</p>}
                    {mine?.map((r) => {
                      const tone = r.verdict ? TONE_STYLE[toneOf(r.verdict)] : null;
                      return (
                        <button key={r.run_id} type="button" className={`${s.btn} ${s.press} ${s.row}`} onClick={() => { setOpen(false); router.push(`/app/scan/${r.run_id}`); }} style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", minHeight: 68, padding: "0 12px", borderRadius: 16 }}>
                          <span style={{ width: 44, height: 44, flex: "none", borderRadius: 14, display: "grid", placeItems: "center", fontSize: 17, fontWeight: 600, fontVariantNumeric: "tabular-nums", ...(tone ? tone.tile : { background: "var(--muted)", color: "var(--text2)" }) }}>{r.score ?? "…"}</span>
                          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                            <span style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subjectName(r.subject)}</span>
                            <span style={{ fontSize: 13, color: "var(--text2)" }}>{r.verdict ?? "Not finished"} · {relativeTime(r.scanned_at)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ padding: "12px 20px 20px", borderTop: "1px solid var(--border)" }}>
                    <button type="button" className={`${s.btn} ${s.press} ${s.ghost}`} onClick={signOut} style={{ height: 48, padding: "0 14px", borderRadius: 999, fontSize: 15, fontWeight: 600, color: "var(--text2)", display: "flex", alignItems: "center" }}>
                      Sign out
                    </button>
                  </div>
                </div>
              </aside>
            </>
          )}
        </div>
      </div>
    </Ctx.Provider>
  );
}

export { displayName };
