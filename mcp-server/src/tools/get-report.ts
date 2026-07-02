/**
 * `get_report` — fetch an EXISTING cached Claude Rabbit report for a public
 * GitHub repo, without triggering a new scan. Returns not-found rather than
 * an error when no report row exists yet.
 */

import { z } from "zod";
import { getReport as callGetReport } from "../claude-rabbit-client.js";
import type { ClaudeRabbitConfig } from "../env.js";
import { formatReport } from "../format.js";

export const getReportInputSchema = {
  owner: z.string().min(1).describe("GitHub repository owner or org, e.g. \"chalk\"."),
  repo: z.string().min(1).describe("GitHub repository name, e.g. \"chalk\"."),
};

const getReportInput = z.object(getReportInputSchema);

export const getReportToolMeta = {
  name: "get_report",
  title: "Get an existing Claude Rabbit report",
  description:
    "Fetches the most recent EXISTING Claude Rabbit report for a public GitHub repo directly from the public report database, without triggering a new scan. Returns a not-found result (not an error) if the repo has never been scanned — call scan_repo in that case. Also returns a link to the public, permanent /owner/repo report page. Never returns a bare \"Safe\" verdict.",
};

export async function runGetReportTool(config: ClaudeRabbitConfig, rawInput: unknown) {
  const input = getReportInput.parse(rawInput);
  const owner = input.owner.trim();
  const repo = input.repo.trim();

  const result = await callGetReport(config, owner, repo);
  const reportUrl = `${config.siteUrl}/${owner}/${repo}`;

  if (!result.ok) {
    if (result.notFound) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No cached Claude Rabbit report exists yet for ${owner}/${repo}. Call scan_repo to run one. (Would-be report page: ${reportUrl})`,
          },
        ],
        structuredContent: { found: false, owner, repo, reportUrl },
      };
    }
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch the Claude Rabbit report for ${owner}/${repo}: ${result.error}`,
        },
      ],
    };
  }

  const { text, structured } = formatReport(result.report, reportUrl, { fresh: false });

  return {
    content: [
      { type: "text" as const, text },
      {
        type: "text" as const,
        text: `\n<structured-data>${JSON.stringify({ found: true, ...structured })}</structured-data>`,
      },
    ],
    structuredContent: { found: true, ...structured },
  };
}
