/**
 * MCP login: reads the SAME `~/.clauderabbit/credentials.json` the CLI
 * writes (`cli/src/lib/auth.ts`) — signing in once with either tool connects
 * both. Unlike the CLI, this server never launches a browser or writes the
 * file itself: an MCP tool call can't block for minutes on user browser
 * interaction the way an interactive terminal command can. When no token is
 * saved, callers (see tools/scan-repo.ts, tools/get-report.ts) return a
 * clear, clickable sign-in link instead of running the tool.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CREDENTIALS_PATH = join(homedir(), ".clauderabbit", "credentials.json");

/** The saved CLI/MCP login token, or null if never signed in / logged out. */
export function readToken(): string | null {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.startsWith("cr_cli_")
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

/** The honest "not signed in" tool response — never a silent failure. */
export function signInRequiredResult(siteUrl: string) {
  const signInUrl = `${siteUrl.replace(/\/+$/, "")}/cli-auth`;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `Sign in required. Visit ${signInUrl} to sign in, then run ` +
          `\`clauderabbit login --token <token>\` (or \`clauderabbit login\` if the ` +
          `CLI is installed) to connect — both this MCP server and the CLI share the ` +
          `same saved sign-in, so you only need to do this once.`,
      },
    ],
  };
}
