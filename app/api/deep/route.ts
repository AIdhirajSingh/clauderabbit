/**
 * /api/deep — the INLINE deep-sandbox path (BUG-INLINE-MOAT).
 *
 * When the fast path trips the escalation gate, the browser calls this route and
 * watches a Cloud Run Job execution (one execution per scan, Gen2 — Jobs only run
 * Gen2, there is no flag to set) clone the repo, run the 3-agent OpenCode
 * exploration pass, detonate the code, and report its own forensic record. Every
 * containment invariant now lives in the Direct-VPC-Egress + forced-route + NVA
 * gateway architecture (see sandbox/cloudrun/forge/ + docs/INFRASTRUCTURE.md), not
 * in a per-run Firecracker microVM — Cloud Run's own container boundary + the
 * custom route to cr-forge-gateway (10.200.0.10) IS the isolation now. The
 * container's own entrypoint (sandbox/cloudrun/harness/) POSTs its forensic record
 * to attach-forensics directly (it already has network egress, routed through the
 * same forge); this route triggers the execution, waits for it, and CONFIRMS the
 * attach genuinely landed before telling the client "persisted" — it does not
 * blindly trust the container's own exit code as proof the report was updated.
 *
 * CONCURRENCY + QUEUE — MAX_CONCURRENT bounds simultaneous executions this
 * controller will trigger at once (see Unit 16 / docs/INFRASTRUCTURE.md for the
 * real Cloud Run concurrent-execution ceiling this is tuned against). A request
 * over the cap QUEUES: the connection stays open and streams an honest
 * `{t:"stage", ch:"Queue", ...}` line ("Queued — position N of M, ~X min") while it
 * polls for a free slot in strict FIFO order, then proceeds through the exact same
 * detonation path once admitted. If it cannot get a slot within QUEUE_MAX_WAIT_MS it
 * ends with a clear, specific "sandbox was too busy" error — never a silent drop.
 * The in-process `inFlight` counter remains the sole slot arbiter (single Node
 * process, race-free); the `deep_scan_queue` table + `lib/deep-queue.ts` provide the
 * FIFO ordering, honest position/estimate, and observability. See lib/deep-queue.ts.
 *
 * SAFETY — this route spawns gcloud, so it is a privileged local-controller
 * capability, NOT a public surface. It is hard-gated fail-closed:
 *   1. CR_ALLOW_LOCAL_DEEP=1 must be set (off by default → inert on Vercel).
 *   2. The request Host/Origin must be localhost (no remote caller).
 *   3. gcloud must be present on the machine (the sandbox controller).
 *   4. An in-process concurrency cap honours the Cloud Run Job's real ceiling.
 * owner/repo/sha are validated against strict charsets and passed as a Cloud Run
 * per-EXECUTION env var override (`--update-env-vars` on `execute` merges into one
 * execution's env, it does NOT mutate the job's stored template — confirmed
 * against `gcloud run jobs execute --help` — so concurrent scans never race each
 * other's inputs), never interpolated into a shell string.
 */

import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  deepScanQueue,
  isExpired,
  queueLine,
  type QueueStanding,
} from "@/lib/deep-queue";
import { enqueueRow, fetchPosition, fetchStage, setStatus } from "@/lib/deep-queue-client";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { fetchLatestReport } from "@/lib/report-fetch";

// Real, live-diagnosed bug (a scan reporting "forensic record was not
// confirmed" despite the write genuinely landing — verified directly against
// the database): lib/supabase/server.ts's createClient() calls Next's
// cookies() API, which is only valid inside an active per-request Async Local
// Storage context. confirmForensicsAttached() below runs from a
// child_process's "close" event — a raw Node event-emitter callback, not part
// of Next's own request instrumentation — that can fire 60-150s after the
// original request, well outside that context. cookies() then throws,
// createClient() rejects, the outer `.catch(() => null)` swallows it, and
// EVERY confirmation attempt silently returns false — never because the read
// failed, but because the client was never even constructed. This read is
// anonymous and public (same RLS-exposed report row the SSR page and the SPA
// already read anonymously) and never needs a session or cookies, so it needs
// a plain, context-free client, not the cookie-coupled one.
const CONFIRM_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const CONFIRM_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Privileged local capability: a real Node child process + filesystem. Never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── server-only config ───────────────────────────────────────────────────────
// Note: CR_DEEP_RUNNER_KEY is no longer read here — the Cloud Run execution's
// OWN entrypoint POSTs to attach-forensics directly, using its own copy of that
// secret (injected via a Secret Manager reference at Job deploy time). This
// controller process only triggers + confirms the execution.
const REPO_ROOT = process.cwd();
// The Cloud Run Job this route triggers one execution of per scan.
const RUN_JOB_NAME = process.env.CR_RUN_JOB_NAME ?? "cr-detonation";
const RUN_REGION = process.env.CR_RUN_REGION ?? "us-central1";

