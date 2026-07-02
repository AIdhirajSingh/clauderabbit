/**
 * /api/deep — the INLINE deep-sandbox path (BUG-INLINE-MOAT).
 *
 * When the fast path trips the escalation gate, the browser calls this route and
 * watches the warm host boot a fresh Firecracker microVM (via Kata), run the
 * unknown code with all egress forced through the deceptive forge, and destroy the
 * microVM — all within the same scan. On exit the captured forensic record is
 * POSTed to the deployed `attach-forensics` edge function, which flips the report
 * row to a real "Sandbox run" (its `_ranSandbox` signal becomes true) and surfaces
 * the captured geo + the deep-run count on the board.
 *
 * CONCURRENCY + QUEUE — the host holds at most MAX_CONCURRENT (2) simultaneous
 * detonations (its 4-vCPU budget). A 3rd concurrent request is no longer flatly
 * rejected: it QUEUES. The connection stays open and streams an honest
 * `{t:"stage", ch:"Queue", ...}` line ("Queued — position N of M, ~X min") while it
 * polls for a free slot in strict FIFO order, then proceeds through the exact same
 * detonation path once admitted. If it cannot get a slot within QUEUE_MAX_WAIT_MS it
 * ends with a clear, specific "sandbox was too busy" error — never a silent drop.
 * The in-process `inFlight` counter remains the sole slot arbiter (single Node
 * process, race-free); the `deep_scan_queue` table + `lib/deep-queue.ts` provide the
 * FIFO ordering, honest position/estimate, and observability. See lib/deep-queue.ts.
 *
 * This route only INVOKES the host orchestrator (`orchestrate-microvm.sh`); every
 * containment invariant (disposable Firecracker microVM with no route out except the
 * forge, per-scan reset, the max-run dead-man's-switch, zero orphan microVMs) lives
 * in that script and is unchanged here.
 *
 * SAFETY — this route spawns gcloud and runs a shell script, so it is a privileged
 * local-controller capability, NOT a public surface. It is hard-gated fail-closed:
 *   1. CR_ALLOW_LOCAL_DEEP=1 must be set (off by default → inert on Vercel).
 *   2. The request Host/Origin must be localhost (no remote caller).
 *   3. gcloud must be present on the machine (the sandbox controller).
 *   4. An in-process concurrency cap (≤2) honours orchestrate's 8-core budget.
 * owner/repo/sha are validated against strict charsets and passed to `spawn` as an
 * argv array (never an interpolated shell string), so they cannot inject commands.
 */

import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  deepScanQueue,
  isExpired,
  queueLine,
  type QueueStanding,
} from "@/lib/deep-queue";
import { enqueueRow, fetchPosition, setStatus } from "@/lib/deep-queue-client";

// Privileged local capability: a real Node child process + filesystem. Never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── server-only config (NEVER NEXT_PUBLIC for the runner key / zone) ────────────
const RUNNER_KEY = process.env.CR_DEEP_RUNNER_KEY ?? "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
// The publishable (anon) key — PUBLIC, fine server-side. attach-forensics sits
// behind the Supabase Functions gateway, which requires a valid apikey/JWT BEFORE
// the function runs; the function then enforces its own runner-key auth. So the
// call needs BOTH (matching sandbox/run-deep-queue.sh): anon for the gateway,
// x-runner-key for the function. Missing the anon header → gateway 401, no attach.
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const REPO_ROOT = process.cwd();
// The NEW substrate runs on a persistent host VM (one host + Kata/Firecracker microVMs +
// the deceptive forge). /api/deep SSHes to that host and runs the per-scan orchestrator
// there, streaming its [orch] milestones back over stderr and reading the forensic record
// from stdout. (The old two-VM `sandbox/orchestrate.sh` ran locally and is retired.)
const SANDBOX_HOST = process.env.CR_SANDBOX_HOST ?? "cr-host-build";
const REMOTE_ORCH = process.env.CR_REMOTE_ORCH ?? "/opt/cr/microvm/orchestrate-microvm.sh";

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

