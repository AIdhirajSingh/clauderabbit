# ClaudeRabbit MCP server

An [MCP](https://modelcontextprotocol.io) server for [ClaudeRabbit](https://github.com/AIdhirajSingh/clauderabbit), a free, no-login, open web tool that scans a public GitHub repo or npm package and returns an honest 0-100 safety score. This server lets any MCP-compatible AI coding tool (Claude Code, Claude Desktop, Codex, etc.) check a repo or dependency's safety score **before installing or running it**, without leaving the tool.

It is a thin, self-contained client of the deployed ClaudeRabbit API: it posts to `${CLAUDE_RABBIT_SITE_URL}/api/scan`, the same route the [ClaudeRabbit web app](https://github.com/AIdhirajSingh/clauderabbit) itself calls. It does not reimplement any scanning, scoring, or sandboxing logic; it only calls the existing API and formats the response.

## What it does, and is honest about what it doesn't

Per ClaudeRabbit's core rule, **this server never returns a bare "Safe" verdict.** Every result states the score, the verdict, and explicitly what was and was not verified.

One tool, two target kinds:

- **`scan(owner, repo, ref?)`**, a public **GitHub repo**.
- **`scan(package, version?)`**, an **npm package**. This scans the REAL published registry artifact, the exact tarball `npm install` fetches, integrity-verified, not the GitHub repo its `package.json` happens to link to, so it catches a compromised-publish that exists only in the tarball. `package` accepts a bare name (`left-pad`), a scoped name (`@scope/name`), an explicit `npm:left-pad@1.3.0`, or an `npmjs.com` package URL; a trailing `@version` in `package` (or the separate `version` arg) pins a version/dist-tag. A plain `owner/repo` is a GitHub target, not npm, use `owner`/`repo` for that.

Either way it is **cache-aware by construction**: if a report already exists for the target's current commit/artifact, it comes back immediately (no rescan); otherwise one full ClaudeRabbit scan runs (fetch, static scanners, OSV lookup, reachability, model readers, and a detonation of the code in a fresh sandbox) and its result comes back. Callers never need to know or choose which case applies. Returns the score, verdict, evidence split into behaviour, code and reputation, `notVerified`, the report URL and a sponsored message (`ad`). An npm report's identity is `npm/<package>` (its `reportUrl` is `…/npm/<package>`).

### Important: what a scan result does and does NOT prove

Every scan runs the code. The target's tarball (GitHub archive or the npm registry artifact, integrity verified) is installed with its scripts on and its entry point run, as a non-root user, in a fresh E2B sandbox that is destroyed after the scan. A forge running as root inside that sandbox answers every outbound call and records it, so a payload that phones home gets a forged answer instead of reaching the real host.

`notVerified` in the structured output (and the matching section in the text) names what the scan does not reach: behaviour outside the observed install and entry windows, code paths the install and entry point do not trigger, and payloads gated on dates past the accelerated clock or on hosts that need real responses. It is never empty.

Every result also keeps **reputation signals** (owner account age, stars, sentiment) and **code/behavior signals** (what the code contains, what running it showed) in visibly separate sections, per ClaudeRabbit's structural rule that the two are never blended into one signal.

## Setup

This is a self-contained package, it has its own `package.json` and does not touch or depend on the root ClaudeRabbit repo's `package.json`, `node_modules`, or build.

```bash
cd mcp-server
npm install
npm run build
```

This produces `dist/index.js`, a stdio MCP server.

### Configuration

The server needs no configuration: it calls ClaudeRabbit's production site by default. One optional environment variable points it at a different deployment (a fork or a preview):

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_RABBIT_SITE_URL` | `https://clauderabbit.in` | API base (`/api/scan`), and the base of the report link in tool output. |
| `CLAUDE_RABBIT_SCAN_TIMEOUT_MS` | built-in | How long `scan` will wait for a fresh (uncached) scan to finish streaming before giving up. |

No API key and no account are ever required: add the server and call `scan`.

## Limits

Anonymous fresh scans are rate limited: at most 6 run at once across the service, and each client IP gets 10 fresh scans per hour and 30 per day. Stored (cached) reports always come back at once and never count. Over a limit the tool returns a `rate_limited` error with the reason and when to retry.
These limits apply the same way to this stdio server and to the remote connector at
`https://clauderabbit.in/mcp`.

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

### Manual setup, Claude Code

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

### Manual setup, Claude Desktop

Edit your Claude Desktop config and add the same entry as above. The file's real location
depends on how Claude Desktop was installed, the classic path is
`%APPDATA%\Claude\claude_desktop_config.json` on Windows or
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, but a Microsoft
Store/MSIX install on Windows keeps it instead under
`%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json` , 
`clauderabbit mcp install` (above) detects and handles both automatically rather than assuming
the commonly-documented classic path is the only one.

Restart Claude Desktop. The `scan` tool should appear under the MCP tools icon.

### Other MCP-compatible clients (Codex, Cursor, Windsurf, etc.)

Any client that supports stdio MCP servers uses the same shape: a `command` of `node` and an `args` array pointing at the absolute path to `dist/index.js`. Consult your client's MCP configuration docs for where that JSON snippet goes, the server itself is a standard stdio MCP server with no client-specific behavior.

### Remote (Streamable HTTP), claude.ai custom connector

For clients that connect over HTTP instead of spawning a local process (e.g. a claude.ai
custom connector), the same `scan` tool is also served remotely at `https://clauderabbit.in/mcp`
(Streamable HTTP, no sign-in and no authentication, no separate setup needed). It accepts the same targets as the stdio tool, a GitHub repo
(`owner` + `repo`) or an npm package (`package`). Add it in claude.ai under Settings → Connectors
→ Add custom connector: paste that URL, leave authentication set to none, and save.

## Running standalone / testing

Run the server directly (it will sit waiting for JSON-RPC frames on stdin, this is normal for a stdio MCP server; it does not print a prompt):

```bash
npm start
# or: node dist/index.js
```

To exercise `scan` end-to-end against the **real, live, deployed ClaudeRabbit API** without wiring up a full MCP client, use the built-in smoke test. It spins up this exact server and a real MCP `Client` connected over an in-memory transport (the same code paths as stdio), then calls the tool twice for real:

```bash
npm run build
npm run test:smoke
```

The first call scans a tiny, extremely common, long-lived package at its default ref, almost certainly already cached, proving the cache-hit path (`outcome: "cached"`, instant). The second call scans that same repo pinned to its very first commit ever, a real, valid ref that's virtually guaranteed to have never been scanned before, proving a genuine fresh scan runs (`outcome: "fresh"`) rather than a stale/duplicated result. Both print the full JSON tool result to stdout.

## Architecture notes

- `src/env.ts`: configuration (site URL and timeout); never reads a secret key.
- `src/scan-api.ts`: the only module that makes scan HTTP calls (a copy of the CLI's `src/lib/scan-api.ts`). Posts to `/api/scan` with `x-clauderabbit-client: mcp` (plus a saved `cr_cli_` token only if one exists), reads the NDJSON event stream, and renders the verdict, score, evidence groups, `not_verified`, the report URL and the ad.
- `src/tools/scan.ts`: the one MCP tool definition and handler. Detects whether the input is a GitHub repo (`owner`/`repo`) or an npm package (`package`, via a small local DETECT-only parser; the scan engine re-validates authoritatively), then returns what `scan-api.ts` returns.
- `src/auth.ts`, reads an optional saved token from the shared `~/.clauderabbit/credentials.json`;
  scanning works without one.
- `src/index.ts`, stdio server entrypoint.
- `src/test/smoke.ts`, live end-to-end verification harness (see above).

The Next.js app's `app/mcp/route.ts` (in the main repo) serves the same `scan` tool remotely over
Streamable HTTP with no sign-in, see [Remote (Streamable HTTP)](#remote-streamable-http--claudeai-custom-connector)
above. It reuses this package's tool logic conceptually but is a separate deployment (it runs
on Vercel, not as a local stdio process), so its code lives in the main app, not here.

No scanning, scoring, or sandboxing logic is reimplemented anywhere in this package, it is a pure client of ClaudeRabbit's existing public API.
