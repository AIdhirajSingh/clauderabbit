/**
 * attach-forensics — the server-side persistence endpoint for the deep-sandbox
 * runner. When `sandbox/run-deep-queue.sh` finishes a genuine detonation it POSTs
 * the forensic record here; this function writes it onto the matching report row
 * via the service-role-only `attach_forensics` RPC, so the report flips to a real
 * "Sandbox run" (its `_ranSandbox` signal becomes true) and the board surfaces the
 * captured geo + the deep-run count.
 *
 * The service key is read from the Supabase-provided `SUPABASE_SECRET_KEYS`
 * (auto-available in the edge runtime per docs/INFRASTRUCTURE.md §3) — it is never
 * handled by the runner or the repo. The caller is authorized by a shared
 * `CR_DEEP_RUNNER_KEY` secret (set with `supabase secrets set`): without it the
 * function fails closed, so a forensic record can only be attached by the trusted
 * runner, never by an anonymous caller fabricating runtime evidence.
 *
 * This is a MACHINE-TO-MACHINE endpoint (curl from the trusted runner). It has no
 * legitimate browser caller, so — unlike the public scan endpoint — it emits NO
 * permissive CORS headers and rejects the preflight, removing any cross-origin
 * browser surface against this service-role write path.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  computeEscalatedScore,
  type ScoreDelta,
  type ScoringReputation,
  type ScoringRiskKind,
  type ScoringRiskyItem,
  type ScoringSeverity,
  verdictForScore,
} from "../_shared/scoring.ts";
import {
  isDeepRunChapter,
  type LogChapter,
  sanitizeTimeline,
  timelineToChapters,
} from "../_shared/run-timeline.ts";
import { verifyUnrecognizedHosts } from "../_shared/host-verify.ts";

/** Max bytes we will read for a forensic record before rejecting (DoS guard). */
const MAX_BODY_BYTES = 512 * 1024;

