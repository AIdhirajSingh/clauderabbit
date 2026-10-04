/**
 * Deep read — the escalated-tier BEHAVIOURAL analysis, run on Vertex.
 *
 * WHAT THIS IS. When the static read escalates a repo, this second pass sends the
 * flagged regions + install-script context to the DEEP model tier and asks it to
 * reason about what the code would DO when installed/run: which hosts it would
 * contact, what it would read or write, whether it is obfuscated, whether the
 * declared intent matches the behaviour.
 *
 * WHAT THIS IS NOT, and the rail that depends on saying so. This does NOT execute
 * anything. It is a deeper READ, not a detonation. It therefore cannot see:
 *   - a payload fetched at run time (the classic `postinstall` → fetch → exec:
 *     the malicious bytes are NOT in the package, so no reader can see them),
 *   - an endpoint assembled at run time from env/date/DGA,
 *   - behaviour gated on a sandbox/CI/date check that only fires elsewhere.
 * Those are exactly what a live run is for. The model is asked to NAME each such
 * gap in `unresolved`, and the caller surfaces them verbatim, so an escalated
 * report states plainly what was not verified instead of implying a runtime proof
 * it never had. A deep read must never be labelled or scored as a sandbox run.
 */

import { generate, type ModelBackend } from "./vertex.ts";
import type { FlaggedRegion, StaticScanResult } from "./static-scan.ts";

/** One predicted behaviour, tied to the evidence that predicts it. */
export interface DeepBehaviour {
  /** What the code would do, in plain language. */
  behaviour: string;
  /** Where that prediction comes from — file path, ideally with the construct. */
  evidence: string;
  /** network | filesystem | process | credential | obfuscation | other */
  kind: string;
  /** low | medium | high — how dangerous IF it happens. */
  severity: string;
}

export interface DeepReadResult {
  behaviours: DeepBehaviour[];
  /** Questions this pass could not settle WITHOUT running the code. */
  unresolved: string[];
  /** Model's own 0-1 confidence in the behavioural read. */
  confidence: number;
  /** One-line summary of predicted runtime behaviour. */
  summary: string;
}

const DEEP_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "number" },
    behaviours: {
      type: "array",
      items: {
        type: "object",
        properties: {
          behaviour: { type: "string" },
          evidence: { type: "string" },
          kind: { type: "string" },
          severity: { type: "string" },
        },
        required: ["behaviour", "evidence", "kind", "severity"],
      },
    },
    unresolved: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "confidence", "behaviours", "unresolved"],
};

function system(): string {
  return [
    "You are the deep-read tier of a security scanner. A static pass already",
    "FLAGGED this repository. Your job is to reason, from the flagged code, about",
    "what it would DO when a developer installs and runs it.",
    "",
    "You are READING, not running. Never claim you observed, executed, detonated,",
    "or confirmed anything at run time. Predict, and say what the prediction rests",
    "on.",
    "",
    "RULES:",
    "1. Every entry in `behaviours` cites concrete evidence — the file and the",
    "   construct. No behaviour without evidence you can point at.",
    "2. `unresolved` is REQUIRED and is the most important field. List every",
    "   question that genuinely CANNOT be settled by reading, including:",
    "   - any payload fetched at run time (you cannot see bytes that are not in",
    "     the repo — say which URL/command fetches them),",
    "   - any endpoint or command built at run time from variables,",
    "   - any behaviour behind an environment/date/CI/sandbox check.",
    "   If there is genuinely nothing unresolved, return an empty array — but be",
    "   honest, an install hook that fetches remote code is ALWAYS unresolved.",
    "3. Separate what the code DOES from who wrote it. Reputation is not your job.",
    "4. A test fixture or a security tool legitimately containing attack-shaped",
    "   code is not itself malicious — say so when that is the better reading.",
    "5. Do not inflate. A boring package is a boring package.",
  ].join("\n");
}

function userPrompt(
  fullName: string,
  commitSha: string,
  scan: StaticScanResult,
  installScripts: string,
): string {
  const regions = scan.flaggedRegions.length === 0
    ? "(none)"
    : scan.flaggedRegions
      .map((r: FlaggedRegion, i: number) =>
        `#${i + 1} [${r.file}] ${r.reason}\n    ${r.snippet}`
      )
      .join("\n");

  return [
    "=== TARGET ===",
    `repo: ${fullName}`,
    `commit: ${commitSha}`,
    `static severity hint: ${scan.severityHint}`,
    `install-time network indicators: ${scan.installTimeNetwork ? "yes" : "no"}`,
    scan.unrecognizedInstallHosts?.length
      ? `unrecognized install hosts: ${scan.unrecognizedInstallHosts.join(", ")}`
      : "unrecognized install hosts: (none)",
    "",
    "=== FLAGGED REGIONS ===",
    regions,
    "",
    "=== INSTALL / LIFECYCLE SCRIPTS ===",
    installScripts || "(none found)",
    "",
    "Reason about what this does when installed and run. Return JSON only.",
  ].join("\n");
}

/**
 * Run the deep behavioural read. Billed to Vertex AI (aiplatform.googleapis.com),
 * the same service the fast read already uses — this adds tokens to an existing
 * billing surface, it does not introduce a new one.
 *
 * Throws on model failure; the caller decides how to degrade. It must NOT silently
 * fall back to a clean-looking verdict.
 */
export async function runDeepRead(
  fullName: string,
  commitSha: string,
  scan: StaticScanResult,
  installScripts: string,
  backend?: ModelBackend,
): Promise<DeepReadResult> {
  const result = await generate({
    tier: "deep",
    backend,
    json: true,
    responseSchema: DEEP_SCHEMA,
    maxOutputTokens: 4096,
    // Deep tier earns a real thinking budget: this is the escalated path, and the
    // reasoning (does this fetch-and-exec, or is it a legitimate installer?) is
    // exactly what the budget is for.
    thinking: 2048,
    system: system(),
    prompt: userPrompt(fullName, commitSha, scan, installScripts),
  });

  const j = (result.json ?? {}) as Record<string, unknown>;
  const behaviours = Array.isArray(j.behaviours)
    ? (j.behaviours as DeepBehaviour[]).filter(
      (b) => b && typeof b.behaviour === "string" && b.behaviour.length > 0,
    )
    : [];
  const unresolved = Array.isArray(j.unresolved)
    ? (j.unresolved as unknown[]).filter((u): u is string =>
      typeof u === "string" && u.length > 0
    )
    : [];

  return {
    behaviours,
    unresolved,
    confidence: typeof j.confidence === "number" ? j.confidence : 0.5,
    summary: typeof j.summary === "string" ? j.summary : "",
  };
}

/**
 * The honest limit line. Always appended to a deep-read chapter, whatever the
 * model returned, so no escalated report can imply a runtime proof it never had.
 * This is the never-a-bare-Safe rail applied to the escalated tier.
 */
export const DEEP_READ_LIMIT =
  "Read-only analysis: the code was NOT executed, so run-time-fetched payloads and " +
  "run-time-built endpoints were not observed.";
