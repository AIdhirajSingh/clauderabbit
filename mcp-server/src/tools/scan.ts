/**
 * `scan` — the one ClaudeRabbit tool. Cache-aware by construction: if a
 * report already exists for the target's current commit/artifact, it comes
 * back immediately (same cache the web app itself hits); if not, a real
 * fast-path scan runs and its result comes back. The caller never needs to
 * know or choose which case they're in — this collapses what used to be two
 * separate tools (`scan_repo` / `get_report`) into one.
 *
 * Two target kinds: a GitHub repo (`owner` + `repo` [+ `ref`]) or an npm
 * package (`package` [+ `version`]). For npm the edge function scans the REAL
 * published registry artifact — the tarball `npm install` fetches, integrity-
 * verified — not the GitHub repo its package.json happens to link to.
 */

import { z } from "zod";
import {
  awaitForensics,
  runDeepScan,
  scanRepo as callScanRepo,
} from "../claude-rabbit-client.js";
import type { ScanArgs } from "../claude-rabbit-client.js";
import { readToken, signInRequiredResult } from "../auth.js";
import type { ClaudeRabbitConfig } from "../env.js";
import { formatReport } from "../format.js";

export const scanInputSchema = {
  owner: z
    .string()
    .min(1)
    .optional()
    .describe(
      "GitHub repository owner or org, e.g. \"sindresorhus\". Provide together with `repo` to scan a GitHub repository. Omit when scanning an npm package via `package`.",
    ),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("GitHub repository name, e.g. \"is\". Required together with `owner` for a GitHub scan."),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe("Optional git ref (branch, tag, or commit SHA) to scan instead of the default branch. GitHub scans only."),
  package: z
    .string()
    .min(1)
    .optional()
    .describe(
      "npm package to scan the REAL published registry artifact for (the tarball `npm install` actually fetches, not the repo its package.json links to). Provide this INSTEAD of owner/repo. Accepts a bare name (\"left-pad\"), a scoped name (\"@scope/name\"), an explicit \"npm:left-pad@1.3.0\", or an npmjs.com package URL. A plain \"owner/repo\" is a GitHub target, not npm — use the owner and repo arguments for that.",
    ),
  version: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional npm version or dist-tag (e.g. \"1.3.0\" or \"latest\") for the `package` scan; defaults to the latest published version. Ignored for GitHub scans. If `package` already carries a trailing @version, that wins.",
    ),
};

const scanInput = z.object(scanInputSchema);

export type ScanInput = z.infer<typeof scanInput>;

