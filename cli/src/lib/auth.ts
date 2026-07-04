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

/**
 * The real, branded confirmation page — same dark-theme colors, serif
 * heading, and RabbitMark glyph as the rest of the product (`app/globals.css`
 * `--bg`/`--t1`/`--t3`, `components/spa/components/glyphs.tsx`'s RabbitMark).
 * `/cli-auth` navigates the browser here directly (a real top-level
 * navigation to `http://127.0.0.1` isn't blocked by Chrome's Private Network
 * Access policy the way a `fetch()` from an HTTPS page is — confirmed live,
 * `fetch` throws `TypeError: Failed to fetch` here even though this server is
 * genuinely listening), so this small hand-rolled page — not a React one —
 * really is what the user's browser shows for a moment. `<meta charset>` is
 * the actual fix for the previous mojibake bug: without it, a browser can
 * mis-decode the UTF-8 em dash as Windows-1252, rendering it as "â€"".
 */
function renderPage(ok: boolean): string {
  const heading = ok ? "Connected" : "Something went wrong";
  const body = ok
    ? "Return to your terminal — you can close this tab."
    : "This sign-in link is invalid or has expired. Close this tab and run <code>clauderabbit login</code> again.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClaudeRabbit</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;height:100%}
  body{
    background:#16130f;color:#f4f1ea;
    font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:16px;text-align:center;padding:24px;
  }
  h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:28px;margin:0;letter-spacing:-0.01em}
  p{font-size:15px;line-height:1.6;color:#a39c90;margin:0;max-width:420px}
  code{font-family:monospace;background:#1d1916;border:1px solid rgba(255,255,255,0.13);border-radius:4px;padding:2px 6px}
</style>
</head>
<body>
<svg width="40" height="40" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <path d="M10.2 14.5 C8.3 9.8 8.6 4.4 10.2 4 C11.8 3.6 13.1 8 13.3 12.3" stroke="#f4f1ea" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M21.8 14.5 C23.7 9.8 23.4 4.4 21.8 4 C20.2 3.6 18.9 8 18.7 12.3" stroke="#f4f1ea" stroke-width="1.7" stroke-linecap="round"/>
  <circle cx="16" cy="19.6" r="7" stroke="#f4f1ea" stroke-width="1.7"/>
  <circle cx="16" cy="19.8" r="1.6" fill="#f4f1ea"/>
</svg>
<h1>${heading}</h1>
<p>${body}</p>
</body>
</html>`;
}

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
      const valid = !!token && token.startsWith("cr_cli_");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderPage(valid));
      server.close();
      clearTimeout(timer);
      if (!valid) {
        reject(new Error("Sign-in did not return a valid token."));
        return;
      }
      saveToken(token as string);
      resolve(token as string);
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
