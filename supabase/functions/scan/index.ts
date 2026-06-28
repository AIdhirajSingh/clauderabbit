/**
 * Claude Rabbit — fast-path scan orchestrator (Supabase Edge Function).
 *
 * The two-speed funnel's fast path (PRD §3-4):
 *   paste URL → resolve SHA → cache check → static scan (flag regions) →
 *   reputation (separate) → read model scores reading ONLY flagged regions →
 *   escalation gate → persist + return a structured report.
 *
 * The dynamic sandbox run (deep path) is a separate later unit. When the gate
 * trips we mark the report deep/escalate and record the DECISION in the logs —
 * we never fabricate a sandbox run.
 *
 * CLAUDE.md rails enforced here (server-side, not just prompted):
 *   1. Never emit a bare "Safe" verdict — validated and corrected before return.
 *   2. Reputation signals (owner/community) stay structurally separate from
 *      code/behavior signals in the output.
 *
 * Secrets stay server-side; none are ever logged or returned.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { jsonResponse, preflightResponse, streamResponse } from "../_shared/cors.ts";
import {
  GitHubRateLimitError,
  type OwnerSignal,
  ownerSignal,
  PrivateRepoError,
  type RepoMetadata,
  RepoNotFoundError,
  resolveRepo,
} from "../_shared/github.ts";
import {
  type FlaggedRegion,
  staticScan,
  type StaticScanResult,
} from "../_shared/static-scan.ts";
import {
  computeScore,
  type ScoreDelta,
  type ScoringInputs,
} from "../_shared/scoring.ts";
import { generate } from "../_shared/vertex.ts";

// --- Types mirroring lib/types.ts Report shape (what the UI expects) --------

interface ScanRequest {
  owner?: string;
  repo?: string;
  ref?: string;
  deviceId?: string;
  userId?: string;
}

type Severity = "high" | "med" | "low";
type RiskKind = "behavior" | "code" | "rep";
type LogKind = "ok" | "warn" | "bad";

interface ModelOutput {
  score: number;
  confidence: number;
  verdict: string;
  summary: string;
  stats: { loc: string; packages: number; stars: string; created: string };
  packages: Array<{ name: string; score: number; note: string }>;
  risky: Array<{ title: string; severity: Severity; kind: RiskKind; detail: string }>;
  ownerHistory: {
    handle: string;
    name: string;
    age: string;
    established: boolean;
    repos: number;
    note: string;
  };
  reputation: { stars: string; forks: string; sentiment: string; sentScore: number };
  logs: Array<{ ch: string; kind: LogKind; lines: string[] }>;
  escalate: boolean;
}

// --- Constants ---------------------------------------------------------------

const CONFIDENCE_ESCALATION_THRESHOLD = 0.7;
const NEW_OWNER_AGE_DAYS = 60;
const READ_MAX_OUTPUT_TOKENS = 8192;

/** Vertex responseSchema — restricted to the supported OpenAPI-3.0 subset
 * (type/properties/required/items/enum/nullable). Numeric ranges are enforced
 * in code after parse, NOT in the schema (Vertex rejects min/max on some). */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    confidence: { type: "number" },
    verdict: {
      type: "string",
      enum: ["Trusted", "Likely safe", "Caution", "High risk", "Malicious"],
    },
    summary: { type: "string" },
    stats: {
      type: "object",
      properties: {
        loc: { type: "string" },
        packages: { type: "integer" },
        stars: { type: "string" },
        created: { type: "string" },
      },
      required: ["loc", "packages", "stars", "created"],
    },
    packages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          score: { type: "integer" },
          note: { type: "string" },
        },
        required: ["name", "score", "note"],
      },
    },
    risky: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["high", "med", "low"] },
          kind: { type: "string", enum: ["behavior", "code", "rep"] },
          detail: { type: "string" },
        },
        required: ["title", "severity", "kind", "detail"],
      },
    },
    ownerHistory: {
      type: "object",
      properties: {
        handle: { type: "string" },
        name: { type: "string" },
        age: { type: "string" },
        established: { type: "boolean" },
        repos: { type: "integer" },
        note: { type: "string" },
      },
      required: ["handle", "name", "age", "established", "repos", "note"],
    },
    reputation: {
      type: "object",
      properties: {
        stars: { type: "string" },
        forks: { type: "string" },
        sentiment: { type: "string" },
        sentScore: { type: "integer" },
      },
      required: ["stars", "forks", "sentiment", "sentScore"],
    },
    logs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ch: { type: "string" },
          kind: { type: "string", enum: ["ok", "warn", "bad"] },
          lines: { type: "array", items: { type: "string" } },
        },
        required: ["ch", "kind", "lines"],
      },
    },
    escalate: { type: "boolean" },
  },
  required: [
    "score",
    "confidence",
    "verdict",
    "summary",
    "stats",
    "packages",
    "risky",
    "ownerHistory",
    "reputation",
    "logs",
    "escalate",
  ],
};

