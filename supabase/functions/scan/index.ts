/**
 * ClaudeRabbit — fast-path scan orchestrator (Supabase Edge Function).
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
  checkBurstLimit,
  clientIpFromRequest,
  rateLimitedResponseInit,
} from "../_shared/rate-limit.ts";
import {
  type FetchedFile,
  GitHubRateLimitError,
  type OwnerSignal,
  ownerSignal,
  PrivateRepoError,
  type RepoMetadata,
  RepoNotFoundError,
  resolveRepo,
} from "../_shared/github.ts";
import {
  computeSeverityHint,
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
import { verifyUnrecognizedHosts } from "../_shared/host-verify.ts";
import {
  isValidNpmName,
  type NpmDivergence,
  type NpmMetadata,
  NpmIntegrityError,
  NpmNotFoundError,
  type NpmTarget,
  resolveNpmPackage,
} from "../_shared/npm.ts";

// --- Types mirroring lib/types.ts Report shape (what the UI expects) --------

interface ScanRequest {
  owner?: string;
  repo?: string;
  ref?: string;
  deviceId?: string;
  userId?: string;
  /**
   * npm-ecosystem target. When `ecosystem === "npm"`, the scan resolves and scans
   * the published REGISTRY ARTIFACT for `package` (+ optional `version`/dist-tag) —
   * the actual tarball `npm install` fetches, integrity-verified — NOT the GitHub
   * repo its package.json happens to link to (which can silently diverge from the
   * published bytes). See _shared/npm.ts. `owner`/`repo` are ignored for npm.
   */
  ecosystem?: string;
  package?: string;
  version?: string;
}

type Ecosystem = "github" | "npm";

/**
 * Normalized scan subject. The GitHub and npm resolution paths both produce this,
 * so the shared pipeline (cache → static scan → read model → score → persist) runs
 * identically regardless of ecosystem. For npm, `metadata` is synthesized from the
 * registry manifest and `cacheKey` is the artifact integrity digest (the GitHub
 * path's commit SHA has no analogue for a published tarball).
 */
interface ScanSubject {
  ecosystem: Ecosystem;
  ownerLogin: string;
  repoName: string;
  cacheKey: string;
  ref: string;
  files: FetchedFile[];
  metadata: RepoMetadata;
  npm?: NpmMetadata;
  divergence?: NpmDivergence;
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
 * user, so it yields null. A `cr_cli_`-prefixed bearer is a CLI/MCP login
 * token (see `issue_cli_token`/`verify_cli_token`, migration
 * 20260704000001_cli_tokens.sql) and is verified against that table. Any
 * other bearer is treated as a user session JWT and verified against GoTrue
 * via `auth.getUser(token)`; a valid token yields its user id. Verification
 * failure (expired/garbage token, network error) degrades to null so the web
 * app's scan still proceeds as the logged-out free flow — the CLI/MCP login
 * GATE (below, in the request handler) is what actually turns a null id into
 * a refusal for those two callers specifically.
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