// orchestrate budget: trap(2 cores) + detonation(2 cores) = 4 cores/run, 8-core
// cap → at most 2 concurrent deep runs. Enforced in-process (single dev server).
const MAX_CONCURRENT = 2;
let inFlight = 0;

// ── queue tuning (see lib/deep-queue.ts for the ordering/estimate/timeout math) ──
// A real, measured detonation is ~76s on the 4-vCPU host (docs/runs/2026-07-01-
// host-restart-and-concurrency.md); we use 90s as the per-detonation estimate to
// fold in the attach + reset overhead so the quoted wait never reads too optimistic.
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

// The host's zone is live GCP state, not machine config — provision-host.sh's own
// documented zone-fallback list already means a recreation can land cr-host-build
// in a different zone than last time (observed for real twice this session). A
// static CR_SANDBOX_ZONE env var requires that new zone to be hand-copied into
// every checkout's .env.local, which is exactly the kind of drift that caused this
// bug. Resolve it live from GCP instead, falling back to the env var (then a
// last-resort default) only if the discovery call itself fails.
const ZONE_CACHE_MS = 5 * 60_000;
let cachedZone: { zone: string; at: number } | null = null;

function discoverZone(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn(
        BASH,
        ["-c", `gcloud compute instances list --filter="name=${SANDBOX_HOST}" --format="value(zone)"`],
        { stdio: ["ignore", "pipe", "ignore"], shell: false, env: childEnv() },
      );
      let out = "";
      p.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      p.on("error", () => resolve(null));
      p.on("close", (code) => {
        if (code !== 0) return resolve(null);
        const zone = out.trim().split(/\s+/)[0];
        resolve(zone || null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function resolveZone(): Promise<string> {
  if (cachedZone && Date.now() - cachedZone.at < ZONE_CACHE_MS) return cachedZone.zone;
  const discovered = await discoverZone();
  if (discovered) {
    cachedZone = { zone: discovered, at: Date.now() };
    return discovered;
  }
  return process.env.CR_SANDBOX_ZONE || "us-central1-a";
}

interface Stage {
  ch: string;
  status: "active" | "done";
  kind?: "ok" | "warn" | "bad";
  lines?: string[];
}

/**
 * Map a single orchestrate `[orch]` stderr milestone to a user-facing stage, or
 * null for lines that are noise. These are the REAL milestones the moat logs —
 * the browser sees genuine provision → build → run → capture → reset progress.
 */
function milestone(rawLine: string): Stage | null {
  // Three-agent stream: orchestrate forwards the agentic pass's `[agent]` stderr
  // lines verbatim. Each agent's REAL reasoning is surfaced live under one chapter
  // so the browser watches three OpenCode agents think in parallel.
  const agent = rawLine.match(/^\[agent\]\s*(.*)$/);
  if (agent) {
    const body = agent[1] ?? "";
    if (/^launching THREE parallel agents/.test(body))
      return {
        ch: "Three agents read the code",
        status: "active",
        lines: ["Three OpenCode agents exploring in parallel — install-time · runtime · payload"],
      };
    const a = body.match(/^(install|runtime|payload)\s+(thinking|finding|detonate)[:]?\s*(.*)$/);
    if (a) {
      const lens = a[1] ?? "";
      const kind = a[2] ?? "";
      const text = (a[3] ?? "").trim();
      if (kind === "thinking" && text)
        return { ch: "Three agents read the code", status: "active", lines: [`[${lens}] ${text}`] };
      if (kind === "finding" && text)
        return { ch: "Three agents read the code", status: "active", lines: [`[${lens}] flagged ${text}`] };
      if (kind === "detonate" && /run-target/.test(text))
        return { ch: "Three agents read the code", status: "active", lines: [`[${lens}] requested a sandbox detonation`] };
    }
    if (/^cross-verified|^three agents done/i.test(body))
      return { ch: "Three agents read the code", status: "done", kind: "ok", lines: ["Cross-verified findings from three agents"] };
    return null;
  }
  // The display chapters describe the REAL substrate — one warm host running a
  // Firecracker microVM (via Kata) with all egress forced through the deceptive
  // forge — NOT the retired two-VM trap/sinkhole. The [orch] triggers below still
  // match orchestrate-microvm.sh's stderr; only the user-facing text is honest.
  const m = rawLine.replace(/^\[orch\]\s*/, "");
  if (/^ensuring hermetic network/.test(m))
    return { ch: "Seal the network", status: "active", lines: ["Building the hermetic per-run network + the deceptive egress forge"] };
  if (/^cloning public repo/.test(m))
    return { ch: "Clone + pin", status: "active", lines: ["Cloning the repo at the scanned commit (off-VM, on the host)"] };
  if (/^pinned detonation target/.test(m))
    return { ch: "Clone + pin", status: "done", kind: "ok", lines: ["Pinned to the exact scanned commit"] };
  if (/^booting TRAP host/.test(m))
    return { ch: "Bring up the forge", status: "active", lines: ["Starting the deceptive egress forge (DNS + TLS interception; registry fast-path)"] };
  if (/^build proxy healthy/.test(m))
    return { ch: "Bring up the forge", status: "done", kind: "ok", lines: ["Forge up · registries pass through, everything else is forged"] };
  if (/^booting DETONATION VM/.test(m))
    return { ch: "Boot the microVM", status: "active", lines: ["Booting a fresh Firecracker microVM via Kata — no route out except the forge"] };
  if (/DEGRADED/.test(m))
    return { ch: "Boot the microVM", status: "active", kind: "warn", lines: ["No prebuilt base image — building the microVM image (degraded)"] };
  if (/^staging harness/.test(m))
    return { ch: "Boot the microVM", status: "done", kind: "ok", lines: ["microVM up · staging the harness + target"] };
  if (/^=== BUILD phase/.test(m))
    return { ch: "Build under containment", status: "active", lines: ["Installing deps through the forge's registry fast-path"] };
  if (/^containment confirmed/.test(m))
    return { ch: "Build under containment", status: "done", kind: "ok", lines: ["Containment confirmed — control probe did NOT reach the real internet"] };
  if (/^=== AGENTIC pass/.test(m))
    return { ch: "Detonate through the forge", status: "active", lines: ["Exploring the code, then detonating in the microVM through the forge"] };
  if (/^=== RUN phase/.test(m))
    return { ch: "Detonate through the forge", status: "active", lines: ["Running the code — every outbound connection is forged, no real packet leaves"] };
  if (/^=== RESET: deleting detonation VM/.test(m))
    return { ch: "Capture + reset", status: "active", lines: ["Capture collected — destroying the microVM now"] };
  if (/^folding captured network intent/.test(m))
    return { ch: "Compute verdict", status: "active", lines: ["Folding captured network intent into an honest verdict"] };
  if (/^emitting forensic record/.test(m))
    return { ch: "Compute verdict", status: "done", kind: "ok", lines: ["Forensic record emitted"] };
  if (/^scan complete/.test(m))
    return { ch: "Capture + reset", status: "done", kind: "ok", lines: ["Scan complete — microVM destroyed (per-scan reset)"] };
  return null;
}

/** POST the captured forensic record + the real run timeline to attach-forensics. */
async function attachForensics(args: {
  owner: string;
  repo: string;
  sha: string;
  forensics: unknown;
  timeline: Stage[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!SUPABASE_URL) return { ok: false, error: "NEXT_PUBLIC_SUPABASE_URL not configured" };
  const url = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/attach-forensics`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Gateway auth (anon) + function auth (runner key) — both required.
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        "x-runner-key": RUNNER_KEY,
      },
      body: JSON.stringify({
        owner: args.owner,
        repo: args.repo,
        sha: args.sha,
        forensics: args.forensics,
        // The REAL streamed run timeline (provision -> build -> run -> capture ->
        // reset). attach-forensics validates + persists it so the cached report's
        // "view logs" shows the complete record, not a 2-line stub.
        timeline: args.timeline,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `attach-forensics ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `attach-forensics request failed: ${msg(e)}` };
  }
}

/** Build a VM-name-safe unique slug: `[A-Za-z0-9-]{1,40}`, distinct per request. */
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

  // 3. without the runner key we cannot persist — fail honest, don't detonate.
  if (!RUNNER_KEY) {
    return json({ error: "CR_DEEP_RUNNER_KEY not configured on the controller" }, 500);
  }

  // 4. gcloud must be present (this is the sandbox controller).
  if (!(await hasGcloud())) {
    return json({ error: "deep path needs gcloud on the sandbox controller" }, 501);
  }

  // 5. A per-request token: FIFO key (in-process), VM name slug, and queue row id.
  const slug = buildSlug(owner, repo);
  let stdoutBuf = ""; // accumulates the orchestrator's forensic-record JSON (its stdout)

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
          lines: ["Gate tripped — detonating on the microVM sandbox host"],
        });

        try {
          // Run the per-scan orchestrator ON the sandbox host over SSH. We invoke gcloud
          // THROUGH bash (the same context hasGcloud() uses) so the gcloud.cmd shim resolves
          // on Windows. owner/repo/sha/slug are strictly validated (no shell metacharacters),
          // so interpolating them into the remote command is injection-free.
          const zone = await resolveZone();
          const remoteCmd = `sudo bash ${REMOTE_ORCH} --github ${owner}/${repo} --ref ${sha} --name ${slug}`;
          const gcloudCmd = `gcloud compute ssh ${SANDBOX_HOST} --zone ${zone} --quiet --command ${JSON.stringify(remoteCmd)}`;
          child = spawn(BASH, ["-c", gcloudCmd], {
            cwd: REPO_ROOT,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            env: childEnv(),
          });
        } catch (e) {
          void setStatus(slug, "failed");
          emit({ t: "error", error: `failed to spawn sandbox orchestrator: ${msg(e)}` });
          finish();
          return;
        }

        child.on("error", (e) => {
          void setStatus(slug, "failed");
          emit({ t: "error", error: `orchestrator spawn error: ${msg(e)}` });
          finish();
        });

        // Parse stderr milestones line-by-line (buffer partial lines).
        let errBuf = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          errBuf += chunk.toString("utf8");
          let nl: number;
          while ((nl = errBuf.indexOf("\n")) >= 0) {
            const line = errBuf.slice(0, nl);
            errBuf = errBuf.slice(nl + 1);
            const st = milestone(line);
            if (st) recordStage(st);
          }
        });

        // The orchestrator prints the forensic record JSON to stdout; accumulate it.
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuf += chunk.toString("utf8");
        });

        child.on("close", async (code) => {
          if (closed) return;
          if (code !== 0) {
            void setStatus(slug, "failed");
            emit({ t: "error", error: `sandbox run exited with code ${code}` });
            finish();
            return;
          }
          // Parse the forensic record from the orchestrator's stdout (it `cat`s the record
          // last). gcloud/ssh banners may precede it, so extract from the first "{".
          let forensics: unknown;
          try {
            const start = stdoutBuf.indexOf("{");
            forensics = JSON.parse(start >= 0 ? stdoutBuf.slice(start) : stdoutBuf);
          } catch {
            // Ran but produced no record — honest distinct signal, never implies safe.
            void setStatus(slug, "failed");
            emit({ t: "error", error: "sandbox completed but produced no forensic record" });
            finish();
            return;
          }
          emit({
            t: "stage",
            ch: "Persist",
            status: "active",
            lines: ["Attaching the forensic record to the report row"],
          });
          const attached = await attachForensics({ owner, repo, sha, forensics, timeline });
          if (attached.ok) {
            void setStatus(slug, "done");
            emit({
              t: "stage",
              ch: "Persist",
              status: "done",
              kind: "ok",
              lines: ["Forensics attached — this report now shows a real sandbox run"],
            });
            emit({ t: "result", persisted: true });
          } else {
            void setStatus(slug, "failed");
            emit({ t: "error", error: attached.error });
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
      const startedAt = Date.now();
      deepScanQueue.enqueue(slug);
      // Record the queued row for observability (best-effort; FIFO is in-process).
      void enqueueRow({ owner, repo, sha, token: slug });

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