// The dev/controller process may be launched with a narrower PATH than an
// interactive shell — this repo is checked out into many separate worktrees, each
// with its OWN gitignored .env.local, so a fix recorded as "set CR_BASH in
// .env.local" silently regresses in every checkout that doesn't happen to have
// that line. CR_BASH / CR_SANDBOX_PATH_PREPEND remain a supported override for an
// unusual machine, but the real fix has to work with NEITHER set: probe the
// standard install locations directly (verified to exist on disk) before ever
// falling back to a bare command name that depends on the inherited PATH.
const WIN32_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

function resolveBash(): string {
  if (process.env.CR_BASH) return process.env.CR_BASH;
  if (process.platform === "win32") {
    for (const candidate of WIN32_BASH_CANDIDATES) {
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* keep probing */
      }
    }
  }
  return "bash";
}

function resolvePathPrepend(): string {
  if (process.env.CR_SANDBOX_PATH_PREPEND) return process.env.CR_SANDBOX_PATH_PREPEND;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const candidate = `${process.env.LOCALAPPDATA}\\Google\\Cloud SDK\\google-cloud-sdk\\bin`;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* fall through */
    }
  }
  return "";
}

const BASH = resolveBash();
const PATH_PREPEND = resolvePathPrepend();

/** Child env with the configured tool dirs prepended to PATH (or the inherited env). */
function childEnv(): NodeJS.ProcessEnv {
  if (!PATH_PREPEND) return process.env;
  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH || "";
  return { ...process.env, PATH: current ? `${PATH_PREPEND}${sep}${current}` : PATH_PREPEND };
}

// owner / repo segment — same charset as orchestrate's guard and attach-forensics.
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;
// commit SHA — the STRICTER attach-forensics charset (no slash), so a valid sha
// here is guaranteed to satisfy the persistence endpoint's own validation. The
// FIRST char must be alphanumeric: a real commit sha always is, and this forbids
// a leading "-" so the value can never be read as a git/gcloud option (it flows
// into `git fetch origin "$REF"` downstream — a leading dash would smuggle a flag).
const SHA_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

// How many Cloud Run executions THIS controller will trigger at once. Cloud
// Run itself allows far more (a 1000-per-project-region default quota on
// concurrent job executions — not the real constraint here). The actual
// bottleneck is the single shared e2-small NVA gateway VM (cr-forge-gateway)
// that ALL concurrent detonations route their egress through (mitmproxy +
// dnsmasq + iptables, one small VM, not per-execution). Proven live (Unit 16,
// docs/INFRASTRUCTURE.md): 3 genuinely concurrent Cloud Run detonations
// (overlapping start/end timestamps, not serialized) completed cleanly, each
// correctly isolated by its own Cloud-Run-assigned source IP
// (10.200.0.192/.193/.194 in the proof run) — the gateway stayed at load
// average ~0.02 with both cr-forge-mitm and cr-forge-api still active
// afterward, well short of its real ceiling. This cap is a deliberate,
// separately-tunable in-process throttle, not a substrate limit — raise it
// again only after a fresh concurrency proof at the higher number, not by
// guessing. Enforced in-process (single Node controller, race-free by construction).
const MAX_CONCURRENT = 3;
let inFlight = 0;