// --- Service client ----------------------------------------------------------

/** Resolve the service key from either the legacy or new Supabase key system. */
function resolveServiceKey(): string {
  const roleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (roleKey) return roleKey;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    // May be a JSON array of strings, an array of {name,key}, or a bare key.
    try {
      const parsed = JSON.parse(secretKeys);
      if (typeof parsed === "string") return parsed;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        if (typeof first === "string") return first;
        if (first && typeof first === "object" && typeof first.key === "string") {
          return first.key;
        }
      }
    } catch {
      // Not JSON — treat as a bare key string.
      if (secretKeys.startsWith("sb_secret_")) return secretKeys;
    }
  }
  throw new Error(
    "No service key available (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS)",
  );
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return createClient(url, resolveServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// --- Auth + identity ---------------------------------------------------------

/** SHA-256 hex of a string (Web Crypto, available in Deno). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract a TRUSTED user id from the request's Authorization bearer, or null.
 *
 * The publishable (anon) key is the logged-out caller's bearer — it is NOT a
 * user, so it yields null. Any other bearer is treated as a user session JWT
 * and verified against GoTrue via `auth.getUser(token)`; a valid token yields
 * its user id. Verification failure (expired/garbage token, network error)
 * degrades to null so the scan still proceeds as the logged-out free flow.
 */
async function verifiedUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  // The anon/publishable key is not a user token — skip verification.
  const publishable = Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if ((publishable && token === publishable) || token.startsWith("sb_publishable_")) {
    return null;
  }

  const url = Deno.env.get("SUPABASE_URL");
  // Verify with a NON-service (publishable/anon) key only. If neither is set we
  // cannot verify without escalating to the service key — return null (anon)
  // rather than create an auth client keyed by the service credential.
  if (!url || !publishable) return null;
  try {
    // A plain client keyed by the publishable key; getUser(token) verifies the
    // passed token rather than any persisted session.
    const authClient = createClient(url, publishable, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch (e) {
    console.error("token verify failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

// --- Helpers -----------------------------------------------------------------

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

function isValidOwnerRepo(s: string): boolean {
  // GitHub owner/repo allowed charset; bounds the input.
  return /^[A-Za-z0-9._-]{1,100}$/.test(s);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function monthYear(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown";
  return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}

/**
 * RAIL ENFORCEMENT: never let a bare "Safe" verdict through, and ensure the
 * verdict matches the score band. Runs on BOTH fresh and cached reports.
 */
function enforceVerdictRails(_verdict: string, score: number): string {
  // The score is authoritative and code-computed (see _shared/scoring.ts), so the
  // one-word verdict is derived PURELY from the computed score band — the two can
  // never disagree, and the verdict can never be a bare "Safe". The model's own
  // free-text verdict is intentionally NOT used as the source of truth (its band
  // could contradict the formula's number). Dangerous band splits at 30 into
  // "High risk" (30-59) and "Malicious" (<30), matching the read-model prompt.
  return score >= 90
    ? "Trusted"
    : score >= 80
    ? "Likely safe"
    : score >= 60
    ? "Caution"
    : score >= 30
    ? "High risk"
    : "Malicious";
}

/** Validate + normalize the model's risky items so kinds stay in the enum. */
function normalizeRisky(
  risky: ModelOutput["risky"],
): ModelOutput["risky"] {
  const sev = new Set<Severity>(["high", "med", "low"]);
  const knd = new Set<RiskKind>(["behavior", "code", "rep"]);
  return (Array.isArray(risky) ? risky : [])
    .filter((r) => r && typeof r.title === "string")
    .map((r) => ({
      title: String(r.title).slice(0, 200),
      severity: sev.has(r.severity) ? r.severity : "low",
      kind: knd.has(r.kind) ? r.kind : "code",
      detail: String(r.detail ?? "").slice(0, 1000),
    }));
}

/** One chapter of the live scan log (mirrors lib/types.ts LogChapter). */
interface LogChapter {
  ch: string;
  kind: LogKind;
  lines: string[];
}

/**
 * Render the computed-score breakdown as a "Score" log chapter so the existing
 * report UI surfaces the citation trail with NO schema change. Each delta becomes
 * one line; reputation deltas are visually marked to preserve the structural
 * separation between code/behavior and reputation in the citation itself.
 */
function buildScoreChapter(score: number, breakdown: ScoreDelta[]): LogChapter {
  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
  const lines = [
    `Score computed by formula: ${score}/100 (deterministic, code-driven)`,
    ...breakdown.map((d) => {
      const tag = d.group === "reputation" ? "reputation" : "code";
      return `${sign(d.delta)} [${tag}] ${d.factor}: ${d.detail}`;
    }),
  ];
  // A "bad" chapter when the score is in the dangerous band, else "warn"/"ok".
  const kind: LogKind = score < 60 ? "bad" : score < 80 ? "warn" : "ok";
  return { ch: "Score", kind, lines };
}

// --- Read-model prompt -------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are the Claude Rabbit security analyst. Claude Rabbit is a free tool that",
    "tells a developer whether a stranger's public GitHub repo is safe to run.",
    "You score 0-100 and write an honest, plain-language report.",
    "",
    "You are given: repository metadata, an OWNER reputation signal, and a set of",
    "STATIC-FLAGGED REGIONS (file + reason + snippet). Read ONLY the flagged",
    "regions and the metadata — you are not given the full repo. Comprehend the",
    "project, fold in reputation, and produce a structured verdict.",
    "",
    "SCORE BANDS: >=90 Trusted, 80-89 Likely safe, 60-79 Caution, <60 dangerous",
    "(use verdict 'High risk' for 30-59 and 'Malicious' for <30).",
    "",
    "HARD RULES (these are product-defining and absolute):",
    "1. NEVER output a bare 'Safe'. Always state plainly what was NOT verified —",
    "   e.g. 'no malicious behavior observed in our static read; full runtime",
    "   behavior was not executed in a sandbox on this pass'. A confident wrong",
    "   'Safe' is the one outcome that can kill this product.",
    "2. Keep REPUTATION signals (owner account age, stars, community sentiment)",
    "   STRICTLY SEPARATE from CODE/BEHAVIOR signals. In `risky`, use kind='rep'",
    "   for owner/reputation findings, kind='code' for things found by reading",
    "   code, kind='behavior' for runtime behavior. Never blend them.",
    "3. You did NOT run the code in a sandbox on this fast pass. Do not claim to",
    "   have observed runtime behavior. Behavior-kind findings may only describe",
    "   what the code WOULD do based on reading it, clearly framed as such.",
    "",
    "Set `escalate` to true if you cannot confidently clear the repo from the",
    "static read alone — obfuscation, credential access, install-time network,",
    "a brand-new owner with anomalies, or low confidence. Emit `confidence` 0-1.",
    "",
    "Write the `logs` as scan chapters with realistic, specific line content:",
    "'Clone', 'Static scan', 'Reputation', 'Read', and if escalating an",
    "'Escalation' chapter. Each line should reflect the actual signals you were",
    "given. Output MUST conform to the provided JSON schema.",
  ].join("\n");
}

function buildUserPrompt(
  metadata: RepoMetadata,
  owner: OwnerSignal,
  scan: StaticScanResult,
  commitSha: string,
  fileCount: number,
): string {
  const regions = scan.flaggedRegions.length === 0
    ? "(none — static scanners found no flagged regions)"
    : scan.flaggedRegions
      .map(
        (r: FlaggedRegion, i) =>
          `#${i + 1} [${r.file}] ${r.reason}\n    snippet: ${r.snippet}`,
      )
      .join("\n");

  return [
    "=== REPOSITORY METADATA (code-side facts) ===",
    `repo: ${metadata.fullName}`,
    `commit: ${commitSha}`,
    `description: ${metadata.description ?? "(none)"}`,
    `primary language: ${metadata.language ?? "unknown"}`,
    `size: ${metadata.sizeKb} KB · open issues: ${metadata.openIssues}`,
    `license: ${metadata.license ?? "none declared"}`,
    `lockfile present: ${metadata.hasLockfile}`,
    `files read this pass: ${fileCount}`,
    "",
    "=== OWNER REPUTATION SIGNAL (keep separate from code) ===",
    `owner: ${owner.login} (type: ${owner.type})`,
    `display name: ${owner.name ?? "(none)"}`,
    `account age: ${owner.ageLabel} (${owner.ageDays} days)`,
    `public repos: ${owner.publicRepos}`,
    `established: ${owner.established}`,
    `stars: ${metadata.stars} · forks: ${metadata.forks}`,
    "",
    "=== STATIC SCAN SIGNALS (code-side) ===",
    `install hook: ${scan.signals.installHook}`,
    `obfuscation: ${scan.signals.obfuscation}`,
    `credential access: ${scan.signals.credAccess}`,
    `network: ${scan.signals.network}`,
    `install-time network: ${scan.installTimeNetwork}`,
    `embedded secret: ${scan.signals.embeddedSecret}`,
    `typosquat hint: ${scan.signals.typosquat}`,
    `severity hint: ${scan.severityHint}`,
    "",
    "=== FLAGGED REGIONS (read ONLY these) ===",
    regions,
    "",
    "Produce the structured safety report now.",
  ].join("\n");
}

// --- Escalation gate ---------------------------------------------------------

/** The escalation decision plus a concise WRITTEN reason. When not escalating,
 * `reason` is a one-line "cleared on static read: <why>" so the report can always
 * state plainly why the deep path was or was not taken. */
interface EscalationDecision {
  escalate: boolean;
  reason: string;
}

function decideEscalation(
  model: ModelOutput,
  scan: StaticScanResult,
  owner: OwnerSignal,
  confidence: number,
): EscalationDecision {
  // Code/behavior triggers first (heaviest), then reputation-driven, then the
  // model's own request — each yields a specific written reason.
  if (scan.signals.obfuscation) {
    return { escalate: true, reason: "obfuscated/encoded payload detected on static read" };
  }
  if (scan.signals.credAccess) {
    return { escalate: true, reason: "credential-access pattern detected on static read" };
  }
  if (scan.installTimeNetwork) {
    return { escalate: true, reason: "install-time network/shell activity detected on static read" };
  }
  const newOwner = owner.ageDays >= 0 && owner.ageDays < NEW_OWNER_AGE_DAYS;
  const anySignal = scan.signals.installHook || scan.signals.network ||
    scan.signals.embeddedSecret || scan.signals.typosquat;
  if (newOwner && anySignal) {
    return {
      escalate: true,
      reason: `new owner account (${owner.ageDays}d) combined with a code signal`,
    };
  }
  if (confidence < CONFIDENCE_ESCALATION_THRESHOLD) {
    return {
      escalate: true,
      reason: `low read confidence (${confidence.toFixed(2)} < ${CONFIDENCE_ESCALATION_THRESHOLD})`,
    };
  }
  if (model.escalate === true) {
    return { escalate: true, reason: "read model could not confidently clear the repo" };
  }
  // Not escalating — state plainly why it cleared on the static read.
  const clearedWhy = scan.severityHint === "clean"
    ? "no code signals flagged"
    : `only low-severity signals (${scan.severityHint}) and confident read`;
  return { escalate: false, reason: `cleared on static read: ${clearedWhy}` };
}

// --- Report reshape (cache hit) ---------------------------------------------

interface ReportRow {
  owner_login: string;
  repo_name: string;
  commit_sha: string;
  score: number;
  verdict: string;
  deep: boolean;
  summary: string | null;
  confidence: number | null;
  scan_path: string;
  stats_json: unknown;
  packages_json: unknown;
  risky_json: unknown;
  logs_json: unknown;
  forensics_json: unknown;
  owner_id: number | null;
}

/** Reputation for a cached render: the persisted deterministic view when present
 * (so it matches the fresh render incl. `forks`), else the legacy column shape. */
function reputationFromOwner(ownerRow: OwnerRow | null): {
  stars: string;
  forks: string;
  sentiment: string;
  sentScore: number;
} {
  const rj = ownerRow?.reputation_json;
  if (rj && typeof rj === "object") {
    const r = rj as Record<string, unknown>;
    if (typeof r.stars === "string") {
      return {
        stars: r.stars,
        forks: typeof r.forks === "string" ? r.forks : "—",
        sentiment: typeof r.sentiment === "string" ? r.sentiment : (ownerRow?.sentiment ?? ""),
        sentScore: typeof r.sentScore === "number" ? r.sentScore : (ownerRow?.sentiment_score ?? 0),
      };
    }
  }
  // Legacy rows (no deterministic view persisted) — reconstruct from columns.
  return {
    stars: ownerRow?.stars_total != null ? formatNumber(ownerRow.stars_total) : "—",
    forks: "—",
    sentiment: ownerRow?.sentiment ?? "",
    sentScore: ownerRow?.sentiment_score ?? 0,
  };
}

function reshapeCached(row: ReportRow, ownerRow: OwnerRow | null): unknown {
  return {
    id: `${row.owner_login}/${row.repo_name}`,
    owner: row.owner_login,
    name: row.repo_name,
    score: row.score,
    verdict: enforceVerdictRails(row.verdict, row.score),
    cached: true,
    deep: row.deep,
    summary: row.summary ?? "",
    ownerHistory: {
      handle: ownerRow?.github_login ?? row.owner_login,
      name: ownerRow?.display_name ?? row.owner_login,
      age: ownerRow?.account_age_label ?? "unknown",
      established: ownerRow?.established ?? false,
      repos: ownerRow?.public_repos ?? 0,
      note: "",
    },
    // Reputation is reconstructed from the persisted DETERMINISTIC view
    // (reputation_json), so the cached render matches the fresh render exactly —
    // including `forks`, which the older column-only path could not recover. Falls
    // back to the columns for rows persisted before this view existed.
    reputation: reputationFromOwner(ownerRow),
    stats: row.stats_json ?? {},
    packages: row.packages_json ?? [],
    risky: row.risky_json ?? [],
    logs: row.logs_json ?? [],
    // Carry the deep-run forensics on a cache hit. Without this an already-run
    // deep repo would come back deep=true with NO forensics, and the client would
    // see (deep && !forensics) and RE-DETONATE the sandbox on every cached view —
    // the unmetered deep scan V1 forbids. With it, a cached view of a sandbox-run
    // repo renders the same "Sandbox run" report instantly, no VM. Only present
    // when the row actually has a record (null/absent → omitted, like a fresh scan).
    ...(row.forensics_json ? { forensics: row.forensics_json } : {}),
    commit_sha: row.commit_sha,
    scan_path: "cache",
    confidence: row.confidence,
    // Shape parity with the fresh-scan response so a consumer never hits an
    // undefined field on a cache hit. The cited score breakdown for a cached
    // report is preserved inside `logs_json` (the "Score" chapter) for scans run
    // after the formula landed; the escalation reason is reconstructed from the
    // stored `deep` flag.
    escalationReason: row.deep
      ? "escalated to the dynamic sandbox on the original scan"
      : "cleared on the original static read",
    scoreBreakdown: [],
  };
}

interface OwnerRow {
  id: number;
  github_login: string;
  display_name: string | null;
  account_age_label: string | null;
  established: boolean;
  public_repos: number | null;
  stars_total: number | null;
  sentiment: string | null;
  sentiment_score: number | null;
  reputation_json?: unknown;
}

// --- Main handler ------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflightResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: ScanRequest;
  try {
    body = (await req.json()) as ScanRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const ownerInput = (body.owner ?? "").trim();
  const repoInput = (body.repo ?? "").trim();
  if (!ownerInput || !repoInput) {
    return jsonResponse({ error: "owner and repo are required" }, 400);
  }
  if (!isValidOwnerRepo(ownerInput) || !isValidOwnerRepo(repoInput)) {
    return jsonResponse({ error: "owner/repo contain invalid characters" }, 400);
  }

  // Validate the optional ref (branch/tag/sha) — bounded charset + length.
  const refInput = (body.ref ?? "").trim() || undefined;
  if (refInput && !/^[A-Za-z0-9._\-/]{1,200}$/.test(refInput)) {
    return jsonResponse({ error: "ref contains invalid characters" }, 400);
  }

  // Device id is an opaque client fingerprint. Bound the raw value (untrusted
  // input must not write unbounded strings), then HASH it before it is used for
  // the daily-limit key or stored on the scan row — the raw fingerprint never
  // touches the database. The hash is stable per device, so it keys the limit
  // counter and the analytics column consistently.
  const rawDeviceId = typeof body.deviceId === "string"
    ? body.deviceId.slice(0, 128).replace(/[^A-Za-z0-9_-]/g, "") || null
    : null;
  const deviceId = rawDeviceId ? await sha256Hex(rawDeviceId) : null;

  // Verify the caller's session token (if any) to get a TRUSTED user id. A body
  // `userId` is NEVER trusted. The publishable key is the logged-out Bearer; any
  // other Bearer is treated as a user JWT and verified via GoTrue. Verification
  // failure degrades to anon (userId=null) — it never fails the scan.
  const userId = await verifiedUserId(req);

  let db: SupabaseClient;
  try {
    db = serviceClient();
  } catch {
    console.error("config error: server misconfigured (key unavailable or rejected)");
    return jsonResponse({ error: "Server is not configured correctly" }, 500);
  }

  // 1. Resolve repo → canonical owner/repo + SHA + metadata + files.
  //
  // SAFETY RAIL (public-only): resolveRepo refuses any non-public repo by
  // throwing PrivateRepoError immediately after reading repo metadata — BEFORE
  // it fetches any file contents. We catch it here and return a clear 403 with
  // NO cache touch, NO model call, and NO DB write. A private repo never reaches
  // analysis or the public /owner/repo report.
  let resolved;
  try {
    resolved = await resolveRepo(ownerInput, repoInput, refInput);
  } catch (e) {
    if (e instanceof PrivateRepoError) {
      return jsonResponse({ error: e.message }, 403);
    }
    if (e instanceof RepoNotFoundError) {
      return jsonResponse({ error: e.message }, 404);
    }
    if (e instanceof GitHubRateLimitError) {
      return jsonResponse({ error: e.message }, 429);
    }
    console.error("resolveRepo failed:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Could not resolve repository" }, 502);
  }

  const { metadata, commitSha, ref, files } = resolved;
  const ownerLogin = metadata.ownerLogin;
  const repoName = metadata.repoName;

  // Defense in depth: even if resolveRepo's guard were bypassed, never proceed
  // to analyze or persist a repo whose metadata is not public.
  if (metadata.isPrivate || metadata.visibility !== "public") {
    return jsonResponse(
      { error: "Claude Rabbit only scans public repositories." },
      403,
    );
  }

  // 2. Cache check by (owner_login, repo_name, commit_sha).
  try {
    const { data: cached } = await db
      .from("reports")
      .select("*")
      .eq("owner_login", ownerLogin)
      .eq("repo_name", repoName)
      .eq("commit_sha", commitSha)
      .maybeSingle();

    if (cached) {
      const row = cached as ReportRow;
      let ownerRow: OwnerRow | null = null;
      if (row.owner_id != null) {
        const { data: o } = await db
          .from("owners")
          .select("*")
          .eq("id", row.owner_id)
          .maybeSingle();
        ownerRow = (o as OwnerRow | null) ?? null;
      }
      // Record the cached view as a scan event.
      await db.from("scans").insert({
        user_id: userId,
        device_id: deviceId,
        report_id: (cached as { id: number }).id,
        owner_login: ownerLogin,
        repo_name: repoName,
        scan_path: "cache",
        score: row.score,
        status: "done",
        is_dynamic: row.deep,
      });
      return jsonResponse(reshapeCached(row, ownerRow));
    }
  } catch (e) {
    console.error("cache check failed:", e instanceof Error ? e.message : e);
    // Non-fatal: fall through to a fresh scan.
  }

  // 2b. Scans are UNLIMITED (BUG-9, settled): no daily cap, no gating, of any
  // type — the GCP credit covers it and the accumulating vetted-repo database is
  // the point. The previous stage-1/dynamic daily limits are removed; a scan is
  // never blocked by a quota.

  // BUG-5/6: a fresh scan STREAMS its REAL stages as they happen (NDJSON), so the
  // processing timeline shows actual work — not a canned, timer-driven animation.
  // Early errors + the cache hit above stay normal JSON (status codes preserved);
  // only this fresh-scan path streams. The single consumer (runScan) maps an
  // in-band {t:"error"} to its retryable failed state, so a post-stream failure
  // (model down / persist failure) is surfaced as HTTP 200 + an error event rather
  // than a 5xx — an accepted tradeoff for V1 (runScan is the only caller).
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const emit = async (obj: unknown): Promise<void> => {
    try {
      await writer.write(enc.encode(JSON.stringify(obj) + "\n"));
    } catch (e) {
      // The client went away mid-stream; nothing more to do.
      console.error("scan stream write failed:", e instanceof Error ? e.message : e);
    }
  };

  const produce = async (): Promise<void> => {
    try {
      // Stage: resolve (already done before the stream opened).
      await emit({
        t: "stage",
        ch: "Resolve",
        status: "done",
        kind: "ok",
        lines: [
          `Resolved ${ownerLogin}/${repoName}@${commitSha.slice(0, 7)}`,
          `${files.length} file(s) in the tree at the resolved SHA`,
        ],
      });

      // 3. Static scan → flagged regions (code signals only).
      await emit({ t: "stage", ch: "Static scan", status: "active" });
      const scan = staticScan(files);
      const flaggedCount = scan.flaggedRegions.length;
      await emit({
        t: "stage",
        ch: "Static scan",
        status: "done",
        kind: scan.severityHint === "high" ? "bad" : flaggedCount > 0 ? "warn" : "ok",
        lines: [
          flaggedCount > 0
            ? `${flaggedCount} region(s) flagged for the read model`
            : "No regions flagged on the static read",
          `Static severity: ${scan.severityHint}`,
        ],
      });

      // 4. Owner reputation signal (kept SEPARATE from code/behavior).
      await emit({ t: "stage", ch: "Reputation", status: "active" });
      let owner: OwnerSignal;
      try {
        owner = await ownerSignal(ownerLogin);
      } catch (e) {
        console.error("ownerSignal failed:", e instanceof Error ? e.message : e);
        // Degrade gracefully — reputation unknown, but do not fail the whole scan.
        owner = {
          login: ownerLogin,
          type: "User",
          name: null,
          createdAt: null,
          ageLabel: "unknown",
          ageDays: -1,
          publicRepos: 0,
          established: false,
          location: null,
        };
      }
      await emit({
        t: "stage",
        ch: "Reputation",
        status: "done",
        kind: "ok",
        lines: [
          `Owner ${ownerLogin} · ${owner.ageLabel}${owner.established ? " · established" : " · new account"}`,
          `${formatNumber(metadata.stars)} stars (kept separate from code signals)`,
        ],
      });

      // 5. Read model (fast tier) reads ONLY flagged regions + metadata.
      await emit({ t: "stage", ch: "Read", status: "active" });
      let model: ModelOutput;
      try {
        const result = await generate({
          tier: "fast",
          json: true,
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: READ_MAX_OUTPUT_TOKENS,
          system: buildSystemPrompt(),
          prompt: buildUserPrompt(metadata, owner, scan, commitSha, files.length),
        });
        model = result.json as ModelOutput;
      } catch (e) {
        console.error("read model failed:", e instanceof Error ? e.message : e);
        await emit({ t: "error", error: "Analysis model call failed" });
        return;
      }

      // 6. Validate model output. The model's `score` is NOT used as the score —
      // it is only a sanity reference. The authoritative score is COMPUTED by the
      // deterministic formula from the real signals (step 6b).
      const confidence = clamp(model.confidence, 0, 1, 0.5);
      const risky = normalizeRisky(model.risky);
      await emit({
        t: "stage",
        ch: "Read",
        status: "done",
        kind: "ok",
        lines: [
          `Read model read ${flaggedCount} flagged region(s) + repo metadata`,
          `Model read: ${model.verdict} · confidence ${Math.round(confidence * 100)}%`,
        ],
      });

      // 7. Escalation gate (decision only). Produces a concise written reason
      // (escalating OR cleared-on-static-read) for the report.
      const escalation = decideEscalation(model, scan, owner, confidence);
      const escalate = escalation.escalate;
      const escalationReason = escalation.reason;
      const scanPath = escalate ? "deep" : "fast";
      const deep = escalate;

      // 6b. Compute the AUTHORITATIVE score from weighted, named signals. The model
      // FED the signals (static flags, reputation facts, per-finding risky items,
      // confidence); the SCORE and its cited breakdown are decided here by code.
      const scoringInputs: ScoringInputs = {
        signals: scan.signals,
        installTimeNetwork: scan.installTimeNetwork,
        severityHint: scan.severityHint,
        risky: risky.map((r) => ({ severity: r.severity, kind: r.kind })),
        reputation: {
          established: owner.established,
          ageDays: owner.ageDays,
          // -1 = unknown (model returned no sentiment); 0 = a genuine negative read.
          sentScore: typeof model.reputation?.sentScore === "number"
            ? Math.round(clamp(model.reputation.sentScore, 0, 100, 0))
            : -1,
          stars: metadata.stars,
        },
        confidence,
        escalated: escalate,
      };
      const scoreResult = computeScore(scoringInputs);
      const score = scoreResult.score;
      const scoreBreakdown = scoreResult.breakdown;
      const verdict = enforceVerdictRails(model.verdict, score);

      await emit({
        t: "stage",
        ch: "Verdict",
        status: "done",
        kind: score < 40 ? "bad" : score < 65 ? "warn" : "ok",
        lines: [
          `Score ${score}/100 · ${verdict}`,
          escalate
            ? `Escalation: ${escalationReason}`
            : `${escalationReason}`,
        ],
      });

      // Build logs from the model, then append the computed-score citation and the
      // escalation decision. This is the STAGE-1 record: it states the static read
      // flagged the repo for a live detonation. It makes NO runtime claim and uses
      // NO hedge ("not executed"/"unverified" are forbidden on an escalated repo) —
      // when the inline moat detonates, attach-forensics REPLACES this chapter with
      // the real "Sandbox run" timeline + the blended score.
      const logs = Array.isArray(model.logs) ? model.logs : [];
      logs.push(buildScoreChapter(score, scoreBreakdown));
      if (escalate) {
        const hasEsc = logs.some((l) => /escalat/i.test(l.ch));
        if (!hasEsc) {
          logs.push({
            ch: "Escalation",
            kind: scan.severityHint === "high" ? "bad" : "warn",
            lines: [
              "Escalation gate tripped on the static read",
              `Reason: ${escalationReason}`,
              "Flagged for a live sandbox detonation",
            ],
          });
        }
      }

      // Deterministic owner + reputation views, built from REAL GitHub facts +
      // the model's sentiment read — NOT the model's free-text ownerHistory /
      // reputation (which vary run to run). These are what the report shows AND
      // what we persist (ownerHistory via the owner columns, reputation via
      // reputation_json), so a fresh render and a later cached render of the same
      // commit are byte-identical (BUG-17, determinism per commit SHA).
      const ownerView = {
        handle: owner.login,
        name: owner.name ?? owner.login,
        age: owner.ageLabel,
        established: owner.established,
        repos: owner.publicRepos,
        note: "",
      };
      const repView = {
        stars: formatNumber(metadata.stars),
        forks: formatNumber(metadata.forks),
        sentiment: model.reputation?.sentiment ?? "",
        sentScore: typeof model.reputation?.sentScore === "number"
          ? Math.round(clamp(model.reputation.sentScore, 0, 100, 0))
          : 0,
        // U4: the owner's GitHub location, stored so the world map can plot a dot at
        // every scanned repo's geographic ORIGIN (resolved client-side). Free text;
        // null when the owner did not set one. Not rendered in the report itself.
        location: owner.location ?? null,
      };

      // 8. Persist — owner reputation, report, scan event.
      let ownerId: number | null = null;
      try {
        const { data: ownerUp } = await db
          .from("owners")
          .upsert(
            {
              github_login: ownerLogin,
              display_name: owner.name,
              account_age_label: owner.ageLabel,
              created_at_github: owner.createdAt,
              established: owner.established,
              public_repos: owner.publicRepos,
              stars_total: metadata.stars,
              sentiment: model.reputation?.sentiment ?? null,
              // This column is the board/aggregate signal (neutral 50 default).
              // The REPORT display reads `reputation_json.sentScore` (0 = "no
              // model read"), so the two intentionally differ on the no-read case.
              sentiment_score: model.reputation?.sentScore != null
                ? Math.round(clamp(model.reputation.sentScore, 0, 100, 50))
                : null,
              // Persist the DETERMINISTIC reputation view so the cached render
              // reconstructs the exact same reputation (incl. forks) as the
              // fresh render did.
              reputation_json: repView,
              fetched_at: new Date().toISOString(),
            },
            { onConflict: "github_login" },
          )
          .select("id")
          .maybeSingle();
        ownerId = (ownerUp as { id: number } | null)?.id ?? null;
      } catch (e) {
        console.error("owner upsert failed:", e instanceof Error ? e.message : e);
      }

      const stats = model.stats ?? {
        loc: "—",
        packages: model.packages?.length ?? 0,
        stars: formatNumber(metadata.stars),
        created: monthYear(metadata.createdAt),
      };

      let reportId: number | null = null;
      try {
        const { data: reportUp, error: reportErr } = await db
          .from("reports")
          .upsert(
            {
              owner_login: ownerLogin,
              repo_name: repoName,
              commit_sha: commitSha,
              ref,
              owner_id: ownerId,
              score,
              verdict,
              cached: false,
              deep,
              summary: model.summary ?? "",
              confidence,
              scan_path: scanPath,
              stats_json: stats,
              packages_json: model.packages ?? [],
              risky_json: risky,
              logs_json: logs,
            },
            { onConflict: "owner_login,repo_name,commit_sha" },
          )
          .select("id")
          .maybeSingle();
        if (reportErr) throw reportErr;
        reportId = (reportUp as { id: number } | null)?.id ?? null;
      } catch (e) {
        console.error("report upsert failed:", e instanceof Error ? e.message : e);
        await emit({ t: "error", error: "Failed to persist report" });
        return;
      }

      try {
        await db.from("scans").insert({
          user_id: userId,
          device_id: deviceId,
          report_id: reportId,
          owner_login: ownerLogin,
          repo_name: repoName,
          scan_path: scanPath,
          score,
          status: "done",
          is_dynamic: deep,
        });
      } catch (e) {
        console.error("scan insert failed:", e instanceof Error ? e.message : e);
      }

      // 9. Final result — the full structured report (identical shape to the
      // pre-streaming JSON, so the client normalizer is unchanged).
      await emit({
        t: "result",
        report: {
          id: `${ownerLogin}/${repoName}`,
          owner: ownerLogin,
          name: repoName,
          score,
          verdict,
          cached: false,
          deep,
          summary: model.summary ?? "",
          ownerHistory: ownerView,
          reputation: repView,
          stats,
          packages: model.packages ?? [],
          risky,
          logs,
          commit_sha: commitSha,
          scan_path: scanPath,
          confidence,
          escalate,
          escalationReason,
          scoreBreakdown,
        },
      });
    } catch (e) {
      console.error("scan stream failed:", e instanceof Error ? e.message : e);
      await emit({ t: "error", error: "The scan failed unexpectedly." });
    } finally {
      try {
        await writer.close();
      } catch {
        // already closed
      }
    }
  };

  // Keep the edge worker alive until the streamed body is fully produced —
  // without this, Supabase can retire the worker after the headers flush and
  // truncate a multi-second scan mid-stream.
  const edgeRuntime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
  }).EdgeRuntime;
  const producing = produce();
  if (edgeRuntime) edgeRuntime.waitUntil(producing);
  return streamResponse(readable);
});