  if (token.startsWith("cr_cli_")) {
    try {
      const db = serviceClient();
      const { data, error } = await db.rpc("verify_cli_token", { p_token: token });
      if (error || typeof data !== "string") return null;
      return data;
    } catch (e) {
      console.error("cli token verify failed:", e instanceof Error ? e.message : e);
      return null;
    }
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
 * CLI/MCP calls identify themselves with this header (never sent by the web
 * app) and, as of the login requirement, MUST resolve to a real user via
 * `verifiedUserId` above or be refused — a real product/access decision
 * (CLAUDE.md: the web app itself stays fully anonymous-friendly; this gate
 * is scoped to the two distribution surfaces only, via this header).
 */
const CLI_CLIENT_HEADER = "x-clauderabbit-client";
const SIGN_IN_URL = `${(Deno.env.get("SITE_URL") ?? "https://clauderabbit.in").replace(/\/+$/, "")}/cli-auth`;

function clientKind(req: Request): "cli" | "mcp" | null {
  const v = (req.headers.get(CLI_CLIENT_HEADER) ?? "").trim().toLowerCase();
  return v === "cli" || v === "mcp" ? v : null;
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
    "You are the ClaudeRabbit security analyst. ClaudeRabbit is a free tool that",
    "tells a developer whether a stranger's public GitHub repo is safe to run.",
    "You score 0-100 and write an honest, plain-language report.",
    "",
    "You are given: repository metadata, an OWNER reputation signal, a set of",
    "STATIC-FLAGGED REGIONS (file + reason + snippet), and the repo's own README",
    "as DECLARED SETUP/INSTALL INTENT. Read ONLY the flagged regions, the",
    "metadata, and the README — you are not given the full repo. Comprehend the",
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
    "4. PHASE-AWARE like the dynamic sandbox: a region reason phrased as",
    "   'provisioning fetch to a recognized software-distribution host (...) —",
    "   supply-chain caution, not a confirmed attack on its own' describes a",
    "   normal BUILD/PROVISION-time fetch (installing a named, intended tool from",
    "   its own known distribution point — github, a package registry, docker,",
    "   deno.land, etc.) with no credential access. Treat it as a minor, worth-",
    "   mentioning caution, not as evidence of malice, and do not let it alone",
    "   push the verdict toward 'Malicious'. The SAME treatment applies to a",
    "   region reason phrased as '...live-verified as a real responding host...'",
    "   — a real, live HTTPS check (not a static list) already confirmed this",
    "   host is a genuine, reachable web service; treat it identically to a",
    "   recognized-host caution, not as an unresolved risk needing more hedging.",
    "   A region phrased as '...could not be live-verified — treated as a",
    "   confirmed attack', or any credential-access finding, is a genuine signal",
    "   and must be weighted normally — this narrows ONE specific false-positive",
    "   class, it does not soften real attack detection.",
    "5. CROSS-REFERENCE declared intent (the README) against actual flagged",
    "   behavior — a real legitimacy signal, not decoration. If the README",
    "   describes needing to fetch/install/build something specific during",
    "   setup, and a flagged region shows exactly that (the same host, tool, or",
    "   package), that consistency is real evidence the code does what it",
    "   documents — cite it and let it REDUCE severity for that specific",
    "   finding, same spirit as a recognized-host caution. This NEVER softens",
    "   anything the README does not mention: install-time network/shell",
    "   activity, credential access, or obfuscation with NO corresponding",
    "   disclosure in the README is undisclosed behavior — a worse signal than",
    "   silence, not a neutral one, and must be named as such. A repo with no",
    "   README, or one that says nothing about setup, gives you no cross-",
    "   reference either way — do not penalize or credit its absence.",
    "6. TEST-FIXTURE / SECURITY-TOOLING context: a flagged region reason ending",
    "   '(test-fixture context)' is a credential-path reference found inside a",
    "   clearly test/fixture/example file — the shape a security tool's own honest",
    "   attack-SIMULATION fixtures take (a fixture that pretends to read",
    "   ~/.aws/credentials to prove a sandbox catches it). Treat it as a self-",
    "   contained simulation, NOT a runtime credential theft, WHEN the repo's",
    "   declared purpose (README/metadata) is consistent with being a security",
    "   tool, scanner, malware-sample corpus, or test suite. This narrows ONE",
    "   false-positive class and does NOT soften real attack detection: the SAME",
    "   file still keeps full weight for obfuscation, an embedded live secret, an",
    "   install hook, or hardcoded-IP egress (those are never downgraded), and a",
    "   'fixture' whose behavior CONTRADICTS a repo that is not a security/test",
    "   project — a credential read plus real undisclosed egress in an app that",
    "   claims to be a to-do list — is undisclosed behavior wearing a test label,",
    "   a WORSE signal, not a neutral one. Name it as such and escalate.",
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

/** Cap on the README excerpt handed to the model — enough for a real setup/
 * install section, bounded so the fast path stays cheap. */
const DECLARED_INTENT_MAX_CHARS = 2000;

/**
 * Extract a bounded excerpt of the repo's own README, if one was fetched —
 * the model's own reading comprehension of "what does this project SAY it
 * does during setup" (a legitimacy cross-reference: a fetch/behavior the
 * code performs that the README already discloses is a real positive signal;
 * one that goes UNDISCLOSED or contradicts stated purpose is not softened).
 * README is always fetched when present (github.ts selectPaths) but is
 * treated as a doc file by staticScan — plain prose in it does NOT trip the
 * regex-based flagged-region patterns, so without this it would never reach
 * the model at all despite being read into `files` already.
 */
export function extractDeclaredIntent(files: FetchedFile[]): string | null {
  const readme = files.find((f) => /^readme(\.|$)/i.test(f.path.split("/").pop() ?? ""));
  if (!readme || !readme.content.trim()) return null;
  const text = readme.content.trim();
  return text.length > DECLARED_INTENT_MAX_CHARS
    ? text.slice(0, DECLARED_INTENT_MAX_CHARS) + "\n…[README truncated for length]"
    : text;
}

function buildUserPrompt(
  metadata: RepoMetadata,
  owner: OwnerSignal,
  scan: StaticScanResult,
  commitSha: string,
  fileCount: number,
  declaredIntent: string | null,
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
    "=== DECLARED SETUP/INSTALL INTENT (the repo's own README, informational — ",
    "cross-reference against the flagged regions above, do not treat by itself ",
    "as a code/behavior finding) ===",
    declaredIntent ?? "(no README fetched, or it was empty)",
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
  /** Whether the owner was classified "new" (< NEW_OWNER_AGE_DAYS) at decision
   * time — computed here (the single source of truth for that threshold check)
   * and threaded into `ScoringInputs.wasNewOwner` so the scoring engine's
   * `hasRealCodeSignal` gate can tell a new-owner+network escalation (a real,
   * signal-driven reason to escalate) apart from an established-owner escalation
   * where network was merely present but never itself a qualifying reason (see
   * the `newOwner && anySignal` branch below — for a non-new owner, network
   * alone never escalates). Exposing this avoids recomputing the threshold a
   * second time in scoring and risking the two definitions drifting apart. */
  wasNewOwner: boolean;
}

function decideEscalation(
  model: ModelOutput,
  scan: StaticScanResult,
  owner: OwnerSignal,
  confidence: number,
): EscalationDecision {
  const newOwner = owner.ageDays >= 0 && owner.ageDays < NEW_OWNER_AGE_DAYS;

  // Code/behavior triggers first (heaviest), then reputation-driven, then the
  // model's own request — each yields a specific written reason.
  if (scan.signals.obfuscation) {
    return {
      escalate: true,
      reason: "obfuscated/encoded payload detected on static read",
      wasNewOwner: newOwner,
    };
  }
  if (scan.signals.credAccess) {
    return {
      escalate: true,
      reason: "credential-access pattern detected on static read",
      wasNewOwner: newOwner,
    };
  }
  if (scan.installTimeNetwork) {
    return {
      escalate: true,
      reason: "install-time network/shell activity detected on static read",
      wasNewOwner: newOwner,
    };
  }
  const anySignal = scan.signals.installHook || scan.signals.network ||
    scan.signals.embeddedSecret || scan.signals.typosquat;
  if (newOwner && anySignal) {
    return {
      escalate: true,
      reason: `new owner account (${owner.ageDays}d) combined with a code signal`,
      wasNewOwner: newOwner,
    };
  }
  if (confidence < CONFIDENCE_ESCALATION_THRESHOLD) {
    return {
      escalate: true,
      reason: `low read confidence (${confidence.toFixed(2)} < ${CONFIDENCE_ESCALATION_THRESHOLD})`,
      wasNewOwner: newOwner,
    };
  }
  if (model.escalate === true) {
    return {
      escalate: true,
      reason: "read model could not confidently clear the repo",
      wasNewOwner: newOwner,
    };
  }
  // Not escalating — state plainly why it cleared on the static read.
  const clearedWhy = scan.severityHint === "clean"
    ? "no code signals flagged"
    : `only low-severity signals (${scan.severityHint}) and confident read`;
  return {
    escalate: false,
    reason: `cleared on static read: ${clearedWhy}`,
    wasNewOwner: newOwner,
  };
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

// --- npm subject resolution --------------------------------------------------

/** Publish-age label + days for an npm package, matching github.ts's owner form. */
function npmAgeLabel(firstPublishedAt: string | null): { label: string; days: number } {
  if (!firstPublishedAt) return { label: "unknown", days: -1 };
  const t = Date.parse(firstPublishedAt);
  if (!Number.isFinite(t)) return { label: "unknown", days: -1 };
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 0) return { label: "unknown", days: -1 };
  if (days < 31) return { label: `${days} day${days === 1 ? "" : "s"}`, days };
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  if (years === 0) return { label: `${months} mo`, days };
  return { label: `${years} yr${months > 0 ? ` ${months} mo` : ""}`, days };
}

/**
 * Reputation signal for an npm PACKAGE — publisher/package standing, kept
 * structurally SEPARATE from the artifact's code/behavior exactly like the GitHub
 * owner signal. Publish age drives the new-package penalty (npm's dominant malware
 * vector is brand-new throwaway packages); "established" additionally requires real
 * adoption (last-month downloads), so a year-old package nobody installs is not
 * vouched-for. npm has no stars, so `stars` stays 0 — adoption is carried honestly
 * by the downloads figure surfaced in the report, never conflated with GitHub stars.
 */
function npmReputationSignal(npm: NpmMetadata): OwnerSignal {
  const age = npmAgeLabel(npm.firstPublishedAt);
  const downloads = npm.lastMonthDownloads ?? 0;
  const established = age.days >= 365 && downloads >= 10_000 && npm.maintainerCount >= 1;
  return {
    login: npm.name,
    type: "npm package",
    name: npm.name,
    createdAt: npm.firstPublishedAt,
    ageLabel: age.label,
    ageDays: age.days,
    publicRepos: npm.maintainerCount,
    established,
    location: null,
  };
}

/** Synthesize a RepoMetadata for an npm artifact so the shared prompt + persist
 * path run unchanged. Fields with no npm analogue are zero; adoption lives in the
 * reputation signal's download count, not in `stars`. */
function npmRepoMetadata(npm: NpmMetadata): RepoMetadata {
  return {
    ownerLogin: "npm",
    repoName: npm.name,
    fullName: `npm:${npm.name}@${npm.version}`,
    defaultBranch: npm.version,
    description: npm.description,
    language: "JavaScript/TypeScript",
    stars: 0,
    forks: 0,
    openIssues: 0,
    sizeKb: 0,
    createdAt: npm.firstPublishedAt,
    pushedAt: npm.publishedAt,
    license: npm.license,
    hasLockfile: false,
    isPrivate: false,
    visibility: "public",
  };
}

/** Resolve an npm target into the normalized scan subject. */
async function resolveNpmSubject(target: NpmTarget): Promise<ScanSubject> {
  const r = await resolveNpmPackage(target);
  return {
    ecosystem: "npm",
    ownerLogin: "npm",
    repoName: r.metadata.name,
    cacheKey: r.artifactKey,
    ref: r.metadata.version,
    files: r.files,
    metadata: npmRepoMetadata(r.metadata),
    npm: r.metadata,
    divergence: r.divergence,
  };
}

/**
 * npm-artifact facts (integrity, divergence from the linked source repo) as flagged
 * regions the read model reads and the report cites. An install hook present in the
 * PUBLISHED artifact but NOT in the linked repo — or a tarball that failed its own
 * integrity check — is the compromised-publish shape and forces escalation (see the
 * caller). The install hooks THEMSELVES are already caught by the static scan over
 * the tarball's package.json; these regions add the source-divergence trust signal.
 */
function npmArtifactRegions(npm: NpmMetadata, div: NpmDivergence): FlaggedRegion[] {
  const regions: FlaggedRegion[] = [];
  const id = `${npm.name}@${npm.version}`;
  if (!npm.integrityVerified) {
    regions.push({
      file: "npm artifact",
      reason:
        "the published tarball could not be integrity-verified against the registry's own digest",
      snippet: id,
    });
  }
  for (const note of div.notes) {
    regions.push({ file: "npm artifact", reason: note, snippet: id });
  }
  return regions;
}

/** True when npm divergence/integrity facts on their own warrant a live detonation
 * (a source-divergent install hook, or an unverifiable artifact). */
function npmForcesEscalation(npm: NpmMetadata | null, div: NpmDivergence | null): boolean {
  if (!npm) return false;
  if (!npm.integrityVerified) return true;
  return !!div && div.addedInstallHooks.length > 0;
}

/** Extra prompt context for an npm scan: the model is told it is reading the REAL
 * published artifact (not a repo), the integrity/divergence facts, and how to weigh
 * a source-divergent install hook (the compromised-publish tell). */
function npmPromptContext(npm: NpmMetadata, div: NpmDivergence | null): string {
  const lines = [
    "",
    "=== npm PUBLISHED-ARTIFACT CONTEXT (code-side facts) ===",
    "You are reading the ACTUAL published npm tarball that `npm install` fetches —",
    "the real installed bytes, NOT a linked GitHub repo (the two can diverge; a",
    "compromised publish can ship a malicious install hook or trojaned module that",
    "exists only in the tarball).",
    `package: ${npm.name}@${npm.version}`,
    `tarball integrity: ${npm.integrityVerified ? `verified (${npm.integrityAlgo})` : "NOT verified — no/failed registry digest"}`,
    `declares an install hook (preinstall/install/postinstall): ${npm.hasInstallHook}`,
    `first published: ${npm.firstPublishedAt ?? "unknown"} · last-month downloads: ${npm.lastMonthDownloads ?? "unknown"} · maintainers: ${npm.maintainerCount}`,
    `linked source repo: ${npm.linkedRepo ? `github.com/${npm.linkedRepo.owner}/${npm.linkedRepo.repo}` : "none declared"}`,
  ];
  if (div && div.compared) {
    if (div.addedInstallHooks.length > 0) {
      lines.push(
        `SOURCE DIVERGENCE: install hook(s) [${div.addedInstallHooks.join(", ")}] exist in the`,
        "PUBLISHED artifact but NOT in the linked source repo. This is the shape of a",
        "compromised-publish supply-chain attack — weight it as a strong code signal,",
        "not a neutral one, unless the code plainly shows an innocent, disclosed reason.",
      );
    } else {
      lines.push(
        "Source cross-check: the artifact's install hooks match its linked source repo",
        "(no install-time behavior was injected only into the tarball).",
      );
    }
  } else if (npm.hasInstallHook) {
    lines.push(
      "Source cross-check: could not corroborate the artifact's install hook(s) against",
      "a linked source repo — judge the hook on the code itself, framed as unverified.",
    );
  }
  return lines.join("\n");
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

  // Ecosystem: an npm target scans the published registry ARTIFACT; anything else
  // is a GitHub repo. The two share every downstream stage — they differ only in
  // how the subject (files + metadata + reputation) is resolved.
  const isNpm = (body.ecosystem ?? "").trim().toLowerCase() === "npm";

  let npmTarget: NpmTarget | null = null;
  const ownerInput = (body.owner ?? "").trim();
  const repoInput = (body.repo ?? "").trim();
  let refInput: string | undefined;

  if (isNpm) {
    const pkg = (body.package ?? "").trim();
    if (!pkg) {
      return jsonResponse({ error: "package is required for an npm scan" }, 400);
    }
    if (!isValidNpmName(pkg)) {
      return jsonResponse({ error: "package is not a valid npm package name" }, 400);
    }
    const version = (body.version ?? "").trim() || undefined;
    if (version && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/.test(version)) {
      return jsonResponse({ error: "version/tag contains invalid characters" }, 400);
    }
    npmTarget = { name: pkg, ...(version ? { version } : {}) };
  } else {
    if (!ownerInput || !repoInput) {
      return jsonResponse({ error: "owner and repo are required" }, 400);
    }
    if (!isValidOwnerRepo(ownerInput) || !isValidOwnerRepo(repoInput)) {
      return jsonResponse({ error: "owner/repo contain invalid characters" }, 400);
    }
    // Validate the optional ref (branch/tag/sha) — bounded charset + length.
    refInput = (body.ref ?? "").trim() || undefined;
    if (refInput && !/^[A-Za-z0-9._\-/]{1,200}$/.test(refInput)) {
      return jsonResponse({ error: "ref contains invalid characters" }, 400);
    }
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

  // CLI/MCP login gate: a real product/access decision, scoped to these two
  // distribution surfaces only via the client-identifying header — the web
  // app never sends it and stays fully anonymous-friendly (CLAUDE.md).
  const caller = clientKind(req);
  if (caller && !userId) {
    return jsonResponse(
      {
        error: `Sign in to use the ClaudeRabbit ${caller === "cli" ? "CLI" : "MCP server"}.`,
        signInUrl: SIGN_IN_URL,
      },
      401,
    );
  }

  let db: SupabaseClient;
  try {
    db = serviceClient();
  } catch {
    console.error("config error: server misconfigured (key unavailable or rejected)");
    return jsonResponse({ error: "Server is not configured correctly" }, 500);
  }

  // 0. BURST/VELOCITY RATE LIMIT (BUG-9 security review) — BEFORE any expensive
  // work (the live GitHub API call in resolveRepo, the billed Vertex model call,
  // and the DB writes). Scans stay UNLIMITED per day (no quota is reintroduced);
  // this only throttles a scripted flood of requests-per-minute from one source,
  // which would otherwise drain the shared GitHub token and the model budget. A
  // human or a CLI/MCP agent making occasional real scans never reaches the cap.
  //
  // Keyed by the trustworthy client IP (cf-connecting-ip / leftmost XFF — see
  // clientIpFromRequest for the empirical reason the earlier rightmost-hop
  // derivation was broken for Supabase's edge topology) AND the hashed device id,
  // whichever trips first — so a flood is caught whether it rotates device ids
  // (IP bucket catches it) or hides behind a NAT/proxy pool with one device
  // fingerprint (device bucket catches it). For every UNAUTHENTICATED request
  // (no server-verified user session) a coarse system-wide circuit breaker also
  // applies, so a flood spread across many real IPs is still bounded in aggregate.
  //
  // `unauthenticated` is `userId === null` ONLY — deliberately NOT `&& deviceId
  // === null`. deviceId is unauthenticated, caller-controlled body input; folding
  // it into this gate was a real bypass (send a random deviceId per request →
  // "non-anonymous" → global breaker skipped, while the per-IP/per-device buckets
  // also never accumulate). Only a real signed-in session is exempt. The limiter
  // fails OPEN on any DB error, so it can never take the endpoint down or block
  // the free first scan.
  const clientIp = clientIpFromRequest(req);
  const unauthenticated = userId === null;
  const burst = await checkBurstLimit(db, {
    ip: clientIp,
    deviceIdHash: deviceId,
    unauthenticated,
  });
  if (!burst.allowed) {
    console.error(
      `rate limited (${burst.trippedBy}) ip=${clientIp ?? "none"} retryAfter=${burst.retryAfter}s`,
    );
    const init = rateLimitedResponseInit(burst.retryAfter);
    return jsonResponse(init.body, 429, init.headers);
  }

  // 1. Resolve the scan SUBJECT — a GitHub repo, OR the published npm artifact.
  //
  // SAFETY RAIL (public-only): resolveRepo refuses any non-public repo by throwing
  // PrivateRepoError immediately after reading repo metadata — BEFORE it fetches any
  // file contents. We catch it here and return a clear 403 with NO cache touch, NO
  // model call, and NO DB write. A private repo never reaches analysis or the public
  // report. The npm path only ever touches the PUBLIC registry, so it has no
  // private-artifact analogue; it refuses a tampered/unverifiable tarball (422) so
  // we never scan bytes we cannot prove are the ones the registry vouches for.
  let subject: ScanSubject;
  try {
    if (npmTarget) {
      subject = await resolveNpmSubject(npmTarget);
    } else {
      const resolved = await resolveRepo(ownerInput, repoInput, refInput);
      subject = {
        ecosystem: "github",
        ownerLogin: resolved.metadata.ownerLogin,
        repoName: resolved.metadata.repoName,
        cacheKey: resolved.commitSha,
        ref: resolved.ref,
        files: resolved.files,
        metadata: resolved.metadata,
      };
    }
  } catch (e) {
    if (e instanceof PrivateRepoError) return jsonResponse({ error: e.message }, 403);
    if (e instanceof RepoNotFoundError || e instanceof NpmNotFoundError) {
      return jsonResponse({ error: e.message }, 404);
    }
    if (e instanceof GitHubRateLimitError) return jsonResponse({ error: e.message }, 429);
    if (e instanceof NpmIntegrityError) return jsonResponse({ error: e.message }, 422);
    console.error("subject resolution failed:", e instanceof Error ? e.message : e);
    return jsonResponse(
      { error: npmTarget ? "Could not resolve npm package" : "Could not resolve repository" },
      502,
    );
  }

  const ecosystem = subject.ecosystem;
  const npmMeta = subject.npm ?? null;
  const divergence = subject.divergence ?? null;
  const metadata = subject.metadata;
  const commitSha = subject.cacheKey;
  const ref = subject.ref;
  const files = subject.files;
  const ownerLogin = subject.ownerLogin;
  const repoName = subject.repoName;

  // Defense in depth: even if resolveRepo's guard were bypassed, never analyze or
  // persist a non-public GitHub repo. (npm subjects are always public-registry.)
  if (metadata.isPrivate || metadata.visibility !== "public") {
    return jsonResponse(
      { error: "ClaudeRabbit only scans public repositories." },
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
        ch: ecosystem === "npm" ? "Resolve npm artifact" : "Resolve",
        status: "done",
        kind: "ok",
        lines: ecosystem === "npm" && npmMeta
          ? [
            `Resolved npm ${npmMeta.name}@${npmMeta.version} — the published registry artifact` +
            (npmMeta.integrityVerified
              ? ` (integrity-verified, ${npmMeta.integrityAlgo})`
              : " (NO registry integrity digest — unverified)"),
            `${files.length} file(s) unpacked from the tarball` +
            (npmMeta.linkedRepo
              ? ` · linked source: github.com/${npmMeta.linkedRepo.owner}/${npmMeta.linkedRepo.repo}`
              : " · no linked source repo declared"),
          ]
          : [
            `Resolved ${ownerLogin}/${repoName}@${commitSha.slice(0, 7)}`,
            `${files.length} file(s) in the tree at the resolved SHA`,
          ],
      });

      // 3. Static scan → flagged regions (code signals only). For an npm artifact,
      // this runs over the REAL published tarball's files, so an install hook or
      // trojaned module that exists only in the artifact (not its linked repo) is
      // scanned directly. The artifact/divergence facts are folded in as regions.
      await emit({ t: "stage", ch: "Static scan", status: "active" });
      let scan = staticScan(files);
      if (npmMeta && divergence) {
        const extra = npmArtifactRegions(npmMeta, divergence);
        if (extra.length > 0) {
          scan = { ...scan, flaggedRegions: [...scan.flaggedRegions, ...extra] };
        }
      }
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

      // 3b. Live host verification — a static allowlist is necessarily
      // incomplete, so an unrecognized-but-real host (this already produced
      // a false "Malicious" on this project's own repo: storage.googleapis.
      // com, opencode.ai — both real, legitimate hosts simply not on the
      // list) must not, on its own, keep full attack-grade weight. A cheap,
      // real HTTPS check (no headless browser — unnecessary cost for this
      // question) to each still-unrecognized host's own root, run ONLY when
      // installTimeNetwork wasn't ALSO independently triggered by a harder
      // signal (installTimeNetworkHard — a hardcoded IP, an npm lifecycle
      // hook, or credential access in the same file), which is never
      // eligible for this downgrade.
      if (!scan.installTimeNetworkHard && scan.unrecognizedInstallHosts.length > 0) {
        await emit({ t: "stage", ch: "Host verification", status: "active" });
        const t0 = Date.now();
        const verified = await verifyUnrecognizedHosts(scan.unrecognizedInstallHosts);
        const elapsedMs = Date.now() - t0;
        const allLegitimate = scan.unrecognizedInstallHosts.every(
          (h) => verified.get(h)?.legitimate === true,
        );
        const detailLines = scan.unrecognizedInstallHosts.map(
          (h) => `${h}: ${verified.get(h)?.signal ?? "check did not complete"}`,
        );
        // Resolve each affected region's "pending live verification" text to
        // the real per-host outcome — a persisted report must never leave a
        // permanently-unresolved-sounding "pending" in a finding a user reads
        // after the fact.
        const resolvedRegions = scan.flaggedRegions.map((r) => {
          const match = scan.unrecognizedInstallHosts.find(
            (h) => r.reason === `shell network fetch to an unrecognized host (${h}) — pending live verification`,
          );
          if (!match) return r;
          const v = verified.get(match);
          return {
            ...r,
            reason: v?.legitimate === true
              ? `provisioning fetch to ${match}, live-verified as a real responding host — supply-chain caution, not a confirmed attack on its own`
              : `shell network fetch to ${match}, an unrecognized host that could not be live-verified — treated as a confirmed attack`,
          };
        });
        if (allLegitimate) {
          const installTimeNetwork = false;
          scan = {
            ...scan,
            flaggedRegions: resolvedRegions,
            installTimeNetwork,
            severityHint: computeSeverityHint(scan.signals, installTimeNetwork),
          };
        } else {
          scan = { ...scan, flaggedRegions: resolvedRegions };
        }
        await emit({
          t: "stage",
          ch: "Host verification",
          status: "done",
          kind: allLegitimate ? "ok" : "warn",
          lines: [
            allLegitimate
              ? `${scan.unrecognizedInstallHosts.length} unrecognized host(s) verified live (${elapsedMs}ms) — real, responding services, not confirmed attacks`
              : `${scan.unrecognizedInstallHosts.length} unrecognized host(s) checked (${elapsedMs}ms) — not all confirmed live, keeping full weight`,
            ...detailLines,
          ],
        });
      }

      // 4. Reputation signal (kept SEPARATE from code/behavior). For npm this is
      // the PACKAGE/publisher standing (publish age, maintainers, monthly
      // downloads); for GitHub it is the OWNER account standing. Same structural
      // separation, different source.
      await emit({ t: "stage", ch: "Reputation", status: "active" });
      let owner: OwnerSignal;
      if (npmMeta) {
        owner = npmReputationSignal(npmMeta);
      } else {
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
      }
      await emit({
        t: "stage",
        ch: "Reputation",
        status: "done",
        kind: "ok",
        lines: npmMeta
          ? [
            `Package ${npmMeta.name} · first published ${owner.ageLabel} ago · ${npmMeta.maintainerCount} maintainer(s)` +
            (owner.established ? " · established" : " · new/low-adoption"),
            `${npmMeta.lastMonthDownloads != null ? formatNumber(npmMeta.lastMonthDownloads) : "unknown"} downloads/month (kept separate from code signals)`,
          ]
          : [
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
          prompt: buildUserPrompt(metadata, owner, scan, commitSha, files.length, extractDeclaredIntent(files)) +
            (npmMeta ? npmPromptContext(npmMeta, divergence) : ""),
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
      // (escalating OR cleared-on-static-read) for the report. For npm, a
      // source-divergent install hook or an unverifiable artifact forces a live
      // detonation even if the static read alone would have cleared it — the
      // artifact not matching its claimed source is itself worth running for real.
      let escalation = decideEscalation(model, scan, owner, confidence);
      if (!escalation.escalate && npmForcesEscalation(npmMeta, divergence)) {
        escalation = {
          escalate: true,
          reason: npmMeta && !npmMeta.integrityVerified
            ? "published npm artifact could not be integrity-verified"
            : "published npm artifact declares install hook(s) absent from its linked source (source divergence)",
          wasNewOwner: escalation.wasNewOwner,
        };
      }
      // OPERATOR OVERRIDE: force a live sandbox detonation for specific targets even when
      // the static read cleared them — set via the CR_FORCE_DEEP_TARGETS secret (a comma-
      // separated list of "owner/repo", case-insensitive). This is the honest way to get a
      // genuine sandbox-verified report for a repo that reads clean statically (e.g. this
      // product's own repo for its public/marketing report): it forces the RUN, it does NOT
      // touch the static signals or the score — whatever the sandbox observes is the real
      // number. Off by default (no env → no effect), so it is inert on any normal scan.
      if (!escalation.escalate) {
        const forceTargets = (Deno.env.get("CR_FORCE_DEEP_TARGETS") ?? "")
          .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (forceTargets.includes(`${ownerLogin}/${repoName}`.toLowerCase())) {
          escalation = {
            escalate: true,
            reason: "operator-forced live sandbox verification for this target",
            wasNewOwner: escalation.wasNewOwner,
          };
        }
      }
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
        // Threaded from the SAME decision that decided whether/why to escalate,
        // so the scoring engine's `hasRealCodeSignal` gate can require
        // `network && wasNewOwner` (matching `decideEscalation`'s own
        // `newOwner && anySignal` branch) instead of treating plain network as
        // always signal-worthy regardless of owner age.
        wasNewOwner: escalation.wasNewOwner,
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
        // npm has no stars/forks — show "—" rather than a misleading "0". The
        // package's real adoption (monthly downloads) is stated in the Reputation
        // log chapter, not conflated into a stars count.
        stars: npmMeta ? "—" : formatNumber(metadata.stars),
        forks: npmMeta ? "—" : formatNumber(metadata.forks),
        sentiment: model.reputation?.sentiment ?? "",
        sentScore: typeof model.reputation?.sentScore === "number"
          ? Math.round(clamp(model.reputation.sentScore, 0, 100, 0))
          : 0,
        // U4: the owner's GitHub location, stored so the world map can plot a dot at
        // every scanned repo's geographic ORIGIN (resolved client-side). Free text;
        // null when the owner did not set one. Not rendered in the report itself.
        location: owner.location ?? null,
      };

      // 8. Persist — owner reputation, report, scan event. The `owners` table is
      // GitHub-owner-keyed (github_login, public_repos, stars_total), so it is
      // written ONLY for a GitHub scan. An npm package has no GitHub owner row;
      // its report persists with owner_id=null and carries the package reputation
      // in the fresh render (ownerView) + the Reputation log chapter.
      let ownerId: number | null = null;
      if (!npmMeta) {
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
      }

      const stats = model.stats ?? {
        loc: "—",
        packages: model.packages?.length ?? 0,
        stars: npmMeta ? "—" : formatNumber(metadata.stars),
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
