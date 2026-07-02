/**
 * /api/deep — the INLINE deep-sandbox path (BUG-INLINE-MOAT).
 *
 * When the fast path trips the escalation gate, the browser calls this route and
 * watches the warm host boot a fresh Firecracker microVM (via Kata), run the
 * unknown code with all egress forced through the deceptive forge, and destroy the
 * microVM — all within the same scan, no queue, no separate drain step. On exit the
 * captured forensic record is POSTed to the deployed `attach-forensics` edge
 * function, which flips the report row to a real "Sandbox run" (its `_ranSandbox`
 * signal becomes true) and surfaces the captured geo + the deep-run count on the board.
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

import { spawn, type ChildProcess } from "node:child_process";

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
// The NEW substrate runs on persistent host VMs (Kata/Firecracker microVMs + the deceptive
// forge). /api/deep SSHes to a host and runs the per-scan orchestrator there, streaming its
// [orch] milestones back over stderr and reading the forensic record from stdout.
//
// COMPUTE PROVISIONING — two modes, selected at request time by resolveTargetHost():
//   1. Single-host override: CR_SANDBOX_HOST set -> always dispatch to that one named host
//      (the original behaviour; the manual fallback that must never break). Concurrency cap 2.
//   2. On-demand pool: CR_POOL_MIG set (+ CR_POOL_ZONE) -> a Managed Instance Group of golden-
//      image hosts with a stopped standby pool (sandbox/microvm/create-pool.sh). We discover
//      the RUNNING members by name, spread scans across them (2 slots each), and when every
//      live host is full we resize the MIG up so its scale-out-pool standby policy activates a
//      warm standby (measured ~44s stopped / ~21s suspended to detonation-ready). N live hosts
//      -> 2N concurrent scans, not a hardcoded 2.
// If neither is set, we fall back to the historical default single host `cr-host-build`.
const SANDBOX_HOST_OVERRIDE = process.env.CR_SANDBOX_HOST ?? "";
const POOL_MIG = process.env.CR_POOL_MIG ?? "";
const POOL_ZONE = process.env.CR_POOL_ZONE ?? process.env.CR_SANDBOX_ZONE ?? ZONE;
// Cap the pool from ballooning cost/quota on a real billing account. 24 INSTANCES/region is
// the hard GCP ceiling in us-east1 today; this soft cap keeps a runaway resize well under it.
const POOL_MAX_HOSTS = Math.max(1, Number(process.env.CR_POOL_MAX_HOSTS ?? "6") || 6);
const REMOTE_ORCH = process.env.CR_REMOTE_ORCH ?? "/opt/cr/microvm/orchestrate-microvm.sh";
// Seconds to wait for a freshly-activated standby to reach detonation-ready before giving up.
const POOL_ACTIVATE_TIMEOUT_S = Math.max(30, Number(process.env.CR_POOL_ACTIVATE_TIMEOUT_S ?? "150") || 150);

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

// Per-HOST orchestrate budget: trap(2 cores) + detonation(2 cores) = 4 cores/run on a 4-vCPU
// n2-standard-4 host -> at most 2 concurrent deep runs PER HOST. With the pool this is no
// longer a single global cap: total concurrency = (live host count) x SLOTS_PER_HOST.
const SLOTS_PER_HOST = Math.max(1, Number(process.env.CR_SLOTS_PER_HOST ?? "2") || 2);
// In-process slot ledger: host name -> slots currently in flight on that host. This route
// only ever runs in ONE local-controller Node process (Vercel has it inert via the
// CR_ALLOW_LOCAL_DEEP gate), so a plain in-memory map is a correct authority — same
// single-process assumption the old scalar `inFlight` relied on, generalised to N hosts.
const slotsInUse = new Map<string, number>();
const usedOn = (host: string): number => slotsInUse.get(host) ?? 0;
const acquireSlot = (host: string): void => { slotsInUse.set(host, usedOn(host) + 1); };
const releaseSlot = (host: string): void => {
  const n = usedOn(host) - 1;
  if (n <= 0) slotsInUse.delete(host);
  else slotsInUse.set(host, n);
};

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run a bash command as a child, resolving { code, stdout, stderr }. Injection boundary:
 *  callers pass a FIXED command string or one built only from validated identifiers. */
function runBash(cmd: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number) => { if (!done) { done = true; resolve({ code, stdout, stderr }); } };
    try {
      const p = spawn(BASH, ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], shell: false, env: childEnv() });
      const timer = setTimeout(() => { try { p.kill("SIGTERM"); } catch { /* gone */ } finish(124); }, timeoutMs);
      p.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
      p.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
      p.on("error", () => { clearTimeout(timer); finish(-1); });
      p.on("close", (code) => { clearTimeout(timer); finish(code ?? -1); });
    } catch {
      finish(-1);
    }
  });
}

/** List RUNNING members of the MIG by short name. Empty on any failure (caller falls back). */
async function listRunningPoolHosts(): Promise<string[]> {
  if (!POOL_MIG) return [];
  const cmd =
    `gcloud compute instance-groups managed list-instances ${POOL_MIG} --zone ${POOL_ZONE} ` +
    `--filter=instanceStatus=RUNNING --format="value(instance.basename())"`;
  const { code, stdout } = await runBash(cmd, 30_000);
  if (code !== 0) return [];
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[a-z0-9-]{1,63}$/.test(s));
}

