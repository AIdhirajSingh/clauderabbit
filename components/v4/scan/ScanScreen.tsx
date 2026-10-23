"use client";

/**
 * /app/scan/<runId> in the v4 design (project/term/Scan.dc.html): the stepper, the
 * "Inside the sandbox" diagram, the live timeline and the Jev and Luna panels, all
 * driven by the run's real events (the same fetch, live stream, Realtime, heartbeat,
 * replay and continue-card wiring as components/cr/app/ScanView.tsx). 200 ms after the
 * last event shows (live or replay) the full report replaces this page, as Scan opens
 * Report in the design; a direct load of a finished run goes to the report at once.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { liveScan, subscribeLive } from "@/lib/cr/scan-client";
import type { ReportPayload, ScanEvent } from "@/lib/engine/types";
import { toneOf } from "@/lib/cr/verdict";
import { ADS_ENABLED } from "@/lib/ads-enabled";
import { Header } from "@/components/v4/Header";
import { ContinueCard } from "@/components/cr/app/ContinueCard";
import { BannerAd, Interstitial } from "@/components/cr/app/Ads";
import { IC, PLUMBING_HOST, TONE, clock, fileChips, fmtBytes, jevRows, lunaText, phaseWord, processes, steps, timeline, vmCpu } from "./derive";

interface RunReport {
  run_id: string;
  subject: string;
  commit_sha: string;
  status: "running" | "done" | "error";
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
  report: (Omit<ReportPayload, "ran"> & { luna_report?: { what_ran: string; what_matters: string } }) | null;
}

function shortSha(sha: string): string {
  if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 7);
  const v = sha.split("+")[0] ?? sha;
  return v.length > 24 ? `${v.slice(0, 24)}…` : v;
}
const subjectName = (s: string) => (s.startsWith("npm:") ? s.slice(4) : s);
/** The public report for a run's target: /npm/<name> for npm, /<owner>/<repo> for GitHub. */
const reportHref = (subject: string) => (subject.startsWith("npm:") ? `/npm/${subjectName(subject)}` : `/${subjectName(subject)}`);
/** How long the finished scan stays on screen after its last event before the report opens. */
const OPEN_REPORT_MS = 200;
const W = "rgba(255,255,255,0.12)";
const RED = "rgba(255,149,146,0.7)";
const toneClass = (verdict: string) => ({ ok: "p-ok", warn: "p-warn", bad: "p-bad" })[toneOf(verdict)];

