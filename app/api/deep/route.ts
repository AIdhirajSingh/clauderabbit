/**
 * /api/deep — the INLINE deep-sandbox path (BUG-INLINE-MOAT).
 *
 * When the fast path trips the escalation gate, the browser calls this route and
 * watches a fresh GCP detonation VM get provisioned, run the unknown code under
 * the sinkhole, and tear itself down — all within the same scan, no queue, no
 * separate drain step. On exit the captured forensic record is POSTed to the
 * deployed `attach-forensics` edge function, which flips the report row to a real
 * "Sandbox run" (its `_ranSandbox` signal becomes true) and surfaces the captured
 * geo on the world map + the deep-run count on the board.
 *
 * This route only INVOKES `sandbox/orchestrate.sh`; every containment invariant
 * (sealed VM, no external IP/SA, deny-egress, sinkhole, per-scan reset, the
 * dead-man's-switch, zero orphan VMs) lives in that script and is unchanged here.
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

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Privileged local capability: a real Node child process + filesystem. Never edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── server-only config (NEVER NEXT_PUBLIC for the runner key / zone) ────────────
const ZONE = process.env.CR_SANDBOX_ZONE ?? "us-central1-a";
const RUNNER_KEY = process.env.CR_DEEP_RUNNER_KEY ?? "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
// The publishable (anon) key — PUBLIC, fine server-side. attach-forensics sits
// behind the Supabase Functions gateway, which requires a valid apikey/JWT BEFORE
// the function runs; the function then enforces its own runner-key auth. So the
// call needs BOTH (matching sandbox/run-deep-queue.sh): anon for the gateway,
// x-runner-key for the function. Missing the anon header → gateway 401, no attach.
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const REPO_ROOT = process.cwd();
const ORCHESTRATE = path.join(REPO_ROOT, "sandbox", "orchestrate.sh");
const RESULTS_DIR = path.join(REPO_ROOT, "sandbox", "results");

// The dev/controller process may be launched with a narrower PATH than an
// interactive shell (e.g. the preview runner), so the `bash` + `gcloud` the moat
// needs may not resolve. These let the operator point at the absolute bash and
// prepend the tool dirs (gcloud SDK bin, git bin) onto the child PATH — sourced
// from machine-specific config (.env.local), never hardcoded. Both default to the
// inherited environment, so a controller with a complete PATH needs neither.
const BASH = process.env.CR_BASH || "bash";
const PATH_PREPEND = process.env.CR_SANDBOX_PATH_PREPEND || "";

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

/**
 * Map a single orchestrate `[orch]` stderr milestone to a user-facing stage, or
 * null for lines that are noise. These are the REAL milestones the moat logs —
 * the browser sees genuine provision → build → run → capture → reset progress.
 */