/** Total members (any state) — the ceiling we must not resize past. */
async function poolMemberCount(): Promise<number> {
  if (!POOL_MIG) return 0;
  const cmd =
    `gcloud compute instance-groups managed list-instances ${POOL_MIG} --zone ${POOL_ZONE} ` +
    `--format="value(instance.basename())"`;
  const { code, stdout } = await runBash(cmd, 30_000);
  if (code !== 0) return 0;
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
}

/** Is a host detonation-ready? SSH up + /dev/kvm + containerd active + base image present —
 *  the exact state orchestrate-microvm.sh needs. Host name is validated before it reaches here. */
async function hostDetonationReady(host: string): Promise<boolean> {
  const remote =
    `[ -e /dev/kvm ] && systemctl is-active --quiet containerd && ` +
    `sudo /usr/local/bin/nerdctl images cr-detonation-base --format '{{.Repository}}' 2>/dev/null | grep -q cr-detonation-base && echo CR_READY`;
  // Auto-accept the host key: MIG members are ephemeral and legitimately present new keys, so
  // gcloud/plink's cached-key check must not block. `printf 'y\n' |` feeds the prompt; `host`
  // is validated /^[a-z0-9-]+$/ and the remote string is fixed text, so this is injection-free.
  const cmd = `printf 'y\\n' | gcloud compute ssh ${host} --zone ${POOL_ZONE} --quiet --command ${JSON.stringify(remote)} 2>/dev/null`;
  const { stdout } = await runBash(cmd, 30_000);
  return /CR_READY/.test(stdout);
}

/** Resize the MIG up by one so scale-out-pool activates a standby. Returns the new size, or
 *  -1 if we're already at the soft ceiling / the resize failed. */
async function resizePoolUp(): Promise<number> {
  const total = await poolMemberCount();
  if (total >= POOL_MAX_HOSTS) return -1;
  const next = total + 1;
  const cmd = `gcloud compute instance-groups managed resize ${POOL_MIG} --zone ${POOL_ZONE} --size ${next}`;
  const { code } = await runBash(cmd, 60_000);
  return code === 0 ? next : -1;
}

// The warm running baseline the pool rests at when there is no load (0 = maximal thrift, first
// scan pays a cold-start; 1 = one host always warm for an instant first scan). Idle running
// hosts above (baseline + in-flight demand) are scaled back into the disk-only stopped pool.
const POOL_BASELINE = Math.max(0, Number(process.env.CR_POOL_BASELINE ?? "1") || 0);

/**
 * App-driven idle reclaim (pool mode): a MIG member cannot self-poweroff (the reconciler
 * restarts it — masked via pool-member-startup.sh), so the CONTROLLER reclaims surplus running
 * hosts by lowering targetSize. Target size we want = max(POOL_BASELINE, hosts needed for the
 * scans still in flight). Called (fire-and-forget) as scans drain. Never scales below baseline.
 */
async function scalePoolInIfIdle(): Promise<void> {
  if (!POOL_MIG) return;
  const activeSlots = Array.from(slotsInUse.values()).reduce((a, b) => a + b, 0);
  const hostsForLoad = Math.ceil(activeSlots / SLOTS_PER_HOST);
  const desired = Math.max(POOL_BASELINE, hostsForLoad);
  // Only shrink; growth is handled by resolveTargetHost's resizePoolUp.
  const cmd = `gcloud compute instance-groups managed describe ${POOL_MIG} --zone ${POOL_ZONE} --format="value(targetSize)"`;
  const { code, stdout } = await runBash(cmd, 30_000);
  if (code !== 0) return;
  const current = Number(stdout.trim());
  if (!Number.isFinite(current) || current <= desired) return;
  await runBash(
    `gcloud compute instance-groups managed resize ${POOL_MIG} --zone ${POOL_ZONE} --size ${desired}`,
    60_000,
  );
}

type HostPick =
  | { ok: true; host: string }               // a slot was ACQUIRED on this host (caller must release)
  | { ok: false; status: number; error: string };

/**
 * Pick a host with a free detonation slot and ACQUIRE that slot atomically, or fail.
 *
 * - Single-host mode (CR_SANDBOX_HOST set, or neither var set -> default host): exactly the
 *   old behaviour — one host, cap SLOTS_PER_HOST.
 * - Pool mode (CR_POOL_MIG set): find a RUNNING member with spare capacity; if all live hosts
 *   are full, resize the MIG up (scale-out-pool activates a standby), wait for it to reach
 *   detonation-ready, and place the scan there. Bounded by POOL_MAX_HOSTS.
 *
 * The slot check-and-acquire is a SYNCHRONOUS critical section (no await between reading
 * `usedOn` and calling `acquireSlot`), so the single-process ledger can never oversubscribe.
 */
