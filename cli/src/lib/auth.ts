/**
 * CLI login: a real, persisted session so `clauderabbit` only works for a
 * signed-in ClaudeRabbit user (a real product/access decision — see
 * CLAUDE.md and supabase/migrations/20260704000001_cli_tokens.sql) without
 * asking again on every run.
 *
 * The credential file at `~/.clauderabbit/credentials.json` is shared with
 * the MCP server (`mcp-server/src/auth.ts` reads the exact same path/shape),
 * so signing in once with either tool connects both.
 */

import { createServer } from "node:http";
import { exec } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import type { ClaudeRabbitConfig } from "./env.js";

const CONFIG_DIR = join(homedir(), ".clauderabbit");
const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json");

interface Credentials {
  token: string;
  savedAt: string;
}

/** The token this session's credentials hold, or null if never logged in / cleared. */
export function readToken(): string | null {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    return typeof parsed.token === "string" && parsed.token.startsWith("cr_cli_")
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

/** Save a token directly — used both by the interactive callback and `login --token`. */
export function saveToken(token: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const body: Credentials = { token, savedAt: new Date().toISOString() };
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(body, null, 2), { mode: 0o600 });
}

export function clearToken(): boolean {
  if (!existsSync(CREDENTIALS_PATH)) return false;
  rmSync(CREDENTIALS_PATH);
  return true;
}

/** Best-effort cross-platform "open a URL in the default browser". Never throws. */
function openBrowser(url: string): void {
  const cmd =
    platform() === "win32"
      ? `start "" "${url}"`
      : platform() === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best-effort — the printed URL is the real fallback */
  });
}

const SUCCESS_HTML = `<!doctype html><html><head><title>ClaudeRabbit</title></head>
<body style="font-family:system-ui;background:#16130f;color:#f4f1ea;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;">
<p>Signed in — return to your terminal. You can close this tab.</p></body></html>`;

/**
 * Interactive login: starts a short-lived local callback server, opens
 * `${siteUrl}/cli-auth?port=<n>` in the browser, and waits for the browser
 * (redirected there by that page once sign-in completes) to hand back a
 * token. Saves it and resolves with it. Rejects on timeout or if the local
 * server can't bind.
 */
export function login(config: ClaudeRabbitConfig, timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const token = url.searchParams.get("token");
      res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
      server.close();
      clearTimeout(timer);
      if (!token || !token.startsWith("cr_cli_")) {
        reject(new Error("Sign-in did not return a valid token."));
        return;
      }
      saveToken(token);
      resolve(token);
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out after 5 minutes."));
    }, timeoutMs);
    timer.unref();

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      if (!port) {
        clearTimeout(timer);
        server.close();
        reject(new Error("Could not start the local sign-in callback server."));
        return;
      }
      const loginUrl = `${config.siteUrl}/cli-auth?port=${port}`;
      process.stderr.write(`Opening your browser to sign in:\n  ${loginUrl}\n`);
      openBrowser(loginUrl);
    });
  });
}

/** Ensure a token is available, logging in interactively if none is saved yet. */
export async function ensureLoggedIn(config: ClaudeRabbitConfig): Promise<string> {
  const existing = readToken();
  if (existing) return existing;
  process.stderr.write("Not signed in — starting sign-in…\n");
  return login(config);
}
