"use client";

/**
 * /app/scan/<runId> (p3/App.dc.html, scan view): while running, the live event
 * log, stages and timer on the left and the video ad with five checks on the
 * right; when done, the result opens by itself on the same page. `?replay=1`
 * replays the stored events at speed with the ad and ends on the same result.
 * Every field comes from the run's events and the stored report; nothing is
 * written by hand here.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { liveScan, startScan, subscribeLive } from "@/lib/cr/scan-client";
import type { ReportPayload, ScanEvent, StageName } from "@/lib/engine/types";
import { TONE_STYLE, toneOf } from "@/lib/cr/verdict";
import { plainLog, STAGE_WORD } from "@/lib/cr/plain-log";
import { evidenceLines, notVerifiedBullets, plainTitle, reputationChips } from "@/lib/cr/result-format";
import { useAppSession } from "./AppShell";
import { VerdictGlyph } from "./Board";
import { BannerAd, Interstitial, ScanAd } from "./Ads";
import { ContinueCard } from "./ContinueCard";
import s from "./app.module.css";

// One bar per group of STAGE_BUCKET: fetch, read the code (reach map, malware lookup), install and run, code checks, score.
const STAGES = ["Fetching", "Reading", "Installing", "Checking", "Scoring"] as const;
const STAGE_BUCKET: Record<StageName, number> = { cache: 0, resolve: 0, fetch: 0, verify: 0, reach: 1, osv: 1, detonate: 2, static: 3, checks: 3, score: 4, report: 4, persist: 4 };

const CHECKS: { label: string; stages: StageName[] }[] = [
  { label: "Malware database", stages: ["osv"] },
  { label: "Install scripts", stages: ["detonate"] },
  { label: "Network calls", stages: ["detonate"] },
  { label: "Files outside the project", stages: ["detonate"] },
  { label: "Code checks", stages: ["static", "checks"] },
];

/** The engine's typed summary of what the scan ran (ReportPayload.ran); every field may be unknown (null). */
interface RanSummary {
  package_manager: string | null;
  installed: number | null;
  skipped: number | null;
  install_ms: number | null;
  install_scripts: number | null;
  network: { kind: "registry_only" } | { kind: "forged"; calls: number } | { kind: "none" } | null;
  entry_point: { command: string; exit_code: number | null } | null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The sandbox starts the entry point through `env -i KEY=value ... <command>`, and
 * the engine's capture can cut that line short. The row shows only what follows
 * the last KEY=value setting; when nothing does, the command is unknown (null)
 * and the row leaves it out. Nothing is added.
 */
export function entryCommand(raw: string): string | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== "env") return parts.length ? parts.join(" ") : null;
  let last = 0;
  parts.forEach((t, i) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) last = i;
  });
  const cmd = parts.slice(last + 1).filter((t) => !/^-/.test(t));
  return last > 0 && cmd.length ? cmd.join(" ") : null;
}

/**
 * The design's four labelled rows, always all four. Values come from the engine's
 * `ran` summary and the detonate stage's own outcome (install timed out, entry
 * skipped); a value the run did not record says "Not recorded".
 */
function ranSummaryRows(r: RanSummary | undefined, outcome: { installTimedOut: boolean; entrySkipped: boolean }): { k: string; v: string }[] {
  const pm = r ? [r.package_manager, r.installed !== null ? `${r.installed} installed` : null, r.skipped !== null ? `${r.skipped} skipped` : null].filter(Boolean).join(", ") : "";
  const secs = r?.install_ms != null ? Math.round(r.install_ms / 1000) : null;
  const scripts = r?.install_scripts != null ? (r.install_scripts === 0 ? "no install scripts" : plural(r.install_scripts, "install script", "install scripts")) : null;
  const install = outcome.installTimedOut ? (secs !== null ? `Timed out at ${secs} s` : "Timed out") : [secs !== null ? `${(r!.install_ms! / 1000).toFixed(1)} s` : null, scripts].filter(Boolean).join(", ");
  const net = r?.network ? (r.network.kind === "registry_only" ? "Registry traffic only" : r.network.kind === "none" ? "No network calls" : `${plural(r.network.calls, "call", "calls")}, answered by the forge`) : "";
  let entry = "";
  if (outcome.entrySkipped) entry = "Not run";
  else if (r?.entry_point) {
    const cmd = entryCommand(r.entry_point.command);
    const exit = r.entry_point.exit_code === null ? null : `exit ${r.entry_point.exit_code}`;
    entry = [cmd, exit].filter(Boolean).join(", ") || "Ran";
  }
  return [
    { k: "Package manager", v: pm || "Not recorded" },
    { k: "Install", v: install || "Not recorded" },
    { k: "Network", v: net || "Not recorded" },
    { k: "Entry point", v: entry || "Not recorded" },
  ];
}

