# ClaudeRabbit MCP server

An [MCP](https://modelcontextprotocol.io) server for [ClaudeRabbit](https://github.com/AIdhirajSingh/clauderabbit) — a free, no-login, open web tool that scans a public GitHub repo and returns an honest 0-100 safety score. This server lets any MCP-compatible AI coding tool (Claude Code, Claude Desktop, Codex, etc.) check a repo or dependency's safety score **before installing or running it**, without leaving the tool.

It is a thin, self-contained client of the real, deployed ClaudeRabbit API — the same public Supabase edge function and database read the [ClaudeRabbit web app](https://github.com/AIdhirajSingh/clauderabbit) itself calls. It does not reimplement any scanning, scoring, or sandboxing logic; it only calls the existing API and formats the response.

## What it does — and is honest about what it doesn't

Per ClaudeRabbit's core rule, **this server never returns a bare "Safe" verdict.** Every result states the score, the verdict, and explicitly what was and was not verified.

One tool:

- **`scan(owner, repo, ref?)`** — cache-aware by construction. If a report already exists for the repo's current commit, it comes back immediately (no rescan); otherwise a real ClaudeRabbit fast-path scan runs (clone + static scanners + reputation lookup + a fast model read) and its result comes back. Callers never need to know or choose which case applies. Returns the score, verdict, code/behavior findings, and reputation signals.

### Important: what a scan result does and does NOT prove

ClaudeRabbit is a two-speed system. The fast path (what `scan` calls, whether it's a fresh run or a cache hit) runs on essentially every request: static analysis, reputation lookup, and a fast model reading only the flagged regions. A small share of ambiguous repos get **escalated** to a full dynamic-sandbox detonation — the repo is actually built and run inside a hermetic, network-locked-down, single-use VM.

**A fresh `scan` only runs the fast path.** It can determine that a repo *should* be escalated (reflected as `escalationDecided: true` in the structured output) without the dynamic sandbox having actually executed yet — that detonation is a separate, privileged process gated to ClaudeRabbit's own sandbox controller and is not something this public API call can force to complete synchronously.

Every result reports the honest signal for this: `sandboxActuallyRan` in the structured output (and the "What was actually verified" section in the text) is `true` **only** when a forensic record from a real sandbox execution is attached to the report. If you need confirmation of real runtime behavior, call `scan` again later, or check the full report page — either will show a "Sandbox run" (not "Static read") result once/if the dynamic run has completed and attached its forensics.

Every result also keeps **reputation signals** (owner account age, stars, sentiment) and **code/behavior signals** (what the code contains, what running it showed) in visibly separate sections, per ClaudeRabbit's structural rule that the two are never blended into one signal.

## Setup

This is a self-contained package — it has its own `package.json` and does not touch or depend on the root ClaudeRabbit repo's `package.json`, `node_modules`, or build.

```bash
cd mcp-server
npm install
npm run build
```

This produces `dist/index.js`, a stdio MCP server.

### Configuration

ClaudeRabbit is a free, public, no-login product, so the Supabase URL and the Supabase **publishable** key are not secrets — they are the exact two values the ClaudeRabbit web app itself ships in its client bundle. This server ships with ClaudeRabbit's production values built in as defaults, so **it works with zero configuration.**

Optional environment variables (see `.env.example`) let you point the server at a different deployment (a fork or a staging environment):

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_RABBIT_SUPABASE_URL` | `https://mjvlczaytkhvsolnhhkz.supabase.co` | Supabase project URL to call. |
| `CLAUDE_RABBIT_SUPABASE_PUBLISHABLE_KEY` | (ClaudeRabbit's public key) | Supabase publishable key — safe client-side, same one the web app uses. |
| `CLAUDE_RABBIT_SITE_URL` | `https://clauderabbit.in` | Base URL used to build the "full report" link and sign-in link in tool output. |
| `CLAUDE_RABBIT_SCAN_TIMEOUT_MS` | `120000` | How long `scan` will wait for a fresh (uncached) scan to finish streaming before giving up. |

No API key is ever required, but a **signed-in ClaudeRabbit account is required to call the
tool** — a real product/access decision, not because the scan data is sensitive (report pages
stay public either way). Called signed out, `scan` returns a clear, clickable sign-in link
instead of a confusing error or a silent failure — see [Sign-in](#sign-in) below.

## Sign-in

`scan` checks for a session at `~/.clauderabbit/credentials.json` (the same file the
[CLI](../cli) writes to `login`/`logout` — sign in once with either tool and both work).
Called without one, it returns an `isError` result whose text gives you the exact command
to run:

```
Sign in required. Visit https://clauderabbit.in/cli-auth to sign in, then run:
  clauderabbit login --token <token>
```

Once signed in, it doesn't re-prompt on later calls — the session persists until
`clauderabbit logout` is run.

## Adding this server to an MCP client

### The easy way: `clauderabbit mcp install`

The [CLI](../cli) ships a real installer that finds your actual `claude_desktop_config.json`
(handling the Windows MSIX/Store install's different, undocumented config location) and adds
this server's entry for you, without touching anything else already in the file:

```bash
cd cli && npm install && npm run build
node dist/index.js mcp install
```

See the [CLI README](../cli/README.md#mcp-install--wire-the-clauderabbit-mcp-server-into-claude-desktop)
for exactly what it does. Restart Claude Desktop afterward.

### Manual setup — Claude Code

```bash
claude mcp add clauderabbit -- node "/absolute/path/to/clauderabbit/mcp-server/dist/index.js"
```

Or add it to `.mcp.json` in a project (or `~/.claude.json` for a user-level server):

```json
{
  "mcpServers": {
    "clauderabbit": {
      "command": "node",
      "args": ["/absolute/path/to/clauderabbit/mcp-server/dist/index.js"]
    }
  }
}
```

### Manual setup — Claude Desktop

Edit your Claude Desktop config and add the same entry as above. The file's real location
depends on how Claude Desktop was installed — the classic path is
`%APPDATA%\Claude\claude_desktop_config.json` on Windows or
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, but a Microsoft
Store/MSIX install on Windows keeps it instead under
`%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json` —
`clauderabbit mcp install` (above) detects and handles both automatically rather than assuming
the commonly-documented classic path is the only one.

Restart Claude Desktop. The `scan` tool should appear under the MCP tools icon.

### Other MCP-compatible clients (Codex, Cursor, Windsurf, etc.)

Any client that supports stdio MCP servers uses the same shape: a `command` of `node` and an `args` array pointing at the absolute path to `dist/index.js`. Consult your client's MCP configuration docs for where that JSON snippet goes — the server itself is a standard stdio MCP server with no client-specific behavior.

### Remote (Streamable HTTP) — claude.ai custom connector

For clients that connect over HTTP instead of spawning a local process (e.g. a claude.ai
custom connector), the same `scan` tool is also served remotely at `https://clauderabbit.in/mcp`
(Streamable HTTP, OAuth 2.1 with PKCE for sign-in — no separate setup needed, the connector's
own "Connect" flow handles login). Add it in claude.ai under Settings → Connectors → Add
custom connector, using that URL.

## Running standalone / testing

Run the server directly (it will sit waiting for JSON-RPC frames on stdin — this is normal for a stdio MCP server; it does not print a prompt):

```bash
npm start
# or: node dist/index.js
```

`scan` requires a signed-in session (see [Sign-in](#sign-in)) — run `clauderabbit login`
(from the [CLI](../cli)) at least once first, since it writes the same
`~/.clauderabbit/credentials.json` this server reads.

To exercise `scan` end-to-end against the **real, live, deployed ClaudeRabbit API** without wiring up a full MCP client, use the built-in smoke test. It spins up this exact server and a real MCP `Client` connected over an in-memory transport (the same code paths as stdio), then calls the tool twice for real:

```bash
npm run build
npm run test:smoke
```

The first call scans a tiny, extremely common, long-lived package at its default ref — almost certainly already cached, proving the cache-hit path (`cached: true`, instant). The second call scans that same repo pinned to its very first commit ever — a real, valid ref that's virtually guaranteed to have never been scanned before, proving a genuine fresh scan runs (`cached: false`) rather than a stale/duplicated result. Both print the full JSON tool result to stdout.

## Architecture notes

- `src/env.ts` — configuration (public defaults + env var overrides), never reads a secret key.
- `src/claude-rabbit-client.ts` — the only module that makes HTTP calls. Mirrors the main app's `lib/scan.ts` (`runScan`, handling both the plain-JSON cache-hit response and the NDJSON streamed-scan response) exactly, reimplemented standalone since this package does not depend on the Next.js app's `lib/`.
- `src/normalize.ts` — coerces an arbitrary API payload into a strict `Report` shape and enforces the "never a bare Safe verdict" rail, mirroring the main app's `normalizeReport`/`enforceVerdict`.
- `src/format.ts` — shapes a `Report` into the tool output: score, verdict, the honest sandbox-ran-vs-static-read distinction, and separated code/behavior vs. reputation sections.
- `src/tools/scan.ts` — the one MCP tool definition and handler. Cache-aware by construction: it just reflects whatever `claude-rabbit-client.ts`'s `scanRepo` returns, which is itself already a cache-hit-or-fresh-scan call against the real edge function.
- `src/auth.ts` — reads the shared `~/.clauderabbit/credentials.json` session (written by the
  [CLI](../cli)'s `login`) and builds the sign-in-required tool result when it's missing.
- `src/index.ts` — stdio server entrypoint.
- `src/test/smoke.ts` — live end-to-end verification harness (see above).

The Next.js app's `app/mcp/route.ts` (in the main repo) serves the same `scan` tool remotely over
Streamable HTTP with OAuth 2.1 — see [Remote (Streamable HTTP)](#remote-streamable-http--claudeai-custom-connector)
above. It reuses this package's tool logic conceptually but is a separate deployment (it runs
on Vercel, not as a local stdio process), so its code lives in the main app, not here.

No scanning, scoring, or sandboxing logic is reimplemented anywhere in this package — it is a pure client of ClaudeRabbit's existing public API.