export const scanToolMeta = {
  name: "scan",
  title: "Scan a GitHub repo or npm package with ClaudeRabbit",
  description:
    "Returns a ClaudeRabbit 0-100 safety score and verdict for a public GitHub repo (pass `owner` + `repo`) or an npm package (pass `package`). For npm it scans the REAL published registry artifact — the exact tarball `npm install` fetches, integrity-verified — not the GitHub repo its package.json links to, so it catches a compromised-publish that exists only in the tarball. Cache-aware: if a report already exists for the target's current commit/artifact it comes back immediately (no rescan); otherwise a real fast-path scan (fetch + static scanners + reputation + a fast model read) runs and its result comes back. Callers don't need to know or choose which case applies. " +
    "When the fast path decides the repo warrants ClaudeRabbit's dynamic sandbox, this tool ALSO triggers the real detonation and waits for the sandbox-verified result — so `sandboxActuallyRan` is true and the score reflects what running the code actually did, not just the static read. A detonation that outlives the wait budget returns `sandboxActuallyRan: false` with the run still finishing server-side (scan again shortly for the verified result); always read `sandboxActuallyRan` / the forensics section before calling a result runtime-verified. This tool NEVER returns a bare \"Safe\" verdict — every result states what was and was not observed. Requires a signed-in ClaudeRabbit account (see the tool's error response for a sign-in link if unauthenticated).",
  // Triggers a real scan when nothing is cached yet, but never mutates or
  // deletes anything the caller owns — it's read/observe only from the
  // caller's side.
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

// ── npm target detection ─────────────────────────────────────────────────────
// A small, local, DETECT-only parser (the surface's own idiom). The edge
// function re-validates authoritatively — this only needs to recognize an
// npm-shaped string and pull out { package, version }. Grammar mirrors
// supabase/functions/_shared/npm.ts (which is a Deno module we must not import).

const NPM_SCOPED_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const NPM_UNSCOPED_RE = /^[a-z0-9][a-z0-9._-]*$/i;

interface NpmTarget {
  package: string;
  version?: string;
}

/** Validate a bare package name (scoped or unscoped) against npm's name grammar. */
function isValidNpmName(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false;
  return NPM_SCOPED_RE.test(name) || NPM_UNSCOPED_RE.test(name);
}

/**
 * Parse a user-supplied string into an npm target, or null when it is not one.
 * Recognizes `npm:pkg[@version]`, an npmjs.com package URL, a scoped
 * `@scope/name[@version]`, and a bare unscoped `name[@version]`. Deliberately
 * conservative: a value containing a `/` that is NOT a scoped name (i.e. a
 * plain `owner/repo`) fails to parse and is left for the GitHub path.
 */
function parseNpmTarget(input: string): NpmTarget | null {
  let s = (input ?? "").trim();
  if (!s) return null;

  // npmjs.com/package/<name>[/v/<version>]
  const urlMatch = s.match(
    /^(?:https?:\/\/)?(?:www\.)?npmjs\.com\/package\/(@[^/]+\/[^/@?#]+|[^/@?#]+)(?:\/v\/([^/?#]+))?/i,
  );
  if (urlMatch) {
    const name = decodeURIComponent(urlMatch[1]);
    const version = urlMatch[2] ? decodeURIComponent(urlMatch[2]) : undefined;
    return isValidNpmName(name) ? { package: name, ...(version ? { version } : {}) } : null;
  }

  // Explicit `npm:` prefix removes all ambiguity with owner/repo.
  const explicit = s.match(/^npm:(.+)$/i);
  if (explicit) s = explicit[1].trim();

  // Split a trailing `@version`, taking care not to eat a leading scope `@`.
  let name = s;
  let version: string | undefined;
  const at = s.lastIndexOf("@");
  if (at > 0) {
    name = s.slice(0, at);
    version = s.slice(at + 1) || undefined;
  }
  name = name.trim();
  if (!isValidNpmName(name)) return null;
  return { package: name, ...(version ? { version } : {}) };
}

// ── target resolution ────────────────────────────────────────────────────────

type ResolvedTarget =
  | { ok: false; error: string }
  | { ok: true; ecosystem: "github"; owner: string; repo: string; label: string; args: ScanArgs }
  | { ok: true; ecosystem: "npm"; label: string; args: ScanArgs };

/**
 * Decide whether this is an npm or a GitHub scan and build the request args.
 * An npm `package` takes precedence when present; otherwise a GitHub owner/repo
 * is required. The GitHub branch is unchanged from before.
 */
function resolveTarget(input: ScanInput): ResolvedTarget {
  const pkgRaw = input.package?.trim();
  if (pkgRaw) {
    const parsed = parseNpmTarget(pkgRaw);
    if (!parsed) {
      return {
        ok: false,
        error:
          `"${pkgRaw}" is not a valid npm package target. Pass an npm package name ` +
          `(e.g. "left-pad", "@scope/name", "npm:left-pad@1.3.0", or an npmjs.com package URL). ` +
          `A plain "owner/repo" is a GitHub target — use the owner and repo arguments for that.`,
      };
    }
    // A trailing @version embedded in the package string wins; otherwise fall
    // back to the explicit `version` argument.
    const version = parsed.version ?? (input.version?.trim() || undefined);
    const label = `npm:${parsed.package}${version ? `@${version}` : ""}`;
    return {
      ok: true,
      ecosystem: "npm",
      label,
      args: { ecosystem: "npm", package: parsed.package, ...(version ? { version } : {}) },
    };
  }

  const owner = input.owner?.trim();
  const repo = input.repo?.trim();
  if (!owner || !repo) {
    return {
      ok: false,
      error:
        "No scan target provided. Pass a GitHub repo as `owner` + `repo` (with an optional `ref`), " +
        "or an npm package as `package` (with an optional `version`).",
    };
  }
  return {
    ok: true,
    ecosystem: "github",
    owner,
    repo,
    label: `${owner}/${repo}`,
    args: { owner, repo, ref: input.ref },
  };
}

function textError(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

export async function runScanTool(config: ClaudeRabbitConfig, rawInput: unknown) {
  const token = readToken();
  if (!token) return signInRequiredResult(config.siteUrl);

  const input = scanInput.parse(rawInput);

  const resolved = resolveTarget(input);
  if (!resolved.ok) return textError(resolved.error);

  const result = await callScanRepo(config, resolved.args, token);

  if (!result.ok) {
    return textError(`ClaudeRabbit scan failed for ${resolved.label}: ${result.error}`);
  }
  let report = result.report;

  // ESCALATION → REAL SANDBOX. When the fast path decided a live detonation is
  // warranted (`report.deep`) but the sandbox hasn't run (no `forensics`), trigger
  // the SAME production dispatch the website uses (`/api/deep`) and wait for the
  // sandbox-verified report — so the tool returns the real runtime score, not the
  // scarier static-only interim. GitHub targets only: the detonation clones
  // `owner/repo@sha` (npm-artifact detonation is a separate harness capability).
  if (
    resolved.ecosystem === "github" &&
    report.deep &&
    !report.forensics &&
    typeof report.commit_sha === "string" &&
    report.commit_sha
  ) {
    const deep = await runDeepScan(config, {
      owner: resolved.owner,
      repo: resolved.repo,
      sha: report.commit_sha,
    });
    if (deep.ok) {
      // persisted → forensics already attached (one confirming re-read); pending →
      // poll the report row until they land. Pinned to report.commit_sha (the
      // EXACT commit that was dispatched) so a fast-moving repo's default branch
      // advancing mid-poll can never substitute a fresh, non-escalated scan of a
      // newer commit as if it were this run's result — see awaitForensics.
      const verified = await awaitForensics(config, resolved.args, token, report.commit_sha, {
        tries: deep.persisted ? 3 : 36,
      });
      if (verified) report = verified;
    }
    // unavailable / error → keep the escalation-decided report; `sandboxActuallyRan`
    // stays false (honest) and the detonation, if dispatched, completes server-side.
  }

  // Build the report link from the target's canonical identity. For npm, use the
  // RETURNED report's identity (owner="npm", name=package) so the link points at
  // /npm/<package>, matching the report page and the CLI surface; for GitHub keep
  // the exact /owner/repo link as before.
  const reportUrl =
    resolved.ecosystem === "npm"
      ? `${config.siteUrl}/${report.owner}/${report.name}`
      : `${config.siteUrl}/${resolved.owner}/${resolved.repo}`;

  const { text, structured } = formatReport(report, reportUrl, { fresh: !result.report.cached });

  return {
    content: [
      { type: "text" as const, text },
      {
        type: "text" as const,
        text: `\n<structured-data>${JSON.stringify(structured)}</structured-data>`,
      },
    ],
    structuredContent: structured,
  };
}