interface RunReport { run_id: string; subject: string; commit_sha: string; status: "running" | "done" | "error"; error_code: string | null; started_at: string; finished_at: string | null; report: (Omit<ReportPayload, "ran"> & { luna_report?: { what_ran: string; what_matters: string }; ran?: RanSummary }) | null; report_created_at: string | null }



/** A git SHA shows 7 characters; an npm "version+integrity" shows the version. */
function shortSha(sha: string): string {
  if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 7);
  const version = sha.split("+")[0] ?? sha;
  return version.length > 24 ? `${version.slice(0, 24)}…` : version;
}
function subjectName(subject: string): string {
  return subject.startsWith("npm:") ? subject.slice(4) : subject;
}
function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function ScanView({ runId, full = false }: { runId: string; full?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const replay = params.get("replay") === "1";
  // Every scan started from the paste box plays at its recorded pace; Watch how it happened plays at `speed`.
  const speed = replay ? Math.min(20, Math.max(1, Number(params.get("speed") ?? "4") || 4)) : 1;
  const [startedHere] = useState(() => !replay && !!liveScan(runId));
  const paced = replay || startedHere;
  const { session, ready } = useAppSession();

  const [run, setRun] = useState<RunReport | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [playNow, setPlayNow] = useState(0);
  const [playBase, setPlayBase] = useState<number | null>(null);
  const [playDone, setPlayDone] = useState(false);
  const [toast, setToast] = useState("");
  const baseRef = useRef<number | null>(null);
  const eventsRef = useRef<ScanEvent[]>([]);
  const runRef = useRef<RunReport | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
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
    if (replay) return;
    const l = liveScan(runId);
    if (!l) return;
    const sync = () => {
      addEvents(l.events);
      if (l.final?.type === "result") {
        const rep = l.final.report;
        setRun((prev) => ({ run_id: runId, subject: prev?.subject ?? rep.target, commit_sha: rep.commit_sha, status: "done", error_code: null, started_at: prev?.started_at ?? new Date().toISOString(), finished_at: new Date().toISOString(), report: rep, report_created_at: new Date().toISOString() }));
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
  }, [runId, replay, addEvents, loadRun, loadEvents]);

  // Stored state: the run, its events, and Realtime while it is running (reconnects pick up by seq).
  useEffect(() => {
    let stop = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let supabase: ReturnType<typeof createClient> | null = null;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    (async () => {
      const r = await loadRun();
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
        } else {
          loadEvents();
        }
      }, 2500);
    })();
    return () => {
      stop = true;
      if (poll) clearInterval(poll);
      if (supabase && channel) supabase.removeChannel(channel);
    };
  }, [runId, replay, loadRun, loadEvents, addEvents]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // Playback clock. A paste-box scan plays against the moment its first event
  // arrived (minus that event's t_ms), so a fresh scan shows events as they come
  // and a scan whose events arrive at once plays at the recorded pace. A replay
  // starts when the stored events are loaded. The result opens after the last event.
  // Ticked by a 100 ms interval, not requestAnimationFrame: a frame requested while
  // the tab is in the background can be dropped, which froze the replay at its first
  // frame; an interval always fires (throttled in the background, never lost).
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
      const evs = eventsRef.current;
      const last = evs[evs.length - 1]?.t_ms ?? 0;
      const r = runRef.current;
      if (base !== null && r?.report && r.status === "done" && (t - base) * speed >= last + 800) {
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
  const failed = run?.status === "error" && !replay;
  const running = !done && !failed;
  // The install reached its time limit, as far as the scan has played: the sandbox
  // prints "install-at-limit" and holds the install for 15 s while the card asks, so a
  // Yes keeps the same run installing. A stored or replayed run that timed out asks too.
  // `?test_card=1` (never in production) asks as soon as the install starts, to test
  // the card on a repo whose install finishes inside the limit.
  const testCard = params.get("test_card") === "1" && process.env.NEXT_PUBLIC_VERCEL_ENV !== "production";
  const installHitLimit = useMemo(
    () =>
      visible.some(
        (e) =>
          (e.type === "transcript" && /install-at-limit/.test(e.data.text)) ||
          (e.type === "stage" && e.data.name === "detonate" && (testCard || (e.data.status !== "start" && /install timeout/i.test(e.data.detail ?? "")))),
      ),
    [visible, testCard],
  );
  // While the scan runs, a heartbeat every 10 s keeps a full scan's sandboxes alive
  // (POST /api/scan/<id>/heartbeat); a closed tab lets them stop within 30 s.
  useEffect(() => {
    if (!running) return;
    const beat = () => void fetch(`/api/scan/${runId}/heartbeat`, { method: "POST", headers: { "x-clauderabbit-client": "web" }, keepalive: true }).catch(() => {});
    beat();
    const id = setInterval(beat, 10_000);
    return () => clearInterval(id);
  }, [running, runId]);
  const subject = run?.subject ?? null;
  const fullFired = useRef(false);
  useEffect(() => {
    // Yes on the continue card (/app/scan/<id>/full): the running scan keeps installing,
    // same run id. A run whose install already finished as a partial scan gets a full
    // scan instead (a stored full one plays back, or one runs).
    if (!full || !subject || !ready || fullFired.current) return;
    fullFired.current = true;
    let off = false;
    (async () => {
      const r = await fetch(`/api/scan/${runId}/continue`, { method: "POST", headers: { "x-clauderabbit-client": "web" } }).catch(() => null);
      const continued = r?.ok ? (((await r.json().catch(() => ({}))) as { continued?: number }).continued ?? 0) : 0;
      if (off) return;
      if (continued > 0 || run?.status === "running") return router.replace(`/app/scan/${runId}`);
      const { runId: id } = await startScan(subject, session?.access_token ?? null, true);
      if (!off) router.replace(`/app/scan/${id}`);
    })().catch((e: unknown) => !off && setToast(e instanceof Error ? e.message : "The full scan did not start."));
    return () => {
      off = true;
    };
  }, [full, subject, ready, session, router, runId, run?.status]);

  useEffect(() => {
    if (!running || paced) return;
    const id = setInterval(() => setClockNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running, paced]);

  const stageState = useMemo(() => {
    const started = new Set<StageName>();
    const finished = new Set<StageName>();
    let current: StageName | null = null;
    for (const e of visible) {
      if (e.type !== "stage") continue;
      if (e.data.status === "start") {
        started.add(e.data.name);
        current = e.data.name;
      } else finished.add(e.data.name);
    }
    const buckets = STAGES.map((_, i) => {
      const names = (Object.keys(STAGE_BUCKET) as StageName[]).filter((n) => STAGE_BUCKET[n] === i);
      const st = names.filter((n) => started.has(n) || finished.has(n));
      if (st.length === 0) return 0;
      const fin = names.filter((n) => finished.has(n)).length;
      return fin >= st.length ? 100 : 50;
    });
    return { current, finished, buckets };
  }, [visible]);

  const log = useMemo(() => plainLog(visible).slice(-14), [visible]);
  const lastT = visible[visible.length - 1]?.t_ms ?? 0;
  const liveMs = playMs !== null ? playMs : paced ? 0 : run && running ? Math.max(lastT, clockNow - Date.parse(run.started_at)) : lastT;
  const report = run?.report ?? null;
  const totalMs = report ? (report.timings?.total_ms ?? report.timings?.total ?? (run?.finished_at && run.started_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : lastT)) : lastT;

  const share = async () => {
    const url = `${location.origin}/app/scan/${runId}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: `ClaudeRabbit: ${run ? subjectName(run.subject) : "scan"}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setToast("Link copied");
    } catch {
      setToast(url);
    }
    setTimeout(() => setToast(""), 2400);
  };

  if (notFound) {
    return (
      <div style={{ borderRadius: 28, background: "var(--surface)", padding: "clamp(24px,3vw,36px)", display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
        <h1 style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: "-0.035em" }}>This scan was not found.</h1>
        <Link href="/app" className={`${s.press} ${s.solid}`} style={{ height: 48, padding: "0 22px", borderRadius: 999, background: "var(--inv)", color: "var(--on-inv)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center" }}>Scan another</Link>
      </div>
    );
  }

  const tone = report ? TONE_STYLE[toneOf(report.verdict)] : null;
  const deductions = (report?.breakdown ?? []).filter((d) => d.points < 0 && d.group !== "reputation").sort((a, b) => a.points - b.points);
  const paragraphs = report?.luna_report ? [report.luna_report.what_ran, report.luna_report.what_matters].filter(Boolean) : report?.summary ? [report.summary] : [];
  const repFacts = report?.reputation_section?.facts ?? [];
  const repWarnings = report?.reputation_section?.warnings ?? [];
  const detonateDetail = [...events].reverse().find((e) => e.type === "stage" && e.data.name === "detonate" && e.data.status !== "start");
  const dd = detonateDetail && detonateDetail.type === "stage" ? (detonateDetail.data.detail ?? "") : "";
  const outcome = { installTimedOut: /install timeout/i.test(dd), entrySkipped: /entry skipped/i.test(dd) };
  const ranRows = report?.ran || outcome.installTimedOut || outcome.entrySkipped ? ranSummaryRows(report?.ran, outcome) : [];
  const ranLines = ranRows.length === 0 ? (report?.evidence?.behaviour ?? []) : [];
  const nv = notVerifiedBullets(report?.not_verified ?? []);
  const repChips = reputationChips(report?.reputation_section?.facts ?? []);

  return (
    <div className={s.scanGrid}>
      <section aria-label={run ? subjectName(run.subject) : "Scan"} className={s.col} style={{ flex: "1 1 540px", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {(
            <button type="button" className={`${s.btn} ${s.press} ${s.ghost}`} onClick={() => router.push("/app")} aria-label="Back to the danger board" style={{ width: 48, height: 48, marginLeft: -12, borderRadius: 999, display: "grid", placeItems: "center", flex: "none" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5" /></svg>
            </button>
          )}
          <h1 className={s.h1} style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 30, lineHeight: 1.1, fontWeight: 600, letterSpacing: "-0.035em", overflowWrap: "anywhere" }}>{run ? subjectName(run.subject) : "Starting…"}</h1>
          <span className={s.mono} title={run?.commit_sha} style={{ flex: "none", maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", fontSize: 13, color: "var(--text2)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{run ? shortSha(run.commit_sha) : ""}</span>
        </div>

        {running && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 17, fontWeight: 600, flexWrap: "wrap" }}>
                <span className={s.pulse} style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--acc)" }} />
                {stageState.current ? STAGE_WORD[stageState.current] : "Starting a fresh machine"}
                {replay && <span style={{ height: 26, padding: "0 10px", borderRadius: 999, background: "#1B77F31A", color: "#1259C3", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center" }}>Replay</span>}
              </span>
              <span style={{ fontSize: 44, lineHeight: 1, fontWeight: 600, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>{secs(liveMs)}</span>
            </div>
            <div style={{ display: "flex", gap: 6 }} aria-label="Stages">
              {STAGES.map((name, i) => (
                <div key={name} title={name} style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 999, background: "var(--inv)", width: `${stageState.buckets[i]}%`, transition: "width 250ms cubic-bezier(0.2,0,0,1)" }} />
                </div>
              ))}
            </div>
            {/* Under the progress, above the log: it never covers the bars, checks or log. */}
            <BannerAd runId={runId} n={1} />
            <div role="log" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 4, minHeight: 360 }}>
              {log.length === 0 && <div style={{ padding: "10px 14px", fontSize: 15, color: "var(--text2)" }}>Waiting for the first event…</div>}
              {log.map((e) => (
                <div key={e.seq} className={s.logIn} style={{ display: "flex", gap: 14, padding: "10px 14px", borderRadius: 14, background: e.tone === "bad" ? "var(--bad-tint)" : e.tone === "warn" ? "var(--warn-tint)" : "transparent" }}>
                  <span style={{ width: 48, flex: "none", fontSize: 13, color: "var(--text2)", fontVariantNumeric: "tabular-nums", paddingTop: 2 }}>{secs(e.at)}</span>
                  <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", marginTop: 7, background: e.tone ? TONE_STYLE[e.tone].dot : "var(--text3)" }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 1.4, fontWeight: e.tone === "bad" ? 600 : 400, overflowWrap: "anywhere" }}>{e.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {failed && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" }}>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.5 }}>This scan stopped before it finished ({run?.error_code ?? "error"}). No score was given.</p>
            <Link href="/app" className={`${s.press} ${s.solid}`} style={{ height: 48, padding: "0 22px", borderRadius: 999, background: "var(--inv)", color: "var(--on-inv)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center" }}>Scan another</Link>
          </div>
        )}

        {done && report && tone && (
          <div className={s.pop} style={{ display: "flex", flexDirection: "column", gap: 18, paddingTop: 10 }}>
            <div style={{ display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: "12px 18px" }}>
              <span className={s.bigScore}>{report.score}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 40, padding: "0 16px", borderRadius: 999, fontSize: 17, fontWeight: 600, ...tone.pill }}><VerdictGlyph verdict={report.verdict} />{report.verdict}</span>
              {report.partial && <span style={{ display: "inline-flex", alignItems: "center", height: 32, padding: "0 12px", borderRadius: 999, background: "var(--muted)", color: "var(--text)", fontSize: 14, fontWeight: 600 }}>Partial scan</span>}
              <span style={{ fontSize: 14, color: "var(--text2)", marginBottom: 8, fontVariantNumeric: "tabular-nums" }}>{Math.max(1, Math.round(totalMs / 1000))} s</span>
            </div>
            {report.partial && report.partial_reason && <span style={{ fontSize: 15, lineHeight: 1.45, color: "var(--text2)" }}>{report.partial_reason}.</span>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "20px 22px", borderRadius: 20, background: "var(--card)", boxShadow: "0 0 0 1px var(--border)" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text2)" }}>Report</span>
              {paragraphs.map((p, i) => <p key={i} style={{ margin: 0, fontSize: 16.5, lineHeight: 1.55 }}>{p}</p>)}
            </div>
            {(
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                <button type="button" className={`${s.btn} ${s.press} ${s.solid}`} onClick={share} style={{ height: 48, padding: "0 22px", borderRadius: 999, background: "var(--inv)", color: "var(--on-inv)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V4" /><path d="M8.5 7.5L12 4l3.5 3.5" /><path d="M8 11H6.5A1.5 1.5 0 005 12.5v6A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5v-6a1.5 1.5 0 00-1.5-1.5H16" /></svg>Share
                </button>
                <button type="button" onClick={() => router.push(`/app/scan/${runId}?replay=1&r=${Date.now()}`)} className={`${s.btn} ${s.press} ${s.ghost}`} style={{ height: 48, padding: "0 20px", borderRadius: 999, boxShadow: "inset 0 0 0 1.5px var(--text)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" /></svg>Watch how it happened
                </button>
                <Link href="/app" className={`${s.press} ${s.ghost}`} style={{ height: 48, padding: "0 22px", borderRadius: 999, boxShadow: "inset 0 0 0 1.5px var(--text)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center" }}>Scan another</Link>
                {ready && !session && (
                  <Link href="/login" style={{ fontSize: 14, color: "var(--text2)", marginLeft: 6, minHeight: 48, display: "inline-flex", alignItems: "center" }}>
                    <span style={{ color: "var(--text)", fontWeight: 600, textDecoration: "underline" }}>Sign in</span>&nbsp;to save this scan.
                  </Link>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className={s.col} style={{ flex: "1 1 420px", gap: 22 }}>
        {/* The card outlives the running screen: its 15 s answer window runs on after the result opens. */}
        <ContinueCard runId={runId} show={installHitLimit && !full} />
        {/* Defined for the page's whole life, before Yes is clicked: GPT shows it on the navigation to /full. */}
        <Interstitial runId={runId} />
        {running && (
          <>
            <ScanAd key={`${runId}-${replay ? "replay" : "live"}`} runId={runId} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              {CHECKS.map((c) => {
                const ok = c.stages.every((n) => stageState.finished.has(n));
                return (
                  <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 46, borderTop: "1px solid var(--border)" }}>
                    <span style={{ width: 18, height: 18, flex: "none", display: "grid", placeItems: "center", color: ok ? "var(--ok-text)" : "var(--text3)" }}>
                      {ok ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      ) : (
                        <svg className={s.spin} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="30 12" strokeLinecap="round" /></svg>
                      )}
                    </span>
                    <span style={{ flex: 1, fontSize: 15, color: ok ? "var(--text)" : "var(--text2)" }}>{c.label}</span>
                  </div>
                );
              })}
            </div>
            <BannerAd runId={runId} n={2} />
            <BannerAd runId={runId} n={3} />
          </>
        )}

        {done && report && (
          <div className={s.blurIn} style={{ animationDelay: "150ms", display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 600 }}>Points taken off</h2>
              {deductions.length === 0 && (
                <div style={{ display: "flex", gap: 12, padding: "14px 0", borderBottom: "1px solid var(--border)", fontSize: 15, lineHeight: 1.4 }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>None
                </div>
              )}
              {deductions.map((d, i) => (
                <div key={`${d.code}-${i}`} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ width: 38, flex: "none", fontSize: 16, fontWeight: 600, color: "var(--bad-text)", fontVariantNumeric: "tabular-nums" }}>{d.points}</span>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                    <span style={{ fontSize: 15, lineHeight: 1.4, fontWeight: 500 }}>{plainTitle(d.detail)}</span>
                    {(() => {
                      const ev = evidenceLines(d.evidence);
                      return ev.lines.length > 0 ? (
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          {ev.lines.map((l, j) => <code key={j} className={s.mono} style={{ fontSize: 12.5, color: "var(--text2)", overflowWrap: "anywhere" }}>{l}</code>)}
                          {ev.more > 0 && <span style={{ fontSize: 12.5, color: "var(--text3)" }}>+{ev.more} more</span>}
                        </span>
                      ) : null;
                    })()}
                  </span>
                </div>
              ))}
            </div>
            {(ranRows.length > 0 || ranLines.length > 0) && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <h2 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 600 }}>What it ran</h2>
                {ranRows.map((row) => (
                  <div key={row.k} style={{ display: "flex", gap: 16, padding: "10px 0", borderBottom: "1px solid var(--border)", fontSize: 14, lineHeight: 1.4 }}>
                    <span style={{ flex: "0 0 120px", color: "var(--text2)" }}>{row.k}</span>
                    <span style={{ flex: 1, minWidth: 0, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{row.v}</span>
                  </div>
                ))}
                {ranLines.map((line, i) => (
                  <div key={i} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)", fontSize: 14, lineHeight: 1.4, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{line}</div>
                ))}
              </div>
            )}
            {nv.shown.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, lineHeight: 1.45, color: "var(--text2)" }}>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>Not verified</span>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {nv.shown.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
                {nv.more.length > 0 && (
                  <details>
                    <summary style={{ cursor: "pointer", minHeight: 32, display: "flex", alignItems: "center", fontWeight: 500, color: "var(--text)" }}>More</summary>
                    <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                      {nv.more.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Reputation <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text2)" }}>shown separately</span></h2>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {repChips.length === 0 && repWarnings.length === 0 && <span style={{ fontSize: 14, color: "var(--text2)" }}>No reputation facts were recorded for this scan.</span>}
                {repChips.map((c, i) => (
                  <span key={`f${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 8, minHeight: 32, padding: "4px 12px", borderRadius: 999, background: "var(--card)", boxShadow: "0 0 0 1px var(--border)", fontSize: 13, fontWeight: 500 }}>
                    {c.text}
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text3)" }}>{c.source}</span>
                  </span>
                ))}
                {repWarnings.map((w, i) => (
                  <span key={`w${i}`} style={{ display: "inline-flex", alignItems: "center", minHeight: 32, padding: "4px 12px", borderRadius: 999, background: "var(--card)", boxShadow: "0 0 0 1px var(--border)", fontSize: 13, fontWeight: 500, color: "var(--warn-text)" }}>{w}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
      <div role="status" aria-live="polite" style={{ position: "fixed", left: 16, right: 16, bottom: 24, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 60 }}>
        {toast && <div className={s.logIn} style={{ padding: "12px 20px", borderRadius: 999, background: "var(--glass)", backdropFilter: "blur(20px) saturate(180%)", boxShadow: "0 0 0 1px var(--glass-line), 0 10px 30px -14px var(--shadow)", fontSize: 15, fontWeight: 500, overflowWrap: "anywhere" }}>{toast}</div>}
      </div>
    </div>
  );
}
