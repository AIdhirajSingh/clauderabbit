"use client";

/**
 * /app (project/term/App.dc.html, idle view): the paste box and the danger board.
 * Every row, score, verdict and time comes from /api/board; a scan starts through
 * lib/cr/scan-client.ts startScan and opens /app/scan/<runId>.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { startScan } from "@/lib/cr/scan-client";
import { displayName, toneOf, type Tone } from "@/lib/cr/verdict";

interface Row { run_id: string | null; owner_login: string; repo_name: string; commit_sha: string; score: number; verdict: string; finding: string; created_at: string }

const PILL: Record<Tone, string> = { ok: "p-ok", warn: "p-warn", bad: "p-bad" };
const ROW_STYLE = { display: "grid", gridTemplateColumns: "minmax(0,1fr) 64px 170px 56px", gap: 16, alignItems: "center", padding: "14px 20px", borderTop: "1px solid rgba(255,255,255,0.06)" } as const;
const SR_ONLY = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } as const;

/** github.com URLs and owner/repo go as they are; npm URLs and bare names become npm:<name>. */
function normalizeTarget(raw: string): string | null {
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

/** The design's compact age: 2m, 14m, 1h, 3d. */
function age(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  return `${Math.floor(d / 365)}y`;
}

function SearchIcon() {
  return (
    <div className="i3 i3-search" style={{ ["--h" as string]: "31,196,111" }} aria-hidden="true">
      <div className="i3-floor" />
      <div className="i3-tile">
        <div className="i3-plate">
          <svg className="i3-g" width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="url(#ap)" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" style={{ color: "rgb(31,196,111)" }}>
            <defs><linearGradient id="ap" gradientUnits="userSpaceOnUse" x1="8" y1="2" x2="14" y2="22"><stop offset="0" stopColor="#FFFFFF" /><stop offset=".5" stopColor="#C4C4C4" /><stop offset="1" stopColor="rgb(31,196,111)" /></linearGradient></defs>
            <circle cx="10.5" cy="10.5" r="6" />
            <path d="M15 15l5.5 5.5" />
            <path className="a-glint" d="M7.6 8.4a3.6 3.6 0 012.4-1.6" strokeWidth="1.6" />
          </svg>
        </div>
        <div className="i3-gloss" />
        <div className="i3-sweep" />
        <div className="i3-rim" />
      </div>
    </div>
  );
}

/**
 * Reads `?scan=<target>` (old 1.0 report links redirect to /app?scan=...) and hands it up once.
 * Kept in its own Suspense boundary so the rest of the page still renders on the server.
 */
function ScanParam({ onTarget }: { onTarget: (target: string) => void }) {
  const params = useSearchParams();
  const target = params.get("scan");
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !target?.trim()) return;
    sent.current = true;
    onTarget(target.trim());
  }, [target, onTarget]);
  return null;
}