function Ico({ d, color, size = 15 }: { d: string; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
function CardIcon({ d, color }: { d: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", width: 24, height: 24, borderRadius: 7, background: `${color}1F`, alignItems: "center", justifyContent: "center", marginRight: 10, verticalAlign: -6 }}>
      <Ico d={d} color={color} size={13} />
    </span>
  );
}

/**
 * `boot` is set while /app/scan/new starts the scan and no run id exists yet: nothing is
 * fetched, the first step shows as active and the sandbox diagram shows Booting. `error`
 * holds the reason the start failed.
 */
export function ScanScreen({ runId, boot }: { runId: string; boot?: { error: string | null } }) {
  const router = useRouter();
  const booting = !!boot;
  const bootErr = boot?.error ?? null;
  const params = useSearchParams();
  const replay = params.get("replay") === "1";
  const speed = replay ? Math.min(20, Math.max(1, Number(params.get("speed") ?? "4") || 4)) : 1;
  const [startedHere] = useState(() => !replay && !!liveScan(runId));
  const paced = replay || startedHere;

  const [run, setRun] = useState<RunReport | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [playNow, setPlayNow] = useState(0);
  const [playBase, setPlayBase] = useState<number | null>(null);
  const [playDone, setPlayDone] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [leaving, setLeaving] = useState(false);
  const baseRef = useRef<number | null>(null);
  const eventsRef = useRef<ScanEvent[]>([]);
  const runRef = useRef<RunReport | null>(null);
  const seen = useRef(new Set<number>());

  const addEvents = useCallback((list: ScanEvent[]) => {
    const fresh = list.filter((e) => !seen.current.has(e.seq));
    if (fresh.length === 0) return;
    fresh.forEach((e) => seen.current.add(e.seq));
    setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
  }, []);

  const loadRun = useCallback(async (): Promise<RunReport | null> => {
    const r = await fetch(`/api/runs/${runId}/report`, { cache: "no-store" });
    if (r.status === 404 || r.status === 400) {
      setNotFound(true);
      return null;
    }
    if (!r.ok) return null;
    const j = (await r.json()) as RunReport;
    setRun(j);
    return j;
  }, [runId]);

  const loadEvents = useCallback(async () => {
    const r = await fetch(`/api/runs/${runId}/events`, { cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as { events: ScanEvent[] };
    addEvents(j.events ?? []);
  }, [runId, addEvents]);

  // Live stream from this tab (started on /app), if any.
  useEffect(() => {
    if (replay || booting) return;
    const l = liveScan(runId);
    if (!l) return;
    const sync = () => {
      addEvents(l.events);
      if (l.final?.type === "result") {
        const rep = l.final.report;
        setRun((prev) => ({ run_id: runId, subject: prev?.subject ?? rep.target, commit_sha: rep.commit_sha, status: "done", error_code: null, started_at: prev?.started_at ?? new Date().toISOString(), finished_at: new Date().toISOString(), report: rep }));
        loadRun();
      } else if (l.final?.type === "error") {
        loadRun();
      } else if (l.dropped) {
        loadEvents();
        loadRun();
      }
    };
    sync();
    return subscribeLive(runId, sync);
  }, [runId, replay, booting, addEvents, loadRun, loadEvents]);

  // Stored state: the run, its events, and Realtime while it is running (reconnects pick up by seq).
  useEffect(() => {
    if (booting) return;
    let stop = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let supabase: ReturnType<typeof createClient> | null = null;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    (async () => {
      const r = await loadRun();
      // A direct load of a finished run (no replay, not started in this tab) opens its report with no playback.
      if (!stop && r?.status === "done" && r.report && !replay && !startedHere) {
        setLeaving(true);
        router.replace(reportHref(r.subject));
        return;
      }
      await loadEvents();
      if (stop || !r || r.status !== "running" || replay) return;
      try {
        supabase = createClient();
        channel = supabase.channel(`scan:${runId}`);
        for (const type of ["stage", "timing", "transcript", "forged_call", "file", "process", "check"]) {
          channel.on("broadcast", { event: type }, (msg: { payload: { seq: number; t_ms: number; data: unknown } }) => {
            addEvents([{ run_id: runId, seq: msg.payload.seq, t_ms: msg.payload.t_ms, type, data: msg.payload.data } as ScanEvent]);
          });
        }
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") loadEvents();
        });
      } catch {}
      poll = setInterval(async () => {
        const rr = await loadRun();
        if (rr && rr.status !== "running") {
          await loadEvents();
          if (poll) clearInterval(poll);
        } else loadEvents();
      }, 2500);
    })();
    return () => {
      stop = true;
      if (poll) clearInterval(poll);
      if (supabase && channel) supabase.removeChannel(channel);
    };
  }, [runId, replay, booting, startedHere, router, loadRun, loadEvents, addEvents]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // Playback clock (same rules as ScanView): a paste-box scan plays against its live
  // origin, a replay from when the stored events load; it ends when the last event shows.
  useEffect(() => {
    if (!paced || playDone) return;
    const tick = (): boolean => {
      const t = performance.now();
      if (baseRef.current === null) {
        if (replay) {
          if (eventsRef.current.length > 0 && runRef.current?.status === "done") baseRef.current = t;
        } else {
          const o = liveScan(runId)?.origin;
          if (o !== null && o !== undefined) baseRef.current = o;
        }
        if (baseRef.current !== null) setPlayBase(baseRef.current);
      }
      setPlayNow(t);
      const base = baseRef.current;
      const last = eventsRef.current[eventsRef.current.length - 1]?.t_ms ?? 0;
      const r = runRef.current;
      if (base !== null && r?.report && r.status === "done" && (t - base) * speed >= last) {
        setPlayDone(true);
        return true;
      }
      return false;
    };
    const id = setInterval(() => {
      if (tick()) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [paced, playDone, replay, runId, speed]);

  const playMs = paced && playBase !== null ? Math.max(0, (playNow - playBase) * speed) : null;
  const visible = useMemo(() => (paced ? (playMs === null ? [] : events.filter((e) => e.t_ms <= playMs)) : events), [paced, playMs, events]);
  const done = !!run?.report && run.status === "done" && (!paced || playDone);
  const failed = (run?.status === "error" && !replay) || !!bootErr;
  const running = !done && !failed;

  // 200 ms after the last event shows, the full report replaces the finished scan (Back skips it).
  const subject = run?.subject ?? null;
  useEffect(() => {
    if (!done || !subject) return;
    const id = setTimeout(() => router.replace(reportHref(subject)), OPEN_REPORT_MS);
    return () => clearTimeout(id);
  }, [done, subject, router]);

  // The large-repo prompt: live view only, while the run is running and the install still
  // waits at its limit (no stage event has followed the one that hit it).
  const testCard = params.get("test_card") === "1" && process.env.NEXT_PUBLIC_VERCEL_ENV !== "production";
  const installWaiting = useMemo(() => {
    if (replay || run?.status !== "running") return false;
    let at = -1;
    visible.forEach((e, i) => {
      if ((e.type === "transcript" && /install-at-limit/.test(e.data.text)) || (e.type === "stage" && e.data.name === "detonate" && (testCard || (e.data.status !== "start" && /install timeout/i.test(e.data.detail ?? ""))))) at = i;
    });
    return at >= 0 && !visible.slice(at + 1).some((e) => e.type === "stage");
  }, [visible, testCard, replay, run?.status]);

  // Heartbeat every 10 s keeps a full scan's sandboxes alive while this tab watches.
  useEffect(() => {
    if (!running || booting) return;
    const beat = () => void fetch(`/api/scan/${runId}/heartbeat`, { method: "POST", headers: { "x-clauderabbit-client": "web" }, keepalive: true }).catch(() => {});
    beat();
    const id = setInterval(beat, 10_000);
    return () => clearInterval(id);
  }, [running, booting, runId]);

  useEffect(() => {
    if (!running || paced) return;
    const id = setInterval(() => setClockNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running, paced]);

  const lastT = visible[visible.length - 1]?.t_ms ?? 0;
  const report = run?.report ?? null;
  const totalMs = report ? (report.timings?.total_ms ?? report.timings?.total ?? (run?.finished_at && run.started_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : lastT)) : lastT;
  const liveMs = done ? totalMs : playMs !== null ? playMs : paced ? 0 : run && running ? Math.max(lastT, clockNow - Date.parse(run.started_at)) : lastT;

  const st = useMemo(() => {
    const s = steps(visible, done);
    return booting && !bootErr ? s.map((x, i) => (i === 0 ? { ...x, state: "active" as const } : x)) : s;
  }, [visible, done, booting, bootErr]);
  const rows = useMemo(() => timeline(visible), [visible]);
  const jev = useMemo(() => jevRows(visible), [visible]);
  const decoyPids = useMemo(() => new Set(visible.flatMap((e) => (e.type === "file" && e.data.op === "read_decoy" ? [e.data.pid] : []))), [visible]);
  const procs = useMemo(() => processes(visible, decoyPids), [visible, decoyPids]);
  const files = useMemo(() => fileChips(visible), [visible]);
  const calls = useMemo(() => visible.filter((e) => e.type === "forged_call"), [visible]);
  const cpu = useMemo(() => vmCpu(visible), [visible]);
  const luna = useMemo(() => lunaText(visible), [visible]);

  const nowMs = playMs ?? liveMs;
  const outbound = [...calls].reverse().find((e) => e.type === "forged_call" && !PLUMBING_HOST.test(e.data.host) && e.data.proto !== "dns");
  const registry = [...calls].reverse().find((e) => e.type === "forged_call" && PLUMBING_HOST.test(e.data.host));
  const ob = outbound?.type === "forged_call" ? outbound : null;
  const rg = registry?.type === "forged_call" ? registry : null;
  const compromised = decoyPids.size > 0 || files.some((f) => f.bad) || calls.some((e) => e.type === "forged_call" && e.data.canary_hits.length > 0);
  const killed = visible.some((e) => e.type === "check" && e.data.name === "sandbox_killed");
  const egressFailed = visible.some((e) => e.type === "check" && e.data.name === "egress_contained" && !e.data.ok);
  const sandboxUp = st[1]!.state !== "queued";
  const vmDone = done || killed;
  const vmState = vmDone ? "Destroyed" : !sandboxUp ? "Booting" : compromised ? "Compromised" : "Running";
  const vmPc = vmDone ? "p-mute" : compromised ? "p-bad" : "p-info";
  const vmBorder = vmDone ? W : compromised ? RED : sandboxUp ? "rgba(112,184,255,0.6)" : W;
  const packet = !!ob && nowMs - ob.t_ms < 1500;
  const repoName = run ? subjectName(run.subject).split("/").pop() ?? subjectName(run.subject) : "";
  const lunaChars = luna ? Math.floor(luna.text.length * Math.max(0, Math.min(1, (nowMs - luna.atMs) / 2200))) : 0;
  const lunaShown = luna ? (done ? luna.text : luna.text.slice(0, lunaChars)) : "";
  const lunaTyping = !!luna && !done && lunaChars < luna.text.length;

  if (notFound) {
    return (
      <div style={{ minHeight: "100vh", background: "#000" }}>
        <Header />
        <div className="wrap" style={{ paddingTop: 64, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
          <h1 className="h3">This scan was not found.</h1>
          <Link href="/app" className="btn btn-p btn-sm">New scan</Link>
        </div>
      </div>
    );
  }

  if (leaving) {
    return (
      <div style={{ minHeight: "100vh", background: "#000" }}>
        <Header />
      </div>
    );
  }

  const title = done ? "Scan complete" : failed ? "Scan stopped" : "Scanning";
  const phase = done && report ? report.verdict : failed ? "Error" : phaseWord(st);
  const phaseClass = done && report ? toneClass(report.verdict) : failed ? "p-warn" : "p-info";

  return (
    <div style={{ height: "100vh", minHeight: 860, background: "#000", display: "flex", flexDirection: "column" }}>
      <Header />
      <div className="sw">
        {ADS_ENABLED && <aside className="side" aria-label="Sponsored"><BannerAd runId={runId} n={1} /></aside>}
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, ...(ADS_ENABLED ? {} : { maxWidth: 1152, margin: "0 auto" }) }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px 24px" }}>
            <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 14 }}>
              <span className="node" style={{ width: 40, height: 40, borderRadius: 12 }}>
                {running ? (
                  <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.15)" strokeWidth="2" /><path d="M21 12a9 9 0 00-9-9" stroke="#F0F0F0" strokeWidth="2" strokeLinecap="round" /></svg>
                ) : (
                  <Ico d={IC.alert} color={TONE[phaseClass] ?? "#A1A1A1"} size={18} />
                )}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.02em" }}>{title}</span><span className={`pill ${phaseClass}`}>{phase}</span></div>
                <div className="mono dim" role={booting ? "status" : undefined} style={{ marginTop: 2, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run ? `${run.subject.startsWith("npm:") ? "npm" : "github.com"}/${subjectName(run.subject)} · ${shortSha(run.commit_sha)}` : booting ? (bootErr ? "Could not start" : "Starting a fresh machine…") : "Starting…"}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <span className="mono" style={{ fontSize: 15, fontVariantNumeric: "tabular-nums" }}>{clock(liveMs)}</span>
            </div>
          </div>
          {ADS_ENABLED && (
            <>
              <div className="adi adi-d adi-m"><BannerAd runId={runId} n={2} /></div>
            </>
          )}
          <div style={{ overflowX: "auto", marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 0, minWidth: 600 }}>
            {st.map((s, i) => {
              const last = i === st.length - 1;
              return (
                <div key={s.label} style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ flex: "none", width: 22, height: 22, borderRadius: "50%", border: `1px solid ${s.state === "queued" ? "rgba(255,255,255,0.18)" : "#F0F0F0"}`, background: s.state === "done" ? "#F0F0F0" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {s.state === "done" && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>}
                    {s.state === "active" && <span className="live" style={{ width: 8, height: 8, borderRadius: "50%", background: "#F0F0F0" }} />}
                  </span>
                  <span style={{ flex: "none", fontSize: 13, color: s.state === "queued" ? "#8A8A8A" : "#F0F0F0" }}>{s.label}</span>
                  <span aria-hidden="true" style={{ flex: 1, height: 1, marginRight: 10, background: last ? "transparent" : s.state === "done" ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.1)" }} />
                </div>
              );
            })}
          </div>
          </div>
          {/* Under the stepper, aligned to its Install step (the third of six). */}
          <div style={{ display: "flex" }}>
            <span aria-hidden="true" style={{ flex: "0 1 33.333%" }} />
            <div style={{ flex: "0 1 440px", minWidth: 280 }}>
              <ContinueCard runId={runId} show={installWaiting} />
            </div>
          </div>

          {bootErr && <p className="body" role="alert" style={{ marginTop: 16 }}>{bootErr} No score was given. <Link href="/app" style={{ color: "#F0F0F0", textDecoration: "underline" }}>Back to scan</Link></p>}
          {failed && !bootErr && <p className="body" style={{ marginTop: 16 }}>This scan stopped before it finished ({run?.error_code ?? "error"}). No score was given. <Link href="/app" style={{ color: "#F0F0F0", textDecoration: "underline" }}>New scan</Link></p>}

          {ADS_ENABLED && <Interstitial runId={runId} />}

          <>
              <div className="card" style={{ flex: "none", marginTop: 16 }}>
                <div className="card-h"><span className="card-t"><CardIcon d={IC.box} color="#4CCCE6" />Inside the sandbox</span><span className="faint" style={{ fontSize: 12 }}>live</span></div>
                {/* Phones scroll the diagram sideways at its designed width instead of squeezing it. */}
                <div style={{ overflowX: "auto" }}>
                <div style={{ position: "relative", height: 236, margin: "0 18px", minWidth: 720 }}>
                  <div style={{ position: "absolute", left: "0%", width: "11%", top: 82, height: 72, borderRadius: 14, border: `1px solid ${run ? "rgba(76,204,230,0.6)" : W}`, background: "#0A0A0A", padding: 12, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, transition: "border-color .3s" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}><Ico d={IC.git} color="#A1A1A1" /> Repository</span>
                    <span className="mono faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repoName}</span>
                  </div>
                  <div aria-hidden="true" style={{ position: "absolute", left: "11%", width: "3%", top: 118, borderTop: `1px solid ${st[0]!.state === "done" ? "rgba(76,204,230,0.6)" : W}`, transition: "border-color .3s" }} />
                  <div style={{ position: "absolute", left: "14%", width: "42%", top: 14, height: 208, borderRadius: 16, border: `1px solid ${vmBorder}`, background: "#050505", transition: "border-color .3s", overflow: "hidden" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}><Ico d={IC.box} color="#A1A1A1" size={14} /> Sandbox VM {cpu !== null && <span className="faint">· {cpu} vCPU</span>}</span>
                      <span className={`pill ${vmPc}`}>{vmState}</span>
                    </div>
                    <div style={{ padding: "8px 12px", height: 104, overflow: "hidden" }}>
                      {procs.map((p) => (
                        <div key={p.key} className="in mono" style={{ padding: `2px 0 2px ${p.depth * 14}px`, fontSize: 12, color: p.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.depth ? "└─" : "■"} {p.cmd}</div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6, padding: "0 12px 10px", flexWrap: "wrap" }}>
                      {files.map((f) => (
                        <span key={f.path} className="chip mono" style={{ height: 24, fontSize: 11, borderColor: f.bad ? "rgba(255,149,146,0.45)" : "rgba(255,255,255,0.1)", color: f.bad ? "#FF9592" : "#A1A1A1", background: f.bad ? "rgba(255,149,146,0.08)" : "rgba(255,255,255,0.02)" }}>{f.path}</span>
                      ))}
                    </div>
                  </div>
                  <div aria-hidden="true" style={{ position: "absolute", left: "56%", width: "14%", top: 70, borderTop: `1px solid ${ob ? RED : W}`, transition: "border-color .3s" }} />
                  {packet && <span aria-hidden="true" className="packet" style={{ position: "absolute", top: 66, left: "57%", width: 9, height: 9, borderRadius: "50%", background: "#FF9592" }} />}
                  <span className="mono" style={{ position: "absolute", left: "57%", top: 50, fontSize: 10, whiteSpace: "nowrap", color: ob ? "#FF9592" : "#4A4A4A" }}>{ob ? `${ob.data.method ?? ob.data.proto.toUpperCase()} · ${fmtBytes(ob.data.req_bytes)}` : "outbound"}</span>
                  <span className="mono" style={{ position: "absolute", left: "57%", top: 78, fontSize: 10, whiteSpace: "nowrap", color: ob ? "#FF9592" : "#4A4A4A" }}>{ob ? ob.data.host : ""}</span>
                  <div aria-hidden="true" style={{ position: "absolute", left: "56%", width: "14%", top: 170, borderTop: `1px solid ${rg ? "rgba(61,214,140,0.6)" : W}`, transition: "border-color .3s" }} />
                  <span className="mono" style={{ position: "absolute", left: "57%", top: 150, fontSize: 10, whiteSpace: "nowrap", color: rg ? "#3DD68C" : "#4A4A4A" }}>{rg ? `${rg.data.method ?? rg.data.proto.toUpperCase()} · passed` : "registry"}</span>
                  <span className="mono" style={{ position: "absolute", left: "57%", top: 178, fontSize: 10, whiteSpace: "nowrap", color: rg ? "#3DD68C" : "#4A4A4A" }}>{rg ? rg.data.host : ""}</span>
                  <div style={{ position: "absolute", left: "70%", width: "15%", top: 30, height: 176, borderRadius: 14, border: `1px solid ${packet ? RED : rg ? "rgba(61,214,140,0.6)" : W}`, background: "#0A0A0A", padding: 12, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, transition: "border-color .3s" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}><Ico d={IC.shield} color="#A1A1A1" /> Forge</span>
                    <span className="faint" style={{ fontSize: 12, lineHeight: 1.4 }}>Answers every call with a fake reply</span>
                    <span className="mono" style={{ marginTop: 8, fontSize: 22, fontWeight: 500 }}>{calls.length}</span>
                    <span className="faint" style={{ fontSize: 11 }}>calls answered</span>
                  </div>
                  <div aria-hidden="true" style={{ position: "absolute", left: "85%", width: "3%", top: 118, borderTop: "1px dashed rgba(255,255,255,0.14)", transition: "border-color .3s" }} />
                  <span aria-hidden="true" style={{ position: "absolute", left: "85.9%", top: 110, color: "#FF9592", fontSize: 14, lineHeight: 1 }}>×</span>
                  <div style={{ position: "absolute", left: "88%", width: "12%", top: 82, height: 72, borderRadius: 14, border: "1px solid rgba(255,255,255,0.08)", background: "#0A0A0A", padding: 12, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, transition: "border-color .3s" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}><Ico d="M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" color="#8A8A8A" size={14} /> Internet</span>
                    <span className="faint" style={{ fontSize: 11 }}>{egressFailed ? "containment check failed" : "never reached"}</span>
                  </div>
                </div>
                </div>
              </div>
              <div className="cols">
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  <div className="card" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                    <div className="card-h"><span className="card-t"><CardIcon d={IC.term} color="#70B8FF" />What it is doing</span><span className="mono faint" style={{ fontSize: 12 }}>{rows.length} events</span></div>
                    <div role="log" aria-live="polite" style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "18px 18px 0", WebkitMaskImage: "linear-gradient(180deg, #000 80%, transparent)", maskImage: "linear-gradient(180deg, #000 80%, transparent)" }}>
                      {rows.length === 0 && <p className="faint" style={{ margin: "0 0 18px", fontSize: 13 }}>Waiting for the first event…</p>}
                      {rows.map((e) => (
                        <div key={e.seq} className="in" style={{ position: "relative", display: "flex", gap: 14, paddingBottom: 18 }}>
                          <span aria-hidden="true" style={{ position: "absolute", left: 15.5, top: 36, bottom: -2, width: 1, background: "rgba(255,255,255,0.1)" }} />
                          <span className="node" style={{ borderColor: `${TONE[e.pc]}55` }}><Ico d={e.icon} color={TONE[e.pc] ?? "#A1A1A1"} /></span>
                          <div style={{ minWidth: 0, flex: 1, paddingTop: 4 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span className={`pill ${e.pc}`}>{e.pt}</span><span className="mono faint" style={{ fontSize: 12 }}>{e.t}</span></div>
                            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 14, color: "#A1A1A1", lineHeight: 1.6 }}><span>{e.text}</span></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="rcol">
                  <div className="card" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                    <div className="card-h"><span className="card-t"><CardIcon d={IC.spark} color="#BAA7FF" />Jev <span className="faint" style={{ fontWeight: 400 }}>· decision model</span></span><span className="mono faint" style={{ fontSize: 12 }}>{jev.length}</span></div>
                    <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "2px 16px 4px" }}>
                      {jev.length === 0 && <p className="faint" style={{ margin: "10px 0", fontSize: 13 }}>Waits for the evidence, then answers the questions.</p>}
                      {jev.map((q) => (
                        <div key={q.key} className="in" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                          <div style={{ minWidth: 0, fontSize: 13, color: "#F0F0F0", overflowWrap: "anywhere" }}>{q.q}</div>
                          <span className={`pill ${q.pc}`}>{q.a}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ flex: "none", borderTop: "1px solid rgba(255,255,255,0.08)", padding: "10px 16px 12px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><span className="card-t"><CardIcon d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" color="#FF8DCC" />Luna <span className="faint" style={{ fontWeight: 400 }}>· writes the report</span></span><span className="faint" style={{ fontSize: 12 }}>{!luna ? "Waiting" : lunaTyping ? "Writing" : "Done"}</span></div>
                      <p style={{ margin: "8px 0 0", minHeight: 42, fontSize: 13, lineHeight: 1.6, color: "#A1A1A1" }}>{luna ? lunaShown : "Starts writing once the score is in."}{lunaTyping && <span className="caret" aria-hidden="true" style={{ height: 13, width: 6 }} />}</p>
                    </div>
                  </div>
                </div>
              </div>
          </>
        </main>
        {ADS_ENABLED && <aside className="side" aria-label="Sponsored"><BannerAd runId={runId} n={3} /></aside>}
      </div>
    </div>
  );
}
