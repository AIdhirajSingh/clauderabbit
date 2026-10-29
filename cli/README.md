# clauderabbit CLI

A command-line client for [ClaudeRabbit](https://github.com/AIdhirajSingh/clauderabbit), a
free web tool that scans a public GitHub repo or npm package and returns a 0-100 safety score
with the evidence behind it. This CLI lets you (or an AI coding agent) get that verdict **before
you install a dependency or clone a repo**, from the terminal.

It is a thin, self-contained client of the deployed ClaudeRabbit API: it posts to
`${CLAUDE_RABBIT_SITE_URL}/api/scan`, the same route the web app and the
[MCP server](../mcp-server) use. It does not reimplement any scanning, scoring, or sandboxing
logic; it only calls the API and formats the response.

## The one rule it never breaks

Per ClaudeRabbit's core rail, **this CLI never states a bare "Safe."** Every result shows the
score, the verdict, the evidence behind it (behaviour, code and reputation kept apart), and the
`not_verified` list: what this scan did not establish. See "What a scan does and does not
prove" below.

## Install

Published to npm as [`clauderabbit`](https://www.npmjs.com/package/clauderabbit):

```bash
npm install -g clauderabbit
clauderabbit scan expressjs/express
# or run it once with no install:
npx clauderabbit scan expressjs/express
```

This is a self-contained package, it has its own `package.json` and does **not** touch or
depend on the root ClaudeRabbit repo's `package.json`, `node_modules`, or build. To build from
source instead (e.g. to work on the CLI itself):

```bash
cd cli
npm install
npm run build      # produces dist/index.js
npm link           # get the `clauderabbit` command globally from this checkout
clauderabbit scan expressjs/express
```

Requires Node.js >= 18 (uses the built-in `fetch`). No API key and no account are needed for
this CLI (or the [MCP server](../mcp-server)): install it and scan. Anonymous fresh scans are rate limited: at most 6 run at once across the service, and each client IP gets 10 fresh scans per hour and 30 per day. Stored (cached) reports always come back at once and never count. Over a limit `scan` returns a `rate_limited` error with the reason and when to retry. The only server setting is the site URL;
override it for a fork with `CLAUDE_RABBIT_SITE_URL` (see [Configuration](#configuration)).

## Commands

### `scan <target> [--json] [--ref <ref>] [--no-color]`

Print a ClaudeRabbit verdict for `<target>`. Cache-aware, one command either way: if the
repo's current commit already has a report, it comes back immediately; if not, one full scan
runs (the code is installed and run in a fresh sandbox). Stage lines stream to stderr while it
runs. You never need to know or choose which case applies.

`<target>` is one of:

| Form | Example | Resolves to |
|---|---|---|
| `owner/repo` | `expressjs/express` | that GitHub repo |
| `owner/repo@ref` or `owner/repo#ref` | `expressjs/express@5.0.0` | that repo at a ref |
| a GitHub URL | `https://github.com/expressjs/express` | that repo |
| an **npm package name** | `left-pad`, `@scope/pkg` | the real **published npm artifact** (its tarball + install hooks), scanned directly |
| an npm name **at a version** | `left-pad@1.3.0`, `npm:express@5`, `https://npmjs.com/package/left-pad/v/1.3.0` | that exact published version's artifact |

npm targets are passed straight through to the API, which scans the **actual published
artifact**, its tarball bytes, `postinstall`/`preinstall` hooks and all, rather than the
GitHub repo its `package.json` links to. That is deliberate: a compromised maintainer can
publish a malicious version directly to the registry while pointing `repository` at an
innocent, high-reputation repo, so scanning the linked repo would be blind to exactly the
supply-chain attack an install-time check most needs to catch. For an npm scan the report's
owner is `npm` and its name is the package (e.g. `npm/left-pad`). `--ref` selects the
version/dist-tag for an npm target.

`--json` emits the machine-readable object documented in [JSON output](#json-output-schema).

Without `--json`, the report renders as real styled terminal output (via
[chalk](https://github.com/chalk/chalk) and [boxen](https://github.com/sindresorhus/boxen), not
hand-rolled ANSI codes): the score/verdict/source in a bordered box colored by the product's
fixed score-color logic (green/blue/yellow/red), colored severity badges (`HIGH`/`MED`/`LOW`) on
every finding, and code/behavior findings kept in a visually separate section from reputation
signals. Falls back to a clean, unstyled plain-text layout for `--no-color`, `NO_COLOR`, or a
non-TTY stdout (e.g. piped output), never raw escape codes in that case.

```bash
clauderabbit scan expressjs/express
clauderabbit scan left-pad --json          # scans the published npm artifact (report owner "npm")
clauderabbit scan npm:left-pad@1.3.0       # a specific published version
clauderabbit scan https://github.com/owner/repo --ref main
```

### `mcp install`, wire the ClaudeRabbit MCP server into Claude Desktop

```
clauderabbit mcp install
```

Finds your real `claude_desktop_config.json` and adds the ClaudeRabbit MCP server
(one cache-aware `scan` tool, stdio transport) to it, no manual JSON editing.

- **Finds the real file, including on Windows.** Checks the classic
  `%APPDATA%\Claude\claude_desktop_config.json` first, then, since a Microsoft
  Store/MSIX install of Claude Desktop keeps its real config in a different,
  undocumented place, globs `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`
  for it. Uses whichever one actually exists.
- **Only ever touches its own entry.** Reads the existing file, adds/updates the
  `"clauderabbit"` key under `mcpServers`, and writes the file back, every other server
  and setting already in the file is left exactly as it was. Refuses to touch a file that
  isn't valid JSON rather than risk clobbering it.
- **No hardcoded path baked into the launched command.** The server's on-disk location is
  passed via the `CLAUDE_RABBIT_MCP_SERVER_ENTRY` environment variable in the entry's own
  `env`, not as a literal string in `args`.
- **Tells you exactly what happened**, which file it found (and how), whether the entry
  was added or updated, and reminds you to restart Claude Desktop to pick it up.

## JSON output schema

`clauderabbit scan <target> --json` prints a single JSON object to **stdout**. Progress lines
go to **stderr** and never pollute the JSON.

A successful scan object (the fields come from the `/api/scan` result line):

```jsonc
{
  "ok": true,
  "outcome": "fresh",                 // "fresh" (a scan just ran) | "cached" (same commit already scanned)
  "runId": "8c1f...",                 // the run id; its event stream replays at /api/runs/<runId>/events
  "target": "expressjs/express",
  "commitSha": "18e5985b...",         // git SHA, or "<version>+<integrity>" for npm
  "score": 92,                        // 0-100, decided by a deterministic formula in code
  "verdict": "No threats observed",   // "No threats observed" | "Low risk" | "Caution" | "High risk" | "Malicious"
  "band": "green",                    // "green" | "blue" | "yellow" | "red" (fixed product color logic)
  "headline": "...",
  "summary": "...",
  "evidence": {                       // three groups, never blended
    "behaviour": ["..."],             // what running the code did
    "code": ["..."],                  // static findings on reachable install/import code
    "reputation": ["..."]             // owner, registry and community signals
  },
  "notVerified": ["..."],             // never empty: what this scan did not establish
  "breakdown": [ { "group": "behaviour", "code": "...", "points": -40, "detail": "..." } ],
  "reportUrl": "https://clauderabbit.in/expressjs/express",
  "ad": { "kind": "house", "placement": "scan_result", "id": "house-badge-v1", "label": "Sponsored", "headline": "...", "body": "...", "url": "..." }
}
```

On error the object is `{ "ok": false, "code": string, "message": string,
"ad"?: object }` (or `{ "ok": false, "error": string, "target": string }` when the target
string itself does not parse), so a consumer always gets parseable JSON.

### Field notes / rails encoded in the schema

- **`evidence.behaviour` vs `evidence.code` vs `evidence.reputation`.** Code and behaviour
  signals and reputation signals are never blended; they are separate fields, matching the
  product's structural rule.
- **`notVerified`.** Always present and never empty. It is the machine-readable form of the
  "never a bare Safe" rail.
- **`ad`.** Every response carries one sponsored message. It never gates a scan or a result.

## What a scan does and does NOT prove

Every scan runs the code. The target's tarball (GitHub archive or the npm registry artifact,
integrity verified) is installed with its scripts on and its entry point run, as a non-root
user, in a fresh E2B sandbox that is destroyed after the scan. A forge running as root inside
that sandbox answers every outbound call and records it, so a payload that phones home gets a
forged answer instead of reaching the real host. Static scanners, an OSV malicious-package
lookup on every dependency, and model readers run on the code that executes at install or
import time.

The `notVerified` list names what this does not reach: behaviour outside the observed install
and entry windows, code paths the install and entry point do not trigger, and payloads gated on
dates past the accelerated clock or on hosts that need real responses. Read any result as "here
is the score, here is the evidence, and here is exactly what we did not check", never as a
guarantee.

## Configuration

All optional: the CLI works with zero setup against ClaudeRabbit's production project.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_RABBIT_SITE_URL` | `https://clauderabbit.in` | API base (`/api/scan`) and the base of report links. |
| `CLAUDE_RABBIT_SCAN_TIMEOUT_MS` | built-in | How long a fresh (uncached) scan will stream before giving up. |
| `NO_COLOR` | unset | Set to disable ANSI color (also auto-disabled when stdout is not a TTY). |

## Development

```bash
npm run build       # compile TypeScript to dist/
npm run typecheck   # tsc --noEmit
npm run dev         # watch mode
```

## Architecture

- `src/lib/env.ts`: configuration (site URL and timeout); never reads a secret.
- `src/lib/scan-api.ts`: the only module that makes scan HTTP calls. Posts to `/api/scan` with
  the saved `cr_cli_` token, reads the NDJSON event stream, and renders stage lines, the
  verdict, score, evidence groups, `not_verified`, the report URL and the ad. The same file is
  copied to `mcp-server/src/scan-api.ts`.
- `src/lib/resolve.ts`: turns a user target into either a GitHub repo (`owner/repo`, URL,
  `owner/repo@ref`) or an npm package target (`{ package, version? }`). Purely local
  detection: an npm name is passed through to the API, which scans the real published artifact.
- `src/commands/scan.ts`, the `scan` command.
- `src/index.ts`, arg parsing and command dispatch.
- `src/lib/auth.ts`, the optional saved-token store at `~/.clauderabbit/credentials.json`
  (shared with `mcp-server/`); scanning never needs a token.
- `src/lib/claude-desktop-config.ts`, locates the real `claude_desktop_config.json`
  (classic path or, on Windows, the MSIX/Store package path) and merges an entry into it.
- `src/commands/mcp-install.ts`, the `mcp install` command.
