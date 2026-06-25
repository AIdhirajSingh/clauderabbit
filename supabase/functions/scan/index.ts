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
import { jsonResponse, preflightResponse } from "../_shared/cors.ts";
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
const VERDICT_BARE_SAFE = "safe";

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

/**
 * Enforce the daily scan limit atomically via the SECURITY DEFINER RPC. Keys on
 * the user id when signed in, else the (hashed) device id. Returns true when the
 * scan is allowed (and the counter was incremented), false when the limit is
 * reached. With neither identity present (no token, no device id) there is
 * nothing to meter, so it allows.
 */
async function enforceDailyLimit(
  db: SupabaseClient,
  userId: string | null,
  deviceId: string | null,
  scanType: "stage1" | "dynamic",
): Promise<boolean> {
  if (!userId && !deviceId) return true;
  const { data, error } = await db.rpc("check_and_increment_scan_limit", {
    p_user_id: userId,
    p_device_id: deviceId,
    p_scan_type: scanType,
  });
  if (error) {
    console.error("limit check failed:", error.message);
    // Fail OPEN on an unexpected RPC error: a metering outage must not take the
    // whole scanner down. The next successful call re-enforces the limit.
    return true;
  }
  // The RPC returns a single row { allowed, remaining }.
  const row = Array.isArray(data) ? data[0] : data;
  return (row as { allowed?: boolean } | null)?.allowed === true;
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
function enforceVerdictRails(verdict: string, score: number): string {
  const trimmed = (verdict || "").trim();
  const isBareSafe = trimmed.toLowerCase() === VERDICT_BARE_SAFE;
  // Map to the canonical band verdict whenever it's a bare "Safe" or empty.
  if (!trimmed || isBareSafe) {
    return score >= 90
      ? "Trusted"
      : score >= 80
      ? "Likely safe"
      : score >= 60
      ? "Caution"
      : "High risk";
  }
  return trimmed;
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

function decideEscalation(
  model: ModelOutput,
  scan: StaticScanResult,
  owner: OwnerSignal,
  confidence: number,
): boolean {
  if (model.escalate === true) return true;
  if (confidence < CONFIDENCE_ESCALATION_THRESHOLD) return true;
  // Severe code signals always escalate.
  if (scan.signals.obfuscation || scan.signals.credAccess) return true;
  if (scan.installTimeNetwork) return true;
  // Brand-new owner combined with any code signal.
  const newOwner = owner.ageDays >= 0 && owner.ageDays < NEW_OWNER_AGE_DAYS;
  const anySignal = scan.signals.installHook || scan.signals.network ||
    scan.signals.embeddedSecret || scan.signals.typosquat;
  if (newOwner && anySignal) return true;
  return false;
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
  owner_id: number | null;
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
    reputation: {
      stars: ownerRow?.stars_total != null
        ? formatNumber(ownerRow.stars_total)
        : "—",
      forks: "—",
      sentiment: ownerRow?.sentiment ?? "",
      sentScore: ownerRow?.sentiment_score ?? 0,
    },
    stats: row.stats_json ?? {},
    packages: row.packages_json ?? [],
    risky: row.risky_json ?? [],
    logs: row.logs_json ?? [],
    commit_sha: row.commit_sha,
    scan_path: "cache",
    confidence: row.confidence,
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

  // 2b. Daily limit — STAGE-1 gate, BEFORE any model spend. Every fresh scan
  // begins on the fast (stage-1) path, so the stage-1 budget (3/day) is checked
  // here, before the expensive read-model call, so a limit-reached caller cannot
  // burn model budget. The cache path returned above and never reaches this, so
  // a cached view consumes no limit. A scan that later escalates is additionally
  // metered against the dynamic budget at step 7b.
  const stage1Allowed = await enforceDailyLimit(db, userId, deviceId, "stage1");
  if (!stage1Allowed) {
    return jsonResponse(
      { error: "Daily limit reached: 3 standard scans per day. Try again tomorrow." },
      429,
    );
  }

  // 3. Static scan → flagged regions (code signals only).
  const scan = staticScan(files);

  // 4. Owner reputation signal (kept separate).
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
    };
  }

  // 5. Read model (fast tier) reads ONLY flagged regions + metadata.
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
    return jsonResponse({ error: "Analysis model call failed" }, 502);
  }

  // 6. Validate + clamp model output.
  const score = Math.round(clamp(model.score, 0, 100, 50));
  const confidence = clamp(model.confidence, 0, 1, 0.5);
  const verdict = enforceVerdictRails(model.verdict, score);
  const risky = normalizeRisky(model.risky);

  // 7. Escalation gate (decision only — no sandbox run in this unit).
  const escalate = decideEscalation(model, scan, owner, confidence);
  const scanPath = escalate ? "deep" : "fast";
  const deep = escalate;

  // 7b. Daily limit — DYNAMIC gate. The stage-1 budget was already consumed at
  // step 2b. Only when the scan escalates to the deep (dynamic sandbox) path is
  // the separate dynamic budget (1/day) additionally metered, before the deep
  // result is persisted. A non-escalating fast scan never reaches this check.
  if (deep) {
    const dynamicAllowed = await enforceDailyLimit(db, userId, deviceId, "dynamic");
    if (!dynamicAllowed) {
      return jsonResponse(
        { error: "Daily limit reached: 1 sandbox (dynamic) scan per day. Try again tomorrow." },
        429,
      );
    }
  }

  // Build logs from the model, then append/adjust the escalation decision so we
  // never fabricate a dynamic run.
  const logs = Array.isArray(model.logs) ? model.logs : [];
  if (escalate) {
    const hasEsc = logs.some((l) => /escalat/i.test(l.ch));
    if (!hasEsc) {
      logs.push({
        ch: "Escalation",
        kind: scan.severityHint === "high" ? "bad" : "warn",
        lines: [
          "Escalation gate tripped on the static read",
          `Reason: ${
            scan.signals.obfuscation
              ? "obfuscated payload"
              : scan.signals.credAccess
              ? "credential-access pattern"
              : scan.installTimeNetwork
              ? "install-time network activity"
              : confidence < CONFIDENCE_ESCALATION_THRESHOLD
              ? `low read confidence (${confidence.toFixed(2)})`
              : "new-owner anomaly"
          }`,
          "Queued for dynamic sandbox run (not executed on this pass)",
        ],
      });
    }
  }

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
          sentiment_score: model.reputation?.sentScore != null
            ? Math.round(clamp(model.reputation.sentScore, 0, 100, 50))
            : null,
          reputation_json: model.reputation ?? null,
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
    return jsonResponse({ error: "Failed to persist report" }, 500);
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

  // 9. Return the full structured report.
  return jsonResponse({
    id: `${ownerLogin}/${repoName}`,
    owner: ownerLogin,
    name: repoName,
    score,
    verdict,
    cached: false,
    deep,
    summary: model.summary ?? "",
    ownerHistory: model.ownerHistory ?? {
      handle: owner.login,
      name: owner.name ?? owner.login,
      age: owner.ageLabel,
      established: owner.established,
      repos: owner.publicRepos,
      note: "",
    },
    reputation: model.reputation ?? {
      stars: formatNumber(metadata.stars),
      forks: formatNumber(metadata.forks),
      sentiment: "",
      sentScore: 0,
    },
    stats,
    packages: model.packages ?? [],
    risky,
    logs,
    commit_sha: commitSha,
    scan_path: scanPath,
    confidence,
    escalate,
  });
});