// ── queue tuning (see lib/deep-queue.ts for the ordering/estimate/timeout math) ──
// Per-detonation estimate used ONLY to phrase the queued-wait line ("~X min");
// re-measure against the real deployed Cloud Run architecture (Unit 16) and
// update this once real numbers exist — 90s carries over the old host's
// measured figure as a starting placeholder, not a Cloud Run measurement.
const PER_DETONATION_MS = 90_000;
// Poll cadence while queued. 1s is cheap for a single Node process and surfaces a
// freed slot / changed position within a tick — fast enough to feel live, not busy.
const QUEUE_POLL_MS = 1_000;
// Max time a request may WAIT in the queue before we give up honestly. With 2 slots
// at ~90s each, an 8-minute window lets a request sit behind ~5 detonations' worth
// of work (well beyond the "~2-3 detonations ahead" bar) before timing out. It is
// also comfortably under the client's 20-min DEEP_SCAN_TIMEOUT_MS, so the SERVER
// emits the honest "too busy" timeout event rather than the client aborting blind.
const QUEUE_MAX_WAIT_MS = 8 * 60_000;
// How often to refresh the emitted "position N of M, ~X min" line while waiting.
// Every 5 ticks (~5s) — frequent enough to reflect position changes, infrequent
// enough not to spam the stream with an identical line each second.
const POSITION_REFRESH_TICKS = 5;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A hostname that is unambiguously this machine (no remote caller). */
function isLocalHostname(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(host);
}

/**
 * Fail-closed local gate. Returns an error string to reject with, or null to
 * allow. Off by default (CR_ALLOW_LOCAL_DEEP unset) → this route is inert on any
 * deployment that does not explicitly opt in, removing the RCE/cloud-cost surface.
 */
function localGateError(req: Request): string | null {
  if (process.env.CR_ALLOW_LOCAL_DEEP !== "1") {
    return "deep path disabled (set CR_ALLOW_LOCAL_DEEP=1 on the sandbox controller)";
  }
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!isLocalHostname(host)) return "deep path is localhost-only";
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return "deep path rejects malformed Origin";
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(originHost)) {
      return "deep path is localhost-only (cross-origin rejected)";
    }
  }
  return null;
}

/**
 * Is gcloud available on this machine? (Only the sandbox controller has it.)
 * Checked THROUGH bash — the exact context orchestrate.sh runs in — rather than
 * spawning "gcloud" directly: on Windows gcloud is a `gcloud.cmd` shim that a
 * `shell:false` spawn cannot resolve, so a direct check would wrongly 501 even
 * though orchestrate (run via bash) can call gcloud fine. `command -v` takes no
 * user input, so this fixed bash string is injection-free.
 */