function milestone(rawLine: string): Stage | null {
  const m = rawLine.replace(/^\[orch\]\s*/, "");
  if (/^ensuring hermetic network/.test(m))
    return { ch: "Seal the network", status: "active", lines: ["Building the hermetic network + sinkhole rules"] };
  if (/^cloning public repo/.test(m))
    return { ch: "Clone + pin", status: "active", lines: ["Cloning the repo at the scanned commit (off-VM)"] };
  if (/^pinned detonation target/.test(m))
    return { ch: "Clone + pin", status: "done", kind: "ok", lines: ["Pinned to the exact scanned commit"] };
  if (/^booting TRAP host/.test(m))
    return { ch: "Provision trap host", status: "active", lines: ["Booting the sealed trap host (sinkhole DNS + sink + proxy + pcap)"] };
  if (/^build proxy healthy/.test(m))
    return { ch: "Provision trap host", status: "done", kind: "ok", lines: ["Trap up · registry-allowlist proxy enforced"] };
  if (/^booting DETONATION VM/.test(m))
    return { ch: "Provision detonation VM", status: "active", lines: ["Booting a fresh sealed VM — no external IP, no service account, deny-egress"] };
  if (/DEGRADED/.test(m))
    return { ch: "Provision detonation VM", status: "active", kind: "warn", lines: ["No golden image — booting base image (degraded build)"] };
  if (/^staging harness/.test(m))
    return { ch: "Provision detonation VM", status: "done", kind: "ok", lines: ["Detonation VM up · staging harness + target"] };
  if (/^=== BUILD phase/.test(m))
    return { ch: "Build under containment", status: "active", lines: ["Installing deps via the trap proxy (registries only)"] };
  if (/^containment confirmed/.test(m))
    return { ch: "Build under containment", status: "done", kind: "ok", lines: ["Containment confirmed — control probe did NOT reach the real internet"] };
  if (/^=== AGENTIC pass/.test(m))
    return { ch: "Run under the sinkhole", status: "active", lines: ["Exploring the code, then detonating under the sinkhole"] };
  if (/^=== RUN phase/.test(m))
    return { ch: "Run under the sinkhole", status: "active", lines: ["Running the code — DNS + DNAT folded to the trap, never the real internet"] };
  if (/^=== RESET: deleting detonation VM/.test(m))
    return { ch: "Capture + reset", status: "active", lines: ["Capture collected — deleting the detonation VM now"] };
  if (/^folding captured network intent/.test(m))
    return { ch: "Compute verdict", status: "active", lines: ["Folding captured network intent into an honest verdict"] };
  if (/^emitting forensic record/.test(m))
    return { ch: "Compute verdict", status: "done", kind: "ok", lines: ["Forensic record emitted"] };
  if (/^scan complete/.test(m))
    return { ch: "Capture + reset", status: "done", kind: "ok", lines: ["Scan complete — trap VM deleted (per-scan reset)"] };
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
  const rand = Math.floor(Math.random() * 1296).toString(36);
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

  // 5. concurrency cap — check + increment with NO await between (no race).
  if (inFlight >= MAX_CONCURRENT) {
    return json({ error: "sandbox at capacity (max 2 concurrent deep runs); retry shortly" }, 429);
  }
  inFlight++;

  const slug = buildSlug(owner, repo);
  const forensicsPath = path.join(RESULTS_DIR, `${slug}-forensics.json`);

  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  const enc = new TextEncoder();
  let child: ChildProcess | null = null;
  // The REAL run timeline, accumulated as it streams, so the captured record can be
  // persisted with the report (not just shown live then lost). Only genuine run
  // milestones are recorded — the "Persist" bookkeeping stage is excluded below.
  const timeline: Stage[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
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

      // M4: flush an initial stage immediately so the client sees life at once.
      recordStage({
        ch: "Escalate",
        status: "active",
        lines: ["Gate tripped — spawning a fresh sealed sandbox VM"],
      });

      try {
        child = spawn(
          BASH,
          [ORCHESTRATE, "--zone", ZONE, "--github", `${owner}/${repo}`, "--ref", sha, "--name", slug],
          { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], shell: false, env: childEnv() },
        );
      } catch (e) {
        emit({ t: "error", error: `failed to spawn sandbox orchestrator: ${msg(e)}` });
        finish();
        return;
      }

      child.on("error", (e) => {
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

      // Drain stdout so the pipe never blocks; truth comes from the forensics FILE.
      child.stdout?.on("data", () => {
        /* intentionally drained */
      });

      child.on("close", async (code) => {
        if (closed) return;
        if (code !== 0) {
          emit({ t: "error", error: `sandbox run exited with code ${code}` });
          finish();
          return;
        }
        let forensics: unknown;
        try {
          forensics = JSON.parse(await readFile(forensicsPath, "utf8"));
        } catch {
          // Ran but produced no record — honest distinct signal, never implies safe.
          emit({
            t: "error",
            error: "sandbox completed but produced no forensic record",
          });
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
          emit({
            t: "stage",
            ch: "Persist",
            status: "done",
            kind: "ok",
            lines: ["Forensics attached — this report now shows a real sandbox run"],
          });
          emit({ t: "result", persisted: true });
        } else {
          emit({ t: "error", error: attached.error });
        }
        finish();
      });

      // Client disconnect → SIGTERM the child; orchestrate's EXIT trap +
      // dead-man's-switch then tear down any VMs (no orphans).
      const signal = req.signal;
      if (signal) {
        if (signal.aborted) killChild();
        else signal.addEventListener("abort", killChild, { once: true });
      }
    },
    cancel() {
      try {
        child?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
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