/** JSON Response with NO CORS headers — this endpoint has no browser caller. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Constant-time secret comparison. Both sides are SHA-256-hashed first, so the
 * compare runs over fixed 32-byte digests — it leaks neither the key length nor
 * the position of the first differing byte, defeating timing-based enumeration
 * of CR_DEEP_RUNNER_KEY. (A SHA-256 collision is infeasible, so equal digests
 * imply equal keys.)
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Resolve the service key from the new or legacy Supabase key system (auto-env). */
function resolveServiceKey(): string {
  const roleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (roleKey) return roleKey;
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
      if (typeof parsed === "string") return parsed;
    } catch {
      if (secretKeys.startsWith("sb_secret_")) return secretKeys;
    }
  }
  throw new Error("No service key available (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS)");
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return createClient(url, resolveServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A clean owner/repo segment (no slashes/metacharacters). */
function isSegment(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(v);
}

/**
 * Structural check that a payload is a genuine forensic record, not arbitrary
 * JSON. Mirrors `normalizeForensics`'s `looksLikeRecord` gate: a forensic-record
 * schema OR one of the record's load-bearing sections present as a NON-null
 * object (so `{"verdict": null}` does not slip through and flip _ranSandbox).
 */
function looksLikeForensicRecord(f: unknown): f is Record<string, unknown> {
  if (!f || typeof f !== "object") return false;
  const r = f as Record<string, unknown>;
  const hasSchema =
    typeof r.schema === "string" && r.schema.startsWith("claude-rabbit/forensic-record");
  const hasSection = ["network_intent", "in_vm_behavior", "containment", "verdict"].some(
    (k) => k in r && r[k] !== null && typeof r[k] === "object",
  );
  return hasSchema || hasSection;
}

// ───────────────────── escalation blend (U1: escalation owns the report) ──────
// When a real sandbox run attaches forensics, the ESCALATION owns the report: a
// fresh runtime-primary score (scoring.ts computeEscalatedScore), a runtime-first
// HEDGE-FREE summary, and rewritten Score/Sandbox-run log chapters — all persisted
// at attach so a fresh deep run and a later cached view of the same commit agree.
// LogChapter/LogKind + the run-timeline collapse live in _shared/run-timeline.ts.

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Runtime primitives extracted from the forensic record for the blend + summary. */
interface RuntimeFacts {
  dynamicScore: number;
  exercised: boolean; // built AND ran without crashing
  builtOk: boolean;
  ranOk: boolean;
  caughtAttack: boolean;
  credReads: number;
  capturedHost: string | null;
  /**
   * A BUILD-phase dependency fetch to a recognized software-distribution host
   * (github, sourceforge, ...) with no credential involvement — assemble-forensics.py
   * classifies this as a supply-chain CAUTION, deliberately excluded from
   * `capturedHost`/`caughtAttack` so a benign dependency fetch never reads as a
   * confirmed attack. Null when no such fetch was captured for this run.
   */
  supplyChainHost: string | null;
  projectType: string | null;
}

// Exported (not just for the handler above) so the phase-aware classification
// contract can be unit-tested directly — see index.test.ts.
//
// Async: assemble-forensics.py's own host-recognition list (SOFTWARE_DISTRIBUTION_HOSTS,
// see sandbox/*/assemble-forensics.py) is static and finite — the exact same limitation
// the fast-path classifier had before scan/index.ts started live-verifying unrecognized
// install-time hosts (see _shared/host-verify.ts). This applies that identical fix here:
// an attack-grade host the Python side didn't recognize gets one cheap live HTTPS check.
// This requires NO change to the sandbox's live network/containment boundary — by the
// time this function runs, the container is long gone; it is reading an already-captured
// hostname out of the forensics JSON the same way the fast path reads a hostname out of a
// package.json/install script, and verifying it against the real internet from here.
export async function extractRuntime(forensics: Record<string, unknown>): Promise<RuntimeFacts> {
  const verdict = asObj(forensics.verdict);
  const ran = asObj(forensics.what_it_ran);
  const inVm = asObj(forensics.in_vm_behavior);
  const net = asObj(forensics.network_intent);
  const payloadAnalysis = asObj(forensics.payload_analysis);
  const builtOk = ran.auto_build_succeeded === true;
  const ranOk = ran.ran_without_crash === true;
  const credReads = asNum(inVm.high_value_credential_reads);
  // These two are already ATTACK-GRADE only by the time they reach here — a benign
  // build-phase fetch to a recognized software-distribution host is classified
  // separately (below) and never appears in either array (see assemble-forensics.py).
  let capturedIntent = asArr(verdict.captured_network_intent)
    .map((h) => (typeof h === "string" ? h.trim() : ""))
    .filter((h) => h.length > 0);
  let destHosts = asArr(net.intended_destinations)
    .map((d) => {
      const h = asObj(d).host;
      return typeof h === "string" ? h.trim() : "";
    })
    .filter((h) => h.length > 0);
  let supplyChainHosts = asArr(verdict.supply_chain_egress)
    .map((h) => (typeof h === "string" ? h.trim() : ""))
    .filter((h) => h.length > 0);
  let attackEgressIntercepted = verdict.attack_egress_intercepted === true;

  // A host tied to a request assemble-forensics.py body-matched as credential exfil
  // (canary / AWS keys / SSH private key / _authToken) is attack-grade no matter what
  // the destination host turns out to be — never eligible for the downgrade below.
  const exfilHosts = new Set(
    asArr(payloadAnalysis.decoded_payloads)
      .map((p) => asObj(p))
      .filter((p) => p.kind === "credential_exfil")
      .map((p) => (typeof p.host === "string" ? p.host.trim() : ""))
      .filter((h) => h.length > 0),
  );

  // Mirrors the fast path's credential-negates-downgrade guard: any credential file
  // read at all keeps every host at full attack weight, regardless of what it verifies as.
  if (credReads === 0) {
    const candidates = Array.from(new Set([...capturedIntent, ...destHosts])).filter(
      (h) => !exfilHosts.has(h),
    );
    if (candidates.length > 0) {
      const verified = await verifyUnrecognizedHosts(candidates);
      const legitimate = candidates.filter((h) => verified.get(h)?.legitimate === true);
      if (legitimate.length > 0) {
        const legitimateSet = new Set(legitimate);
        capturedIntent = capturedIntent.filter((h) => !legitimateSet.has(h));
        destHosts = destHosts.filter((h) => !legitimateSet.has(h));
        supplyChainHosts = Array.from(new Set([...supplyChainHosts, ...legitimate]));
        // Recompute rather than trust the stale flag: attack_egress_intercepted was
        // derived solely from these same arrays being non-empty (plus cred_exfil, already
        // excluded above, and cred_reads, already zero on this branch) — see
        // assemble-forensics.py's `attack = cred_exfil or cred_reads > 0 or attack_intent_present`.
        if (capturedIntent.length === 0 && destHosts.length === 0) {
          attackEgressIntercepted = false;
        }
      }
    }
  }

  const caughtAttack =
    attackEgressIntercepted ||
    credReads > 0 ||
    capturedIntent.length > 0 ||
    destHosts.length > 0;
  const projectType =
    typeof ran.project_type === "string" && ran.project_type.trim()
      ? ran.project_type.trim()
      : null;
  return {
    dynamicScore: asNum(verdict.dynamic_score),
    exercised: builtOk && ranOk,
    builtOk,
    ranOk,
    caughtAttack,
    credReads,
    capturedHost: capturedIntent[0] ?? destHosts[0] ?? null,
    supplyChainHost: supplyChainHosts[0] ?? null,
    projectType,
  };
}

/** The stage-1 code/behavior findings (residual static concern for the blend). */
function riskyFromRow(riskyJson: unknown): ScoringRiskyItem[] {
  const out: ScoringRiskyItem[] = [];
  for (const r of asArr(riskyJson)) {
    const o = asObj(r);
    const sev = o.severity;
    const kind = o.kind;
    if (sev !== "high" && sev !== "med" && sev !== "low") continue;
    if (kind !== "code" && kind !== "behavior" && kind !== "rep") continue;
    out.push({ severity: sev as ScoringSeverity, kind: kind as ScoringRiskKind });
  }
  return out;
}

/** One representative code concern title from the stage-1 findings, for the summary. */
function topConcern(riskyJson: unknown): string | null {
  const order = { high: 0, med: 1, low: 2 } as Record<string, number>;
  let best: { title: string; rank: number } | null = null;
  for (const r of asArr(riskyJson)) {
    const o = asObj(r);
    if (o.kind !== "code" && o.kind !== "behavior") continue;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const rank = order[o.severity as string] ?? 3;
    if (title && (!best || rank < best.rank)) best = { title, rank };
  }
  return best?.title ?? null;
}

/** Reputation facts from the owners row (ageDays computed from created_at_github). */
function repFromOwner(ownerRow: Record<string, unknown> | null): ScoringReputation {
  if (!ownerRow) return { established: false, ageDays: -1, sentScore: -1, stars: 0 };
  let ageDays = -1;
  const created = ownerRow.created_at_github;
  if (typeof created === "string" && created) {
    const t = Date.parse(created);
    if (Number.isFinite(t)) ageDays = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  }
  return {
    established: ownerRow.established === true,
    ageDays,
    sentScore: typeof ownerRow.sentiment_score === "number" ? ownerRow.sentiment_score : -1,
    stars: typeof ownerRow.stars_total === "number" ? ownerRow.stars_total : 0,
  };
}

/**
 * The runtime-first, HEDGE-FREE summary. States what running it showed with
 * confidence — NEVER "not executed / unverified / largely unverified / could not
 * verify / a clean run is not a guarantee". A crash is stated as a concrete finding,
 * not a hedge. Rails kept: never a bare "Safe" (the verdict carries evidence), and
 * this is code/runtime content (reputation stays in its own panel).
 *
 * Exported for index.test.ts.
 */
export function buildRuntimeSummary(
  owner: string,
  repo: string,
  rt: RuntimeFacts,
  rep: ScoringReputation,
  concern: string | null,
): string {
  const target = `${owner}/${repo}`;
  const kind = rt.projectType ? `${rt.projectType} ` : "";
  // Two clean sentences: what the run DID, then what we OBSERVED. No repetition of
  // "in an isolated sandbox" (the opening already says it), no hedge language.
  let ranSentence: string;
  if (rt.exercised) {
    ranSentence = "It built and ran cleanly.";
  } else if (rt.builtOk) {
    ranSentence = "It built and started, then exited with an error on startup.";
  } else {
    ranSentence = "The project did not build to a runnable state.";
  }

  let behaviorSentence: string;
  if (rt.caughtAttack) {
    const what = rt.credReads > 0 && rt.capturedHost
      ? `reading high-value credentials and attempting to reach ${rt.capturedHost}`
      : rt.credReads > 0
        ? `reading high-value credential files`
        : rt.capturedHost
          ? `attempting to reach ${rt.capturedHost}`
          : `attempting outbound exfiltration`;
    behaviorSentence = `We caught it ${what}. Every outbound attempt was intercepted by the sandbox and never reached its destination.`;
  } else if (rt.supplyChainHost) {
    // A real, honestly-surfaced signal that is NOT an attack: a build-time dependency
    // fetch to a recognized software-distribution host, with no credential involvement.
    behaviorSentence =
      `We observed no malicious behavior, credential access, or outbound exfiltration. ` +
      `Its install reaches ${rt.supplyChainHost} for dependencies — a supply-chain note, not an attack.`;
  } else {
    behaviorSentence = "We observed no malicious behavior, credential access, or outbound exfiltration.";
  }

  const concerns: string[] = [];
  if (concern) concerns.push(concern.toLowerCase());
  if (rep.ageDays >= 0 && rep.ageDays < 60) concerns.push("a new owner account");
  const tail = concerns.length
    ? ` Its score is held down by ${concerns.join(" and ")}.`
    : "";

  return `We ran ${target}, a ${kind}project, in an isolated sandbox. ${ranSentence} ${behaviorSentence}${tail}`
    .replace(/\s+/g, " ")
    .trim();
}

/** The fresh Score chapter (mirrors the fast path's format, from the blend breakdown). */
function buildScoreChapter(score: number, breakdown: ScoreDelta[]): LogChapter {
  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
  return {
    ch: "Score",
    kind: score < 60 ? "bad" : score < 80 ? "warn" : "ok",
    lines: [
      `Score computed from the sandbox run: ${score}/100 (runtime-primary, deterministic)`,
      ...breakdown.map((d) => `${sign(d.delta)} [${d.group === "reputation" ? "reputation" : "code"}] ${d.factor}: ${d.detail}`),
    ],
  };
}

/**
 * Rewrite the persisted log chapters for an escalated report: DROP the stale
 * stage-1 "Score" + "Escalation" chapters (the old number + the "flagged for
 * detonation" note), keep the real static-read chapters, then APPEND the real
 * deep-run timeline (one chapter per provision -> build -> run -> capture -> reset
 * milestone), the "Sandbox run" outcome chapter, and the fresh blended "Score".
 */
function rewriteEscalatedLogs(
  existing: unknown,
  score: number,
  breakdown: ScoreDelta[],
  rt: RuntimeFacts,
  timelineChapters: LogChapter[],
): LogChapter[] {
  const kept: LogChapter[] = [];
  for (const c of asArr(existing)) {
    const o = asObj(c);
    const ch = typeof o.ch === "string" ? o.ch : "";
    // Drop the stale stage-1 Score/Escalation AND any prior deep-run chapters, so a
    // re-attach replaces the run section instead of compounding duplicates.
    if (/^score$/i.test(ch) || /escalat/i.test(ch) || isDeepRunChapter(ch)) continue;
    const kind = o.kind === "bad" || o.kind === "warn" ? o.kind : "ok";
    const lines = asArr(o.lines).filter((l): l is string => typeof l === "string");
    kept.push({ ch: ch || "Log", kind, lines });
  }
  // The real run, step by step (empty when the legacy runner sends no timeline).
  kept.push(...timelineChapters);
  const runLines = [
    rt.exercised
      ? "Built and ran cleanly under the sinkhole; no malicious behavior observed."
      : rt.builtOk
        ? "Built and started, then exited with an error on startup; no malicious behavior observed before exit."
        : "Detonated under the sinkhole; the project did not build to a runnable state.",
  ];
  if (rt.caughtAttack) {
    runLines.push(
      rt.capturedHost
        ? `Caught attempting to reach ${rt.capturedHost}; intercepted by the sandbox (no real packet left the VM).`
        : "Caught attempting credential access / outbound exfiltration; intercepted by the sandbox.",
    );
  } else if (rt.supplyChainHost) {
    runLines.push(
      `Its install reached ${rt.supplyChainHost} for dependencies — a supply-chain note, not ` +
        `an attack; every outbound attempt was intercepted by the sandbox.`,
    );
  }
  const runKind = rt.caughtAttack ? "bad" : rt.supplyChainHost ? "warn" : "ok";
  kept.push({ ch: "Sandbox run", kind: runKind, lines: runLines });
  kept.push(buildScoreChapter(score, breakdown));
  return kept;
}

export async function handler(req: Request): Promise<Response> {
  // No browser caller — refuse the preflight and any non-POST method.
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // Authorize the runner. Fail CLOSED: with no configured key, nobody may attach.
  const runnerKey = Deno.env.get("CR_DEEP_RUNNER_KEY");
  if (!runnerKey) {
    return jsonResponse({ error: "Persistence is not configured (no runner key)." }, 503);
  }
  const presented =
    req.headers.get("x-runner-key") ??
    (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!(await timingSafeEqual(presented, runnerKey))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Cap the body BEFORE parsing so a compromised authorized caller cannot push
  // an arbitrarily large blob into the report row or spike edge-runtime memory.
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Payload too large" }, 413);
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse({ error: "Invalid body" }, 400);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Payload too large" }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const owner = b.owner;
  const repo = b.repo;
  const sha = b.sha;
  const forensics = b.forensics;

  if (!isSegment(owner) || !isSegment(repo)) {
    return jsonResponse({ error: "owner and repo must be clean segments" }, 400);
  }
  if (typeof sha !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(sha)) {
    return jsonResponse({ error: "commit sha is required" }, 400);
  }
  if (!looksLikeForensicRecord(forensics)) {
    return jsonResponse({ error: "payload is not a forensic record" }, 422);
  }

  let db: SupabaseClient;
  try {
    db = serviceClient();
  } catch (e) {
    console.error("service client failed:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  // Read the EXACT-MATCH target row for the stage-1 findings + logs + owner, so the
  // escalation can BLEND its fresh score (runtime + static + reputation) and rewrite
  // the report narrative. If the read degrades, fall back to a runtime-only blend;
  // the RPC still RAISES "Report not found" when no row matches owner/repo/sha.
  const { data: rowData } = await db
    .from("reports")
    .select(
      "risky_json,logs_json,owner_id,owners(created_at_github,established,stars_total,sentiment_score)",
    )
    .eq("owner_login", owner)
    .eq("repo_name", repo)
    .eq("commit_sha", sha)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = asObj(rowData);
  const ownerRow = Array.isArray(row.owners)
    ? asObj(row.owners[0])
    : asObj(row.owners);

  const rt = await extractRuntime(forensics as Record<string, unknown>);
  const rep = repFromOwner(Object.keys(ownerRow).length ? ownerRow : null);
  const { score, breakdown } = computeEscalatedScore({
    dynamicScore: rt.dynamicScore,
    exercised: rt.exercised,
    caughtAttack: rt.caughtAttack,
    codeRisky: riskyFromRow(row.risky_json),
    reputation: rep,
  });
  const verdict = verdictForScore(score);
  const summary = buildRuntimeSummary(owner, repo, rt, rep, topConcern(row.risky_json));
  const timelineChapters = timelineToChapters(sanitizeTimeline(b.timeline));
  const logs = rewriteEscalatedLogs(row.logs_json, score, breakdown, rt, timelineChapters);

  // Persist the escalation's report ATOMICALLY: forensics + the fresh blended
  // score/verdict/summary + rewritten logs, in one EXACT-MATCH update. The service
  // client bypasses RLS, so a direct update is equivalent to the old security-definer
  // RPC and needs NO schema migration (the columns already exist) — it just writes
  // more of them. Determinism: computed once here, so a fresh deep run and a later
  // cached view of the same commit SHA read identical values.
  const fields = {
    forensics_json: forensics,
    deep: true,
    score,
    verdict,
    summary,
    logs_json: logs,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("reports")
    .update(fields)
    .eq("owner_login", owner)
    .eq("repo_name", repo)
    .eq("commit_sha", sha)
    .select("id")
    .maybeSingle();

  if (error) {
    // Log the detail server-side only; return a generic message so DB internals
    // never leak to the caller.
    console.error("attach update failed:", error.message);
    return jsonResponse({ error: "Attach failed" }, 500);
  }
  let reportId = (data as { id?: number } | null)?.id ?? null;
  if (!data) {
    // No stage-1 row to update. A standalone INSERT is allowed ONLY for the local forge
    // test fixtures (owner "cr-fixtures") — never for arbitrary public repos, so a leaked
    // runner key cannot forge a clean verdict for a real package that was never scanned.
    // A real repo with no row means the fast path never ran: fail closed (404), don't insert.
    if (owner !== "cr-fixtures") {
      return jsonResponse({ error: "Report not found" }, 404);
    }
    const { data: ins, error: insErr } = await db
      .from("reports")
      .insert({ owner_login: owner, repo_name: repo, commit_sha: sha, scan_path: "deep", ...fields })
      .select("id")
      .maybeSingle();
    if (insErr) {
      console.error("attach insert failed:", insErr.message);
      return jsonResponse({ error: "Attach failed" }, 500);
    }
    reportId = (ins as { id?: number } | null)?.id ?? null;
  }

  return jsonResponse({ ok: true, report_id: reportId });
}

Deno.serve((req) =>
  handler(req).catch((e) => {
    console.error("attach-forensics unhandled:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Internal error" }, 500);
  })
);
