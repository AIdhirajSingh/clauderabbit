# ClaudeRabbit MCP server

An [MCP](https://modelcontextprotocol.io) server for [ClaudeRabbit](https://github.com/AIdhirajSingh/clauderabbit) — a free, no-login, open web tool that scans a public GitHub repo and returns an honest 0-100 safety score. This server lets any MCP-compatible AI coding tool (Claude Code, Claude Desktop, Codex, etc.) check a repo or dependency's safety score **before installing or running it**, without leaving the tool.

It is a thin, self-contained client of the real, deployed ClaudeRabbit API — the same public Supabase edge function and database read the [ClaudeRabbit web app](https://github.com/AIdhirajSingh/clauderabbit) itself calls. It does not reimplement any scanning, scoring, or sandboxing logic; it only calls the existing API and formats the response.

## What it does — and is honest about what it doesn't

Per ClaudeRabbit's core rule, **this server never returns a bare "Safe" verdict.** Every result states the score, the verdict, and explicitly what was and was not verified.

Two tools:

- **`scan_repo(owner, repo, ref?)`** — triggers a ClaudeRabbit fast-path scan (clone + static scanners + reputation lookup + a fast model read), or returns the cached result if one already exists for the current commit. Returns the score, verdict, code/behavior findings, and reputation signals.
- **`get_report(owner, repo)`** — reads an **existing** cached report for a repo directly from ClaudeRabbit's public database, without triggering a new scan. Returns a clear "not found" result (not an error, and never fabricated data) if the repo has never been scanned.

### Important: what a scan result does and does NOT prove

ClaudeRabbit is a two-speed system. The fast path (what both tools above call) runs on essentially every request: static analysis, reputation lookup, and a fast model reading only the flagged regions. A small share of ambiguous repos get **escalated** to a full dynamic-sandbox detonation — the repo is actually built and run inside a hermetic, network-locked-down, single-use VM.

**Triggering `scan_repo` only runs the fast path.** It can determine that a repo *should* be escalated (reflected as `escalationDecided: true` in the structured output) without the dynamic sandbox having actually executed yet — that detonation is a separate, privileged process gated to ClaudeRabbit's own sandbox controller and is not something this public API call can force to complete synchronously.

Both tools always report the honest signal for this: `sandboxActuallyRan` in the structured output (and the "What was actually verified" section in the text) is `true` **only** when a forensic record from a real sandbox execution is attached to the report. If you need confirmation of real runtime behavior, call `get_report` again later, or check the full report page — either will show a "Sandbox run" (not "Static read") result once/if the dynamic run has completed and attached its forensics.

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

Optional environment variables (see `.env.example`) let you point the server at a different deployment (a fork, staging, or a future production domain):

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_RABBIT_SUPABASE_URL` | `https://mjvlczaytkhvsolnhhkz.supabase.co` | Supabase project URL to call. |
| `CLAUDE_RABBIT_SUPABASE_PUBLISHABLE_KEY` | (ClaudeRabbit's public key) | Supabase publishable key — safe client-side, same one the web app uses. |
| `CLAUDE_RABBIT_SITE_URL` | `http://localhost:2311` | Base URL used to build the "full report" link in tool output. Update once a production domain exists. |
| `CLAUDE_RABBIT_SCAN_TIMEOUT_MS` | `120000` | How long `scan_repo` will wait for a fresh (uncached) scan to finish streaming before giving up. |

No API key, login, or auth token is ever required — every call this server makes is the same anonymous, public call the ClaudeRabbit website makes for a logged-out visitor.

## Adding this server to an MCP client

### Claude Code

```bash
claude mcp add claude-rabbit -- node "/absolute/path/to/clauderabbit/mcp-server/dist/index.js"
```

Or add it to `.mcp.json` in a project (or `~/.claude.json` for a user-level server):

```json
{
  "mcpServers": {
    "claude-rabbit": {
      "command": "node",
      "args": ["/absolute/path/to/clauderabbit/mcp-server/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Edit your Claude Desktop config (`claude_desktop_config.json` — on Windows at `%APPDATA%\Claude\claude_desktop_config.json`, on macOS at `~/Library/Application Support/Claude/claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "claude-rabbit": {
      "command": "node",
      "args": ["/absolute/path/to/clauderabbit/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. The two tools (`scan_repo`, `get_report`) should appear under the MCP tools icon.

### Other MCP-compatible clients (Codex, Cursor, Windsurf, etc.)

Any client that supports stdio MCP servers uses the same shape: a `command` of `node` and an `args` array pointing at the absolute path to `dist/index.js`. Consult your client's MCP configuration docs for where that JSON snippet goes — the server itself is a standard stdio MCP server with no client-specific behavior.

## Running standalone / testing

Run the server directly (it will sit waiting for JSON-RPC frames on stdin — this is normal for a stdio MCP server; it does not print a prompt):

```bash
npm start
# or: node dist/index.js
```

To exercise both tools end-to-end against the **real, live, deployed ClaudeRabbit API** without wiring up a full MCP client, use the built-in smoke test. It spins up this exact server and a real MCP `Client` connected over an in-memory transport (the same code paths as stdio), then calls both tools for real:

```bash
npm run build
npm run test:smoke
```

This calls `get_report` for a repo expected to already have a cached report, `scan_repo` for a small real repo (exercising either a cache hit or a genuinely fresh scan, whichever the deployed project currently has), and `get_report` for a repo that has never been scanned (to confirm the honest not-found path). All three print the full JSON tool result to stdout.

## Architecture notes

- `src/env.ts` — configuration (public defaults + env var overrides), never reads a secret key.
- `src/claude-rabbit-client.ts` — the only module that makes HTTP calls. Mirrors the main app's `lib/scan.ts` (`runScan`, handling both the plain-JSON cache-hit response and the NDJSON streamed-scan response) and `lib/report-fetch.ts` (`fetchLatestReportRest`) exactly, reimplemented standalone since this package does not depend on the Next.js app's `lib/`.
- `src/normalize.ts` — coerces an arbitrary API payload into a strict `Report` shape and enforces the "never a bare Safe verdict" rail, mirroring the main app's `normalizeReport`/`enforceVerdict`.
- `src/format.ts` — shapes a `Report` into the tool output: score, verdict, the honest sandbox-ran-vs-static-read distinction, and separated code/behavior vs. reputation sections.
- `src/tools/scan-repo.ts`, `src/tools/get-report.ts` — the two MCP tool definitions and handlers.
- `src/index.ts` — stdio server entrypoint.
- `src/test/smoke.ts` — live end-to-end verification harness (see above).

No scanning, scoring, or sandboxing logic is reimplemented anywhere in this package — it is a pure client of ClaudeRabbit's existing public API.