export function AppScreen({ initial = null }: { initial?: { rows: Row[]; next: number | null } | null }) {
  const router = useRouter();
  // The Supabase client loads after first paint (its bundle stays off the critical path); undefined while loading.
  const [supabase, setSupabase] = useState<SupabaseClient | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    import("@/lib/supabase/client")
      .then((m) => {
        if (!live) return;
        try {
          setSupabase(m.createClient());
        } catch {
          setSupabase(null);
        }
      })
      .catch(() => live && setSupabase(null));
    return () => {
      live = false;
    };
  }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // The first page comes rendered from the server (no layout shift); the client then refreshes it.
  const [rows, setRows] = useState<Row[] | null>(initial?.rows ?? null);
  const [next, setNext] = useState<number | null>(initial ? initial.next : 0);
  const [loadErr, setLoadErr] = useState(false);
  const loading = useRef(false);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (supabase === undefined) return;
    if (!supabase) {
      queueMicrotask(() => setAuthReady(true));
      return;
    }
    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => {})
      .finally(() => setAuthReady(true));
    const { data } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await fetch(`/api/board?filter=all&offset=${offset}`, { cache: "no-store" });
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
    // Fetching the first page is the external sync; state is set after the response arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPage(0, true);
  }, [loadPage]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || next === null || rows === null) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && next !== null) loadPage(next, false);
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [next, rows, loadPage]);

  // Live: every saved report is broadcast on topic "board"; reload what is on screen.
  const lenRef = useRef(0);
  useEffect(() => {
    lenRef.current = rows?.length ?? 0;
  }, [rows]);
  useEffect(() => {
    if (!supabase) return;
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
              const r = await fetch(`/api/board?filter=all&offset=${off}`, { cache: "no-store" });
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
  }, [supabase]);

  const go = async (raw: string = query) => {
    if (busy) return;
    const target = normalizeTarget(raw);
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
  // ?scan=<target>: fill the paste box now, start the scan once auth has settled (a signed-in token goes with it).
  const onParam = useCallback((t: string) => {
    setQuery(t);
    setPending(t);
  }, []);
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  useEffect(() => {
    if (pending === null || !authReady) return;
    const t = pending;
    // Starting the scan is the external sync; the one-shot flag is cleared with it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(null);
    void goRef.current(t);
  }, [pending, authReady]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void go();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void go();
    }
  };

  return (
    <main style={{ maxWidth: 1240, margin: "0 auto", padding: "48px clamp(20px,3vw,40px) 96px" }}>
      <Suspense fallback={null}><ScanParam onTarget={onParam} /></Suspense>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start", justifyContent: "center" }}>
        <div style={{ flex: "999 1 640px", minWidth: 0, display: "flex", flexDirection: "column", gap: 32 }}>
          <section style={{ padding: "8px 0 8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <div style={{ flex: "none", width: 112 }}><SearchIcon /></div>
              <h1 className="h2" style={{ fontSize: "clamp(32px,3.6vw,48px)" }}><span className="gw">Paste a GitHub link</span> <span className="ga ga-green">or an npm package.</span></h1>
            </div>
            <form onSubmit={onSubmit} style={{ marginTop: 28, display: "flex", flexWrap: "wrap", gap: 10 }}>
              <label htmlFor="target" style={SR_ONLY}>GitHub link or npm package</label>
              <div style={{ flex: "999 1 380px", minWidth: 0, display: "flex", alignItems: "center", gap: 10, height: 56, padding: "0 18px", borderRadius: 16, border: `1px solid ${msg?.bad ? "rgba(255,149,146,0.6)" : "rgba(255,255,255,0.12)"}`, background: "#0A0A0A" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4" /></svg>
                <input
                  id="target"
                  className="mono"
                  type="text"
                  placeholder="github.com/owner/repo or express"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); if (msg?.bad) setMsg(null); }}
                  onKeyDown={onKey}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={msg?.bad ? true : undefined}
                  aria-describedby={msg ? "target-msg" : undefined}
                  style={{ flex: 1, minWidth: 0, height: 54, border: 0, outline: "none", background: "transparent", color: "#F0F0F0", fontSize: 15 }}
                />
                <span className="mono" aria-hidden="true" style={{ flex: "none", height: 24, padding: "0 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.14)", display: "flex", alignItems: "center", fontSize: 12, color: "#A1A1A1" }}>Enter ↵</span>
              </div>
              <button type="submit" className="btn btn-p" disabled={busy} aria-busy={busy} style={{ height: 56, padding: "0 28px", opacity: busy ? 0.7 : 1 }}>Scan</button>
            </form>
            <p id="target-msg" role="status" style={{ margin: "10px 0 0", minHeight: 21, fontSize: 14, color: msg?.bad ? "#FF9592" : "#A1A1A1" }}>{msg?.text ?? ""}</p>
          </section>

          <section id="board" className="card" aria-labelledby="board-title">
            <div className="card-h" style={{ padding: "16px 20px" }}>
              <div>
                <h2 id="board-title" style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Danger board</h2>
                <p className="faint" style={{ margin: "2px 0 0", fontSize: 13 }}>Every scan, most dangerous first</p>
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }} className="dim"><span className="live" aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: "#3DD68C" }} />Live</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 560 }} aria-busy={rows === null && !loadErr}>
                {rows === null && !loadErr && <div className="faint" style={{ ...ROW_STYLE, display: "block", fontSize: 13 }}>Loading the board…</div>}
                {loadErr && rows === null && (
                  <div className="dim" style={{ ...ROW_STYLE, display: "flex", fontSize: 13, gap: 12 }}>
                    The board did not load.
                    <button type="button" className="btn btn-s btn-sm" onClick={() => loadPage(0, true)}>Try again</button>
                  </div>
                )}
                {rows?.length === 0 && <div className="faint" style={{ ...ROW_STYLE, display: "block", fontSize: 13 }}>Nothing here yet.</div>}
                {rows?.map((r) => {
                  const dn = displayName(r.owner_login, r.repo_name);
                  const inner = (
                    <>
                      <div style={{ minWidth: 0 }}>
                        <div className="mono" style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dn.name}</div>
                        <div className="faint" style={{ fontSize: 13, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dn.kind === "npm" ? "npm" : "GitHub"} · {r.finding}</div>
                      </div>
                      <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" }}>{r.score}</span>
                      <span><span className={`pill ${PILL[toneOf(r.verdict)]}`}>{r.verdict}</span></span>
                      <time dateTime={r.created_at} className="faint" style={{ fontSize: 13, textAlign: "right" }}>{age(r.created_at, now)}</time>
                    </>
                  );
                  const key = `${r.run_id ?? dn.name}-${r.commit_sha}`;
                  return r.run_id ? (
                    <Link key={key} href={`/app/scan/${r.run_id}`} className="row" style={ROW_STYLE} aria-label={`${dn.name}: ${r.verdict}, score ${r.score}`}>{inner}</Link>
                  ) : (
                    <div key={key} className="row" style={ROW_STYLE}>{inner}</div>
                  );
                })}
                {next !== null && rows !== null && rows.length > 0 && <div ref={sentinel} className="faint" style={{ ...ROW_STYLE, display: "block", fontSize: 13 }}>Loading more…</div>}
              </div>
            </div>
          </section>
        </div>

        {!session && (
          <div style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
            <section className="card" style={{ padding: 20 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Keep your scans</h2>
              <p className="dim" style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.55 }}>Sign in to see your history. Scanning works without it.</p>
              <Link href="/login" className="btn btn-s btn-sm" style={{ marginTop: 16, width: "100%" }}>Continue with Google</Link>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
