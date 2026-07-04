/**
 * `scan_repo` — trigger a ClaudeRabbit fast-path scan (or hit its cache) for
 * a public GitHub repo, and return an honest, structured safety summary.
 */

import { z } from "zod";
import { scanRepo as callScanRepo } from "../claude-rabbit-client.js";
import { readToken, signInRequiredResult } from "../auth.js";
import type { ClaudeRabbitConfig } from "../env.js";
import { formatReport } from "../format.js";

export const scanRepoInputSchema = {
  owner: z.string().min(1).describe("GitHub repository owner or org, e.g. \"sindresorhus\"."),
  repo: z.string().min(1).describe("GitHub repository name, e.g. \"is\"."),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe("Optional git ref (branch, tag, or commit SHA) to scan instead of the default branch."),
};

const scanRepoInput = z.object(scanRepoInputSchema);

export type ScanRepoInput = z.infer<typeof scanRepoInput>;

export const scanRepoToolMeta = {
  name: "scan_repo",
  title: "Scan a GitHub repo with ClaudeRabbit",
  description:
    "Runs a ClaudeRabbit fast-path safety scan (or returns its cached result) for a public GitHub repo and returns a 0-100 score, a verdict, and an honest breakdown of what was and was NOT verified. " +
    "IMPORTANT: this tool call only guarantees the static fast path (clone + static scanners + reputation + a fast model read) ran. ClaudeRabbit's dynamic sandbox detonation is a separate, privileged process — this tool call may report that escalation to it was decided (`escalationDecided`) without the sandbox having actually executed yet (`sandboxActuallyRan`). Always check `sandboxActuallyRan` / the forensics section before treating a result as runtime-verified. This tool NEVER returns a bare \"Safe\" verdict — every result states what was and was not observed. Requires a signed-in ClaudeRabbit account (see the tool's error response for a sign-in link if unauthenticated).",
  // Triggers a real scan (possibly a fresh one), but never mutates or deletes
  // anything the caller owns — it's read/observe only from the caller's side.
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

export async function runScanRepoTool(config: ClaudeRabbitConfig, rawInput: unknown) {
  const token = readToken();
  if (!token) return signInRequiredResult(config.siteUrl);

  const input = scanRepoInput.parse(rawInput);
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
  const { text, structured } = formatReport(result.report, reportUrl, { fresh: true });

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
