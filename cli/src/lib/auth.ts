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

import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
 * The branded confirmation page, in the site's v4 design: black background,
 * Figtree, the white logo tile with the rabbit mark (`components/v4/v4.css`,
 * `components/v4/Footer.tsx`).
 * `/cli-auth` navigates the browser here directly (a real top-level
 * navigation to `http://127.0.0.1` isn't blocked by Chrome's Private Network
 * Access policy the way a `fetch()` from an HTTPS page is — confirmed live,
 * `fetch` throws `TypeError: Failed to fetch` here even though this server is
 * genuinely listening), so this small hand-rolled page — not a React one —
 * really is what the user's browser shows for a moment. `<meta charset>` is
 * the actual fix for the previous mojibake bug: without it, a browser can
 * mis-decode the UTF-8 em dash as Windows-1252, rendering it as "â€"".
 */
export function renderPage(ok: boolean): string {
  const heading = ok ? "Connected" : "Something went wrong";
  const body = ok
    ? "Return to your terminal — you can close this tab."
    : "This sign-in link is invalid or has expired. Close this tab and run <code>clauderabbit login</code> again.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>ClaudeRabbit</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&family=Geist+Mono&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    background:#000;color:#F0F0F0;
    font-family:Figtree,ui-sans-serif,system-ui,-apple-system,sans-serif;
    -webkit-font-smoothing:antialiased;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:20px;text-align:center;padding:24px;
  }
  .mark{width:56px;height:56px;border-radius:14px;background:#FFFFFF;display:flex;align-items:center;justify-content:center}
  h1{margin:0;font-size:clamp(34px,6vw,48px);line-height:1.1;font-weight:400;letter-spacing:-0.04em;color:#F0F0F0}
  p{margin:0;max-width:420px;font-size:16px;line-height:1.65;color:#A1A1A1}
  code{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:#F0F0F0;background:rgba(255,255,255,0.04);border:2px solid rgba(255,255,255,0.06);border-radius:8px;padding:2px 8px}
</style>
</head>
<body>
<span class="mark" aria-hidden="true"><svg width="34" height="34" viewBox="-340.4 -340.4 680.8 680.8" aria-hidden="true"><defs><linearGradient id="fm0" x1="-122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#B12ED1"/><stop offset=".52" stop-color="#DE37AF"/><stop offset="1" stop-color="#F5A84E"/></linearGradient><linearGradient id="fm1" x1="122.25" y1="-68.41" x2="0" y2="140.09" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#B12ED1"/><stop offset=".52" stop-color="#DE37AF"/><stop offset="1" stop-color="#F5A84E"/></linearGradient></defs><circle r="300" fill="none" stroke="#121212" stroke-width="32.8"/><g stroke-width="32.8" stroke-linecap="round"><line x1="-122.25" y1="-68.41" x2="0" y2="140.09" stroke="url(#fm0)"/><line x1="122.25" y1="-68.41" x2="0" y2="140.09" stroke="url(#fm1)"/></g><circle cx="-122.25" cy="-68.41" r="53" fill="#1B77F3"/><circle cx="122.25" cy="-68.41" r="53" fill="#00BF63"/><circle cx="0" cy="140.09" r="53" fill="#FF4829"/></svg></span>
<h1>${heading}</h1>
<p>${body}</p>
</body>
</html>`;
}

/** Read a small urlencoded request body; anything over 4 KB is refused. */
function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    let body = "";
    let tooBig = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4096) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => resolve(tooBig ? null : new URLSearchParams(body)));
    req.on("error", () => resolve(null));
  });
}

function sameState(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

/**
 * Interactive login: starts a short-lived local callback server, opens
 * `${siteUrl}/cli-auth?port=<n>&state=<s>` in the browser, and waits for the
 * page to hand back a token.
 *
 * The token never travels in a URL. The page submits it in the body of a
 * form POST to `http://127.0.0.1:<n>/callback` together with `state`, a
 * random value only this process and that page know (so no other page can
 * plant a token here). The server answers with a 303 to `/done`, so the
 * address bar, history and any screenshot show only `/done`. A GET to
 * `/callback`, a wrong state, or a malformed token is refused.
 */
export function login(config: ClaudeRabbitConfig, timeoutMs = 5 * 60_000, open: (url: string) => void = openBrowser): Promise<string> {
  const state = randomBytes(24).toString("hex");
  return new Promise((resolve, reject) => {
    let outcome: boolean | null = null;
    const finish = () => {
      clearTimeout(timer);
      // Let the /done page load before the server goes away.
      setTimeout(() => server.close(), 3000).unref();
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/done" && req.method === "GET") {
        res.writeHead(200, PAGE_HEADERS).end(renderPage(outcome === true));
        return;
      }
      if (url.pathname !== "/callback" || req.method !== "POST" || outcome !== null) {
        res.writeHead(url.pathname === "/callback" ? 405 : 404, { "Cache-Control": "no-store" }).end();
        return;
      }
      void readForm(req).then((form) => {
        const token = form?.get("token") ?? null;
        const okState = sameState(form?.get("state") ?? null, state);
        const valid = okState && !!token && /^cr_cli_[0-9a-f]{64}$/.test(token);
        if (!okState) {
          // A request without our state is not the sign-in we started: refuse it and keep waiting.
          res.writeHead(403, PAGE_HEADERS).end(renderPage(false));
          return;
        }
        outcome = valid;
        res.writeHead(303, { Location: "/done", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).end();
        finish();
        if (!valid) {
          reject(new Error("Sign-in did not return a valid token."));
          return;
        }
        saveToken(token as string);
        resolve(token as string);
      });
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
      const loginUrl = `${config.siteUrl}/cli-auth?port=${port}&state=${state}`;
      process.stderr.write(`Opening your browser to sign in:\n  ${loginUrl}\n`);
      open(loginUrl);
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