async function resolveTargetHost(): Promise<HostPick> {
  // ── single-host modes ────────────────────────────────────────────────────────────
  if (SANDBOX_HOST_OVERRIDE || !POOL_MIG) {
    const host = SANDBOX_HOST_OVERRIDE || "cr-host-build";
    if (usedOn(host) >= SLOTS_PER_HOST) {
      return { ok: false, status: 429, error: `sandbox host ${host} at capacity (max ${SLOTS_PER_HOST} concurrent deep runs); retry shortly` };
    }
    acquireSlot(host);
    return { ok: true, host };
  }

  // ── pool mode ────────────────────────────────────────────────────────────────────
  // 1) Try to place on an already-RUNNING member with a free slot (least-loaded first so we
  //    pack onto warm hosts before activating more capacity).
  const running = await listRunningPoolHosts();
  if (running.length) {
    const candidate = running
      .filter((h) => usedOn(h) < SLOTS_PER_HOST)
      .sort((a, b) => usedOn(a) - usedOn(b))[0];
    if (candidate) {
      acquireSlot(candidate);            // synchronous check-then-acquire (no await between)
      return { ok: true, host: candidate };
    }
  }

  // 2) Every live host is full (or none up). Activate a standby by resizing the MIG up.
  const globalUsed = Array.from(slotsInUse.values()).reduce((a, b) => a + b, 0);
  if (globalUsed >= POOL_MAX_HOSTS * SLOTS_PER_HOST) {
    return { ok: false, status: 429, error: `pool at capacity (${globalUsed}/${POOL_MAX_HOSTS * SLOTS_PER_HOST} slots across up to ${POOL_MAX_HOSTS} hosts); retry shortly` };
  }
  const newSize = await resizePoolUp();
  if (newSize < 0) {
    return { ok: false, status: 503, error: `pool is full and cannot grow (at the ${POOL_MAX_HOSTS}-host soft cap or resize failed); retry shortly` };
  }

  // 3) Wait for a newly-RUNNING member (not previously seen) to reach detonation-ready.
  const before = new Set(running);
  const deadline = Date.now() + POOL_ACTIVATE_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const now = await listRunningPoolHosts();
    // Prefer a freshly-activated host, but also accept any running host that has since freed a slot.
    const fresh = now.filter((h) => !before.has(h) && usedOn(h) < SLOTS_PER_HOST);
    const freed = now.filter((h) => usedOn(h) < SLOTS_PER_HOST);
    for (const h of [...fresh, ...freed]) {
      if (await hostDetonationReady(h)) {
        if (usedOn(h) < SLOTS_PER_HOST) {   // re-check under the sync section (map may have changed)
          acquireSlot(h);
          return { ok: true, host: h };
        }
      }
    }
  }
  return { ok: false, status: 504, error: `activated a standby host but it did not become detonation-ready within ${POOL_ACTIVATE_TIMEOUT_S}s; retry shortly` };
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

  // 5. pick a host with a free detonation slot (single host OR pool) + ACQUIRE that slot.
  //    resolveTargetHost may resize the pool up + wait for a standby to warm — so this can
  //    take tens of seconds when the whole pool is saturated (bounded by POOL_ACTIVATE_TIMEOUT_S).
  const pick = await resolveTargetHost();
  if (!pick.ok) {
    return json({ error: pick.error }, pick.status);
  }
  const host = pick.host;

  const slug = buildSlug(owner, repo);
  let stdoutBuf = ""; // accumulates the orchestrator's forensic-record JSON (its stdout)

  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseSlot(host);   // free the slot on the exact host this scan ran on
      // Pool mode: after a scan drains, reclaim surplus running capacity back to the disk-only
      // stopped standby pool (a MIG member can't self-poweroff — the reconciler restarts it).
      // Fire-and-forget so tearing down never blocks the client response.
      if (POOL_MIG) void scalePoolInIfIdle();
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
        lines: ["Gate tripped — detonating on the microVM sandbox host"],
      });

      try {
        // Run the per-scan orchestrator ON the chosen host over SSH. We invoke gcloud
        // THROUGH bash (the same context hasGcloud() uses) so the gcloud.cmd shim resolves
        // on Windows. owner/repo/sha/slug are strictly validated (no shell metacharacters)
        // and `host` is a resolved instance name (validated /^[a-z0-9-]+$/ in pool mode, or a
        // fixed env/default in single-host mode), so interpolating them is injection-free.
        // `printf 'y\n' |` auto-accepts the host-key cache prompt (same pattern provision-host.sh
        // uses): pool members are ephemeral MIG instances that legitimately present new SSH host
        // keys on (re)activation, which the plink cache check would otherwise block on.
        const remoteCmd = `sudo bash ${REMOTE_ORCH} --github ${owner}/${repo} --ref ${sha} --name ${slug}`;
        const gcloudCmd = `printf 'y\\n' | gcloud compute ssh ${host} --zone ${POOL_ZONE} --quiet --command ${JSON.stringify(remoteCmd)}`;
        child = spawn(BASH, ["-c", gcloudCmd], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: childEnv(),
        });
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

      // The orchestrator prints the forensic record JSON to stdout; accumulate it.
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
      });

      child.on("close", async (code) => {
        if (closed) return;
        if (code !== 0) {
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