function hasGcloud(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(BASH, ["-c", "command -v gcloud"], {
        stdio: "ignore",
        shell: false,
        env: childEnv(),
      });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

interface Stage {
  ch: string;
  status: "active" | "done";
  kind?: "ok" | "warn" | "bad";
  lines?: string[];
}

// Real, granular detonation progress — replaces the ONE static "Gate tripped —
// dispatching a Cloud Run detonation execution" line that used to sit unmoving
// for the entire ~100-160s real detonation window. The Cloud Run execution's
// own entrypoint (sandbox/cloudrun/harness/entrypoint.sh + detonate.py) reports
// each of these stage names live via deep-queue's set_stage op as it actually
// reaches them (see supabase/migrations/20260703000001_deep_scan_queue_stage.sql);
// this route polls deep-queue's get_stage op and emits a real, distinct
// timeline entry for each one, matching the same honest step-by-step
// visibility the earlier Resolve/Static-scan/Reputation/Read/Verdict/Escalation
// stages already have. Must exactly match supabase/functions/deep-queue/ops.ts's
// STAGES vocabulary — a stage name reported by the container that isn't a key
// here just renders as itself (never dropped, never a UI crash).
const STAGE_LABELS: Record<string, string> = {
  container_start: "Sandbox container starting",
  cloning: "Cloning the repository at the pinned commit",
  installing: "Installing dependencies",
  agents_exploring: "Three agents reading the code in parallel",
  running: "Executing the repository's start command",
  assembling_forensics: "Assembling the forensic record",
  persisting: "Persisting the result to the report",
};
// How often to poll for a new stage during the detonation wait. Cheap for a
// single Node process; frequent enough that the timeline never looks stalled
// for long even between real transitions.
const STAGE_POLL_MS = 2_500;

// Detonation itself can legitimately take several minutes (clone + install +
// agentic pass + run) — this bounds how long we'll wait for the Cloud Run
// execution before giving up honestly, distinct from QUEUE_MAX_WAIT_MS (which
// bounds time spent WAITING for a slot, before the execution even starts).
const DETONATION_MAX_WAIT_MS = 20 * 60_000;
// After the execution reports success, the container's OWN entrypoint already
// POSTed to attach-forensics — confirm that write actually landed (Postgres
// writes are immediately visible; a couple of short retries absorb any
// request-handling latency) rather than trusting the exit code alone.
const ATTACH_CONFIRM_RETRIES = 5;
const ATTACH_CONFIRM_DELAY_MS = 2_000;

/**
 * Confirm the Cloud Run execution's own attach-forensics POST actually landed,
 * by reading the report row back and checking it genuinely carries a forensic
 * record for THIS commit. Never trusts the job's exit code alone — a
 * container that "succeeded" but whose own network POST silently failed must
 * not be reported as persisted.
 *
 * Checks `report.forensics` is present, not just `deep`/`commit_sha` — those
 * two are already true from the INITIAL fast-path escalation insert, before
 * the Cloud Run job ever runs, so checking only them would report "attached"
 * on the very first poll regardless of whether the detonation's own write
 * ever actually landed. Checking the real forensic payload is what makes this
 * a genuine confirmation, not a trivially-true one.
 */
async function confirmForensicsAttached(owner: string, repo: string, sha: string): Promise<boolean> {
  if (!CONFIRM_SUPABASE_URL || !CONFIRM_SUPABASE_ANON_KEY) return false;
  // A plain, context-free client — this read is anonymous and public (same
  // RLS-exposed row the SSR page and SPA already read without a session), and
  // must not depend on Next's per-request cookie context (see the note above
  // createClient as createSupabaseClient — this runs from a detached
  // child_process event callback, not a live request scope).
  const supabase = createSupabaseClient(CONFIRM_SUPABASE_URL, CONFIRM_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (let attempt = 0; attempt < ATTACH_CONFIRM_RETRIES; attempt++) {
    const report = await fetchLatestReport(supabase, owner, repo).catch(() => null);
    if (report && report.deep && report.commit_sha === sha && report.forensics) return true;
    await new Promise((r) => setTimeout(r, ATTACH_CONFIRM_DELAY_MS));
  }
  return false;
}

/** Build a job-execution-safe unique scan id: `[a-z0-9-]{1,40}`, distinct per request. */
function buildSlug(owner: string, repo: string): string {
  const base =
    `${owner}-${repo}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "scan";
  const stamp = Date.now().toString(36).slice(-6);
  // 36^5 (~60M) values, not 36^2 (~1,296): two requests for the same owner/repo
  // in the same millisecond must not collide on this slug, since it also doubles
  // as the FIFO queue token (lib/deep-queue.ts) -- a collision there would make
  // one of them spuriously wait out the full queue timeout despite a free slot.
  const rand = Math.floor(Math.random() * 36 ** 5).toString(36);
  return `${base}-${stamp}${rand}`.slice(0, 40).replace(/-+$/g, "");
}

export function GET(): Response {
  return json({ error: "Method not allowed" }, 405);
}

export async function POST(req: Request): Promise<Response> {
  // 1. fail-closed local gate (flag + localhost host/origin).
  const gateErr = localGateError(req);
  if (gateErr) return json({ error: gateErr }, 403);

  // 2. parse + strictly validate the body (the injection boundary).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const owner = b.owner;
  const repo = b.repo;
  const sha = b.sha;
  // SEGMENT_RE permits dots, so also require at least one alphanumeric char and
  // forbid a leading "-" — this rejects pure-punctuation values like "." / ".." /
  // "--" that the charset alone would let through.
  const isCleanSegment = (v: unknown): v is string =>
    typeof v === "string" && SEGMENT_RE.test(v) && /[A-Za-z0-9]/.test(v) && !v.startsWith("-");
  if (!isCleanSegment(owner)) {
    return json({ error: "invalid owner" }, 400);
  }
  if (!isCleanSegment(repo)) {
    return json({ error: "invalid repo" }, 400);
  }
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    return json({ error: "invalid commit sha" }, 400);
  }

  // 3. gcloud must be present (this is the sandbox controller).
  if (!(await hasGcloud())) {
    return json({ error: "deep path needs gcloud on the sandbox controller" }, 501);
  }

  // 4. A per-request token: FIFO key (in-process), Cloud Run scan id, queue row id.
  const slug = buildSlug(owner, repo);

  // Slot ownership for THIS request. `acquiredSlot` records whether we hold an
  // inFlight slot, so release() decrements exactly once and only when we do.
  let acquiredSlot = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Always drop out of the in-process FIFO queue (a no-op if never/already gone),
    // so a disconnect/timeout/finish can never leave a phantom waiter blocking the
    // head-of-line check for everyone behind it.
    deepScanQueue.remove(slug);
    if (acquiredSlot) {
      acquiredSlot = false;
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  const enc = new TextEncoder();
  let child: ChildProcess | null = null;
  // The REAL run timeline, accumulated as it streams, so the captured record can be
  // persisted with the report (not just shown live then lost). Only genuine run
  // milestones are recorded — the "Persist" and "Queue" bookkeeping stages are
  // excluded (they are emitted straight to the client, never pushed here).
  const timeline: Stage[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Poll handle for the queued-wait loop, cleared on admission/timeout/finish.
      let queueTimer: ReturnType<typeof setInterval> | null = null;
      const clearQueueTimer = () => {
        if (queueTimer) {
          clearInterval(queueTimer);
          queueTimer = null;
        }
      };
      const emit = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* consumer gone; ignore */
        }
      };
      // Stream a run stage to the client AND record it for persistence.
      const recordStage = (st: Stage) => {
        timeline.push(st);
        emit({ t: "stage", ...st });
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearQueueTimer();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        release();
      };
      const killChild = () => {
        try {
          child?.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      };

      /**
       * Spawn the orchestrator and stream its milestones. Called ONLY once a slot
       * is held (acquiredSlot === true) — either immediately (a slot was free) or
       * after the queue admitted this request as the FIFO head. Unchanged from the
       * pre-queue path: same gcloud-over-bash dispatch, same milestone parsing,
       * same forensics-attach + release semantics.
       */
      const startDetonation = async () => {
        // Best-effort: mark the queue row active for observability (never blocks).
        void setStatus(slug, "active");
        // M4: flush an initial stage immediately so the client sees life at once.
        recordStage({
          ch: "Escalate",
          status: "active",
          lines: ["Gate tripped — dispatching a Cloud Run detonation execution"],
        });

        let detonationTimedOut = false;
        const detonationTimer = setTimeout(() => {
          detonationTimedOut = true;
          killChild();
        }, DETONATION_MAX_WAIT_MS);

        // Real, granular progress polling — see STAGE_LABELS above. Started
        // once the execution is actually triggered, stopped on every exit path
        // (spawn failure, spawn error, or the child closing) via stopStagePoll.
        let lastStage: string | null = null;
        let stagePollTimer: ReturnType<typeof setInterval> | null = null;
        const stopStagePoll = () => {
          if (stagePollTimer) clearInterval(stagePollTimer);
          stagePollTimer = null;
        };
        const startStagePoll = () => {
          stagePollTimer = setInterval(() => {
            void fetchStage(slug).then((s) => {
              if (!s || !s.stage || s.stage === lastStage) return;
              lastStage = s.stage;
              recordStage({
                ch: "Detonate",
                status: "active",
                lines: [s.detail ? `${STAGE_LABELS[s.stage] ?? s.stage} — ${s.detail}` : (STAGE_LABELS[s.stage] ?? s.stage)],
              });
            });
          }, STAGE_POLL_MS);
        };

        try {
          // Trigger ONE Cloud Run Job execution for this scan. owner/repo/sha/slug
          // are strictly validated above (no shell metacharacters), and
          // --update-env-vars overrides THIS execution only (confirmed against
          // `gcloud run jobs execute --help`: "environment variables overrides
          // for an execution of a job" — it does not mutate the job's stored
          // template), so concurrent scans can never race each other's inputs.
          // Invoked through bash (same context hasGcloud() uses) so the
          // gcloud.cmd shim resolves on Windows.
          const envOverrides = [
            `CR_OWNER=${owner}`,
            `CR_REPO=${repo}`,
            `CR_COMMIT_SHA=${sha}`,
            `CR_SCAN_ID=${slug}`,
          ].join(",");
          const gcloudCmd =
            `gcloud run jobs execute ${RUN_JOB_NAME} --region ${RUN_REGION} ` +
            `--update-env-vars ${envOverrides} --wait`;
          child = spawn(BASH, ["-c", gcloudCmd], {
            cwd: REPO_ROOT,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            env: childEnv(),
          });
          startStagePoll();
        } catch (e) {
          clearTimeout(detonationTimer);
          stopStagePoll();
          void setStatus(slug, "failed");
          emit({ t: "error", error: `failed to trigger Cloud Run execution: ${msg(e)}` });
          finish();
          return;
        }

        child.on("error", (e) => {
          clearTimeout(detonationTimer);
          stopStagePoll();
          void setStatus(slug, "failed");
          emit({ t: "error", error: `Cloud Run execution spawn error: ${msg(e)}` });
          finish();
        });

        // gcloud's own execute --wait progress/error text is not parsed for
        // per-stage milestones — real granular progress comes from the
        // stage-poll above (the execution's own entrypoint reporting live),
        // not this channel — but stderr is captured so a failure is diagnosable.
        let errBuf = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          errBuf += chunk.toString("utf8");
        });

        child.on("close", async (code) => {
          clearTimeout(detonationTimer);
          stopStagePoll();
          if (closed) return;
          if (detonationTimedOut) {
            void setStatus(slug, "timed_out");
            emit({
              t: "error",
              error: `Cloud Run execution exceeded the ${Math.round(DETONATION_MAX_WAIT_MS / 60_000)} min timeout and was terminated.`,
            });
            finish();
            return;
          }
          if (code !== 0) {
            void setStatus(slug, "failed");
            emit({ t: "error", error: `Cloud Run execution failed (exit ${code}): ${errBuf.trim().slice(-500)}` });
            finish();
            return;
          }
          recordStage({
            ch: "Detonate",
            status: "done",
            kind: "ok",
            lines: ["Cloud Run execution completed — confirming the forensic record actually attached"],
          });
          emit({
            t: "stage",
            ch: "Persist",
            status: "active",
            lines: ["Confirming the forensic record landed on the report row"],
          });
          // The execution's OWN entrypoint already POSTed to attach-forensics
          // (it has network egress, routed through the same forge) — confirm
          // that write actually happened rather than trusting exit 0 alone.
          const attached = await confirmForensicsAttached(owner, repo, sha);
          if (attached) {
            void setStatus(slug, "done");
            emit({
              t: "stage",
              ch: "Persist",
              status: "done",
              kind: "ok",
              lines: ["Forensics attached. This is a confirmed sandbox run."],
            });
            emit({ t: "result", persisted: true });
          } else {
            void setStatus(slug, "failed");
            emit({
              t: "error",
              error:
                "The sandbox ran, but the forensic record never landed on the report row. " +
                "This scan is not a confirmed sandbox run.",
            });
          }
          finish();
        });
      };

      /**
       * Atomically acquire a slot and start the run. The check + increment run with
       * NO await between them (single Node process), so two requests can never both
       * see a free slot and both take it. Returns true when a slot was acquired.
       */
      const acquireAndRun = (): boolean => {
        if (inFlight >= MAX_CONCURRENT) return false;
        inFlight++;
        acquiredSlot = true;
        deepScanQueue.remove(slug); // leave the FIFO line; we're running now
        void startDetonation();
        return true;
      };

      // Record the row for observability + granular stage tracking UNCONDITIONALLY
      // — not just on the queue path. A real bug this fixes: the container's
      // report_stage() calls (set_stage) target this row by token, but when a
      // slot was immediately free (the common case, no queueing needed) this
      // row was never created, so every set_stage/get_stage call silently
      // updated/read zero rows and the granular timeline never advanced past
      // the static "Escalate" line — confirmed live before this fix.
      void enqueueRow({ owner, repo, sha, token: slug });

      // ── Fast path: a slot is free AND nobody is ahead in line → run at once. ──
      // Strict FIFO: only skip the queue when the in-process queue is empty, so a
      // just-arrived request can never jump a waiter that is mid-poll for a slot.
      if (deepScanQueue.size() === 0 && acquireAndRun()) {
        // Client disconnect → SIGTERM the child; orchestrate's EXIT trap +
        // dead-man's-switch then tear down any VMs (no orphans).
        const signal = req.signal;
        if (signal) {
          if (signal.aborted) killChild();
          else signal.addEventListener("abort", killChild, { once: true });
        }
        return;
      }

      // ── Queue path: both slots busy (or someone is already waiting). Enqueue,
      // keep the stream OPEN, emit an honest position/wait line, and poll until we
      // become the FIFO head with a free slot — or the max-wait deadline elapses. ──
      // (The observability row was already recorded unconditionally above.)
      const startedAt = Date.now();
      deepScanQueue.enqueue(slug);

      // Emit the current "Queued — position N of M, ~X min" line. Prefers the DB
      // position (authoritative, shared) but falls back to the in-process standing
      // so the number is ALWAYS real, never fabricated, even if the DB is down.
      const emitQueueLine = async () => {
        if (closed) return;
        const local: QueueStanding = deepScanQueue.standing(slug);
        const dbPos = await fetchPosition(slug);
        if (closed) return;
        const standing: QueueStanding = dbPos
          ? {
              ahead: dbPos.ahead,
              waitingTotal: dbPos.waitingTotal,
              position: dbPos.ahead + 1,
            }
          : local;
        emit({
          t: "stage",
          ch: "Queue",
          status: "active",
          lines: [queueLine(standing, MAX_CONCURRENT, PER_DETONATION_MS)],
        });
      };

      // Wire disconnect handling for the whole queued lifecycle: an aborted request
      // must leave the queue (release()) so it never blocks the head for those
      // behind, and — if it had already been admitted and spawned a child — that
      // child must be SIGTERM'd (orchestrate's EXIT trap then tears down any VM).
      const signal = req.signal;
      const onAbort = () => {
        // Only a request that never ran is a queue "timed_out"; one that was
        // admitted is torn down by its own child-close/kill path.
        if (!acquiredSlot) void setStatus(slug, "timed_out");
        killChild();
        finish();
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Immediate first line so the user sees "Queued — position …" without a 1s gap.
      void emitQueueLine();

      let tick = 0;
      queueTimer = setInterval(() => {
        if (closed) {
          clearQueueTimer();
          return;
        }
        // Deadline: waited too long for a slot → honest, specific "too busy" failure.
        if (isExpired(startedAt, Date.now(), QUEUE_MAX_WAIT_MS)) {
          clearQueueTimer();
          void setStatus(slug, "timed_out");
          const waitedMin = Math.round((Date.now() - startedAt) / 60_000);
          emit({
            t: "error",
            error:
              `The sandbox was at capacity for too long — your scan waited ${waitedMin} min ` +
              `without a free detonation slot and was not started. This is a busy-server ` +
              `timeout, not a problem with the repository. Please retry in a few minutes.`,
          });
          finish();
          return;
        }
        // Strict-FIFO admission: only the oldest waiter may take a freed slot.
        // The abort listener wired above already handles a disconnect for BOTH the
        // wait phase and the (now) running phase — it kills the child if one exists.
        if (deepScanQueue.canAcquire(slug, inFlight, MAX_CONCURRENT)) {
          clearQueueTimer();
          acquireAndRun();
          return;
        }
        // Still waiting — refresh the emitted position/estimate periodically so the
        // user sees it move as slots free / others time out.
        tick++;
        if (tick % POSITION_REFRESH_TICKS === 0) void emitQueueLine();
      }, QUEUE_POLL_MS);
    },
    cancel() {
      try {
        child?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // A cancel before we ever ran leaves the queue row abandoned; mark it honestly.
      if (!acquiredSlot) void setStatus(slug, "timed_out");
      release();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
