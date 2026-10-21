"use client";

/** /app: the scan card and the danger board (p3/App.dc.html, board view). */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { startScan } from "@/lib/cr/scan-client";
import { BOARD_FILTERS, displayName, relativeTime, TONE_STYLE, toneOf, type BoardFilter } from "@/lib/cr/verdict";
import { useAppSession } from "./AppShell";
import s from "./app.module.css";

interface Row { run_id: string | null; owner_login: string; repo_name: string; commit_sha: string; score: number; verdict: string; finding: string; created_at: string }

/** github.com URLs and owner/repo go as they are; npm URLs and bare names become npm:<name>. */
export function normalizeTarget(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const npmUrl = t.match(/^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/((?:@[^/]+\/)?[^/?#]+)/i);
  if (npmUrl) return `npm:${decodeURIComponent(npmUrl[1] ?? "")}`;
  if (/^npm:/i.test(t)) return t;
  if (/github\.com\//i.test(t)) return t;
  if (/^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*(@[^\s]+)?$/i.test(t)) return `npm:${t}`;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t)) return t;
  if (/^[a-z0-9-~][a-z0-9-._~]*(@[^\s/]+)?$/i.test(t)) return `npm:${t}`;
  return null;
}

export function Board() {
  const router = useRouter();
  const { session } = useAppSession();
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [next, setNext] = useState<number | null>(0);
  const [loadErr, setLoadErr] = useState(false);
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const loadPage = useCallback(async (f: BoardFilter, offset: number, replace: boolean) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await fetch(`/api/board?filter=${encodeURIComponent(f)}&offset=${offset}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { rows: Row[]; next: number | null };
      setRows((prev) => (replace || !prev ? j.rows : [...prev, ...j.rows]));
      setNext(j.next);
      setLoadErr(false);
    } catch {
      setLoadErr(true);
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    // Fetching the page is the external sync; state is set after the response arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPage(filter, 0, true);
  }, [filter, loadPage]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || next === null || rows === null) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && next !== null) loadPage(filter, next, false);
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [next, rows, filter, loadPage]);

  // Live updates: every saved report is broadcast on topic "board"; reload what is on screen.
  const rowsLen = rows?.length ?? 0;
  const lenRef = useRef(rowsLen);
  useEffect(() => {
    lenRef.current = rowsLen;
  }, [rowsLen]);
  useEffect(() => {
    let supabase;
    try {
      supabase = createClient();
    } catch {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("board")
      .on("broadcast", { event: "report" }, () => {
        if (timer) return;
        timer = setTimeout(async () => {
          timer = null;
          try {
            const want = Math.max(30, lenRef.current);
            const pages: Row[] = [];
            let off: number | null = 0;
            while (off !== null && pages.length < want) {
              const r = await fetch(`/api/board?filter=${encodeURIComponent(filter)}&offset=${off}`, { cache: "no-store" });
              if (!r.ok) return;
              const j = (await r.json()) as { rows: Row[]; next: number | null };
              pages.push(...j.rows);
              off = j.next;
            }
            setRows(pages);
            setNext(off);
          } catch {}
        }, 600);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [filter]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const target = normalizeTarget(input);
    if (!target) {
      setMsg({ text: "Paste a GitHub link (github.com/owner/repo) or an npm package name.", bad: true });
      return;
    }
    setBusy(true);
    setMsg({ text: "Starting a fresh machine…", bad: false });
    try {
      const { runId } = await startScan(target, session?.access_token ?? null);
      router.push(`/app/scan/${runId}`);
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Scan failed. Try again.", bad: true });
      setBusy(false);
    }
  };

  const filters = useMemo(() => BOARD_FILTERS, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, paddingTop: 8 }}>
      <section aria-label="New scan" className={s.blurIn} style={{ position: "relative", overflow: "hidden", isolation: "isolate", borderRadius: 28, background: "#FFFFFF", boxShadow: "0 0 0 1px var(--border), 0 30px 70px -40px rgba(18,18,18,0.25)", padding: "clamp(32px,5vw,64px) clamp(20px,4vw,56px)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 22 }}>
        <div className={s.driftA} style={{ position: "absolute", zIndex: -1, left: "-8%", top: "-60%", width: "46%", aspectRatio: "1", borderRadius: "50%", background: "radial-gradient(closest-side, rgba(222,120,232,0.4), rgba(222,120,232,0))" }} />
        <div className={s.driftB} style={{ position: "absolute", zIndex: -1, right: "-8%", top: "-30%", width: "44%", aspectRatio: "1", borderRadius: "50%", background: "radial-gradient(closest-side, rgba(120,172,245,0.45), rgba(120,172,245,0))" }} />
        <h1 className={s.h1} style={{ margin: 0, fontSize: "clamp(32px,4vw,52px)", lineHeight: 1, fontWeight: 600, letterSpacing: "-0.04em" }}>Paste a GitHub link or an npm package.</h1>
        <form onSubmit={submit} style={{ width: "100%", maxWidth: 720, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label htmlFor="t" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>GitHub link or npm package</label>
          <div className={s.field} style={{ flex: "1 1 300px", minWidth: 0, height: 64, borderRadius: 999, background: "#FFFFFF", boxShadow: `0 0 0 1.5px ${msg?.bad ? "var(--bad)" : "var(--border-e)"}, 0 12px 28px -18px var(--shadow)`, display: "flex", alignItems: "center", gap: 12, padding: "0 22px" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 14a3.5 3.5 0 005 0l3-3a3.5 3.5 0 00-5-5l-.5.5" /><path d="M14 10a3.5 3.5 0 00-5 0l-3 3a3.5 3.5 0 005 5l.5-.5" /></svg>
            <input id="t" type="text" value={input} onChange={(e) => { setInput(e.target.value); if (msg?.bad) setMsg(null); }} placeholder="github.com/owner/repo or a package name" autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 0, height: 62, border: 0, outline: "none", background: "transparent", fontSize: 18, color: "var(--text)", caretColor: "var(--text)", textAlign: "left" }} />
          </div>
          <button type="submit" disabled={busy} aria-busy={busy} className={`${s.btn} ${s.press} ${s.solid} ${s.scanBtn}`} style={{ height: 64, padding: "0 36px", borderRadius: 999, background: "var(--inv)", color: "var(--on-inv)", fontSize: 17, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxShadow: "0 12px 28px -14px var(--shadow)", flex: "0 0 auto", opacity: busy ? 0.7 : 1 }}>
            Scan
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-7-7l7 7l-7 7" /></svg>
          </button>
        </form>
        {msg && <p role="status" className={s.logIn} style={{ margin: "-8px 0 0", fontSize: 14, fontWeight: 500, color: msg.bad ? "var(--bad-text)" : "var(--text2)" }}>{msg.text}</p>}
      </section>

      <section aria-labelledby="board" className={s.rise} style={{ animationDelay: "120ms", borderRadius: 28, background: "var(--surface)", padding: "clamp(12px,2vw,20px)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px 24px", padding: "8px 8px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={s.pulse} style={{ width: 8, height: 8, borderRadius: "50%", background: "#FF4829" }} />
            <h2 id="board" style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.026em" }}>Danger board</h2>
            <span className={s.meta} style={{ fontSize: 14, color: "var(--text2)" }}>Most dangerous first</span>
          </div>
          <div role="tablist" aria-label="Verdict" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {filters.map((f) => {
              const on = f.id === filter;
              return (
                <button key={f.id} type="button" role="tab" aria-selected={on} className={`${s.btn} ${s.press}`} onClick={() => { if (f.id === filter) return; setRows(null); setNext(0); setFilter(f.id); }} style={{ height: 48, padding: "0 16px", borderRadius: 999, fontSize: 14, fontWeight: 600, background: on ? "var(--inv)" : "transparent", color: on ? "var(--on-inv)" : "var(--text)" }}>
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
        <div role="list" style={{ borderRadius: 20, background: "var(--card)", boxShadow: "0 0 0 1px var(--border)", overflow: "hidden" }}>
          {rows === null && !loadErr && <div style={{ padding: "40px 20px", fontSize: 15, color: "var(--text2)" }}>Loading the board…</div>}
          {loadErr && rows === null && (
            <div style={{ padding: "32px 20px", fontSize: 15, color: "var(--text2)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              The board did not load.
              <button type="button" className={`${s.btn} ${s.press} ${s.ghost}`} onClick={() => loadPage(filter, 0, true)} style={{ height: 48, padding: "0 18px", borderRadius: 999, boxShadow: "inset 0 0 0 1.5px var(--text)", fontWeight: 600, color: "var(--text)" }}>Try again</button>
            </div>
          )}
          {rows?.length === 0 && <div style={{ padding: "40px 20px", fontSize: 15, color: "var(--text2)" }}>Nothing here yet.</div>}
          {rows?.map((r, i) => {
            const tone = TONE_STYLE[toneOf(r.verdict)];
            const dn = displayName(r.owner_login, r.repo_name);
            return (
              <button key={`${r.run_id}-${r.commit_sha}`} type="button" role="listitem" disabled={!r.run_id} className={`${s.btn} ${s.press} ${s.row} ${s.logIn}`} onClick={() => r.run_id && router.push(`/app/scan/${r.run_id}`)} style={{ display: "flex", alignItems: "center", gap: 16, width: "100%", minHeight: 76, padding: "0 20px", borderTop: i === 0 ? "none" : "1px solid var(--border)", animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                <span style={{ width: 52, height: 52, flex: "none", borderRadius: 16, display: "grid", placeItems: "center", fontSize: 21, fontWeight: 600, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums", ...tone.tile }}>{r.score}</span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    {dn.kind === "gh" ? <GhIcon /> : <NpmIcon />}
                    <span style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dn.name}</span>
                    <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 4, height: 24, padding: "0 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, ...tone.pill }}><VerdictGlyph verdict={r.verdict} size={12} />{r.verdict}</span>
                  </span>
                  <span style={{ fontSize: 14, color: "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.finding}</span>
                </span>
                <span className={s.meta} style={{ flex: "none", fontSize: 13, color: "var(--text2)", fontVariantNumeric: "tabular-nums" }}>{relativeTime(r.created_at, now)}</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}><path d="M10 6.5L15.5 12L10 17.5" /></svg>
              </button>
            );
          })}
          {next !== null && rows !== null && rows.length > 0 && <div ref={sentinel} style={{ padding: "18px 20px", fontSize: 14, color: "var(--text2)", borderTop: "1px solid var(--border)" }}>Loading more…</div>}
        </div>
      </section>
    </div>
  );
}

export function VerdictGlyph({ verdict, size = 18 }: { verdict: string; size?: number }) {
  const tone = toneOf(verdict);
  if (tone === "ok") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
  if (tone === "warn") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v5" /><circle cx="12" cy="16.2" r=".6" fill="currentColor" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;
}

function GhIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}><path fill="var(--text)" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>;
}
function NpmIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}><path fill="#CB3837" d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" /></svg>;
}
