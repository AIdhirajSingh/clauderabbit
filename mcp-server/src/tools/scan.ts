/**
 * `scan` — the one ClaudeRabbit tool. Cache-aware by construction: if a
 * report already exists for the repo's current commit, it comes back
 * immediately (same cache the web app itself hits); if not, a real
 * fast-path scan runs and its result comes back. The caller never needs to
 * know or choose which case they're in — this collapses what used to be two
 * separate tools (`scan_repo` / `get_report`) into one.
 */

import { z } from "zod";
import { scanRepo as callScanRepo } from "../claude-rabbit-client.js";
import { readToken, signInRequiredResult } from "../auth.js";
import type { ClaudeRabbitConfig } from "../env.js";
import { formatReport } from "../format.js";

export const scanInputSchema = {
  owner: z.string().min(1).describe("GitHub repository owner or org, e.g. \"sindresorhus\"."),
  repo: z.string().min(1).describe("GitHub repository name, e.g. \"is\"."),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe("Optional git ref (branch, tag, or commit SHA) to scan instead of the default branch."),
};

const scanInput = z.object(scanInputSchema);

export type ScanInput = z.infer<typeof scanInput>;

export const scanToolMeta = {
  name: "scan",
  title: "Scan a GitHub repo with ClaudeRabbit",
  description:
    "Returns a ClaudeRabbit 0-100 safety score and verdict for a public GitHub repo. Cache-aware: if a report already exists for the repo's current commit it comes back immediately (no rescan); otherwise a real fast-path scan (clone + static scanners + reputation + a fast model read) runs and its result comes back. Callers don't need to know or choose which case applies. " +
    "IMPORTANT: this tool call only guarantees the static fast path ran. ClaudeRabbit's dynamic sandbox detonation is a separate, privileged process — this tool call may report that escalation to it was decided (`escalationDecided`) without the sandbox having actually executed yet (`sandboxActuallyRan`). Always check `sandboxActuallyRan` / the forensics section before treating a result as runtime-verified. This tool NEVER returns a bare \"Safe\" verdict — every result states what was and was not observed. Requires a signed-in ClaudeRabbit account (see the tool's error response for a sign-in link if unauthenticated).",
  // Triggers a real scan when nothing is cached yet, but never mutates or
  // deletes anything the caller owns — it's read/observe only from the
  // caller's side.
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

export async function runScanTool(config: ClaudeRabbitConfig, rawInput: unknown) {
  const token = readToken();
  if (!token) return signInRequiredResult(config.siteUrl);

  const input = scanInput.parse(rawInput);
  const owner = input.owner.trim();
  const repo = input.repo.trim();

  const result = await callScanRepo(config, { owner, repo, ref: input.ref }, token);

  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `ClaudeRabbit scan failed for ${owner}/${repo}: ${result.error}`,
        },
      ],
    };
  }

  const reportUrl = `${config.siteUrl}/${owner}/${repo}`;
  const { text, structured } = formatReport(result.report, reportUrl, { fresh: !result.report.cached });

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
