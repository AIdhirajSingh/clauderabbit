# clauderabbit CLI

A command-line client for [ClaudeRabbit](https://github.com/AIdhirajSingh/clauderabbit) — a
free, no-login web tool that scans a public GitHub repo or npm package and returns an honest
0–100 safety score. This CLI lets you (or an AI coding agent) get that verdict **before you
install a dependency or clone a repo**, from the terminal.

It is a thin, self-contained client of the real, deployed ClaudeRabbit API — the same public
Supabase edge function and database read the web app and the
[MCP server](../mcp-server) use. It does not reimplement any scanning, scoring, or sandboxing
logic; it only calls the existing API and formats the response.

## The one rule it never breaks

Per ClaudeRabbit's core rail, **this CLI never states a bare "Safe."** Every result shows the
score, the verdict, the evidence behind it, and — critically — states plainly what was **not**
verified. A scan that has not run the dynamic sandbox is reported honestly as a *static read*,
never as a clearance. See "What a scan does and does not prove" below.

## Install

Published to npm as [`clauderabbit`](https://www.npmjs.com/package/clauderabbit):

```bash
npm install -g clauderabbit
clauderabbit scan expressjs/express
# or run it once with no install:
npx clauderabbit scan expressjs/express
```

This is a self-contained package — it has its own `package.json` and does **not** touch or
depend on the root ClaudeRabbit repo's `package.json`, `node_modules`, or build. To build from
source instead (e.g. to work on the CLI itself):

```bash
cd cli
npm install
npm run build      # produces dist/index.js
npm link           # get the `clauderabbit` command globally from this checkout
clauderabbit scan expressjs/express
```

Requires Node.js >= 18 (uses the built-in `fetch`). No API key is ever needed, but a signed-in
ClaudeRabbit account is required to use this CLI (and the [MCP server](../mcp-server)) — a
real product/access decision, not because the scan data itself is sensitive; report pages stay
public either way. The first command that needs one triggers `clauderabbit login`
automatically (opens your browser); the session is then saved to
`~/.clauderabbit/credentials.json` and reused silently until you `logout` — see
[`login` / `logout`](#login---token-token--logout). The Supabase URL and **publishable** key
are shipped as built-in defaults (they are not secrets — they are the exact two client-safe
values the web app ships; see the repo root `.env.example` and `docs/INFRASTRUCTURE.md`).
Override them for a fork via the env vars in the [Configuration](#configuration) table.

## Commands

### `scan <target> [--json] [--ref <ref>] [--no-color]`

Print a ClaudeRabbit verdict for `<target>`. Cache-aware, one command either way: if the
repo's current commit already has a report, it comes back immediately; if not, a real
fast-path scan runs. You never need to know or choose which case applies.

`<target>` may be:

| Form | Example | Resolves to |
|---|---|---|
| `owner/repo` | `expressjs/express` | that GitHub repo |
| `owner/repo@ref` or `owner/repo#ref` | `expressjs/express@5.0.0` | that repo at a ref |
| a GitHub URL | `https://github.com/expressjs/express` | that repo |
| an **npm package name** | `left-pad`, `@scope/pkg` | the real **published npm artifact** (its tarball + install hooks), scanned directly |
| an npm name **at a version** | `left-pad@1.3.0`, `npm:express@5`, `https://npmjs.com/package/left-pad/v/1.3.0` | that exact published version's artifact |

npm targets are passed straight through to the API, which scans the **actual published
artifact** — its tarball bytes, `postinstall`/`preinstall` hooks and all — rather than the
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
non-TTY stdout (e.g. piped output) — never raw escape codes in that case.

```bash
clauderabbit scan expressjs/express
clauderabbit scan left-pad --json          # scans the published npm artifact (report owner "npm")
clauderabbit scan npm:left-pad@1.3.0       # a specific published version
clauderabbit scan https://github.com/owner/repo --ref main
```

### `mcp install` — wire the ClaudeRabbit MCP server into Claude Desktop

```
clauderabbit mcp install
```

Finds your real `claude_desktop_config.json` and adds the ClaudeRabbit MCP server
(one cache-aware `scan` tool, stdio transport) to it — no manual JSON editing.

- **Finds the real file, including on Windows.** Checks the classic
  `%APPDATA%\Claude\claude_desktop_config.json` first, then — since a Microsoft
  Store/MSIX install of Claude Desktop keeps its real config in a different,
  undocumented place — globs `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`
  for it. Uses whichever one actually exists.
- **Only ever touches its own entry.** Reads the existing file, adds/updates the
  `"clauderabbit"` key under `mcpServers`, and writes the file back — every other server
  and setting already in the file is left exactly as it was. Refuses to touch a file that
  isn't valid JSON rather than risk clobbering it.
- **No hardcoded path baked into the launched command.** The server's on-disk location is
  passed via the `CLAUDE_RABBIT_MCP_SERVER_ENTRY` environment variable in the entry's own
  `env`, not as a literal string in `args`.
- **Tells you exactly what happened** — which file it found (and how), whether the entry
  was added or updated, and reminds you to restart Claude Desktop to pick it up.

### `login [--token <token>]` / `logout`

```
clauderabbit login
clauderabbit login --token <token>
clauderabbit logout
```

The CLI (and the MCP server) require a signed-in ClaudeRabbit account — a product/access
decision, not a reflection of the scan data being sensitive (reports stay public). `login`
opens your browser to sign in and saves the session to `~/.clauderabbit/credentials.json`;
every later command reuses it silently until you `logout`. Any command that needs a session
(`scan`, the MCP server) will trigger this sign-in flow automatically the first time if you
haven't run `login` yet. `--token` skips the browser and saves a token
issued elsewhere (e.g. the link the MCP server prints when called signed out).

## JSON output schema

`clauderabbit scan <target> --json` prints a single JSON object to **stdout**. On error, the
object is `{ "error": string, "target": string }` — so a consumer always gets parseable JSON,
never a torn stream. Progress/log lines go to **stderr** and never pollute the JSON.

A successful scan object:

```jsonc
{
  "target": "expressjs/express",     // "owner/repo" — the canonical id the API returned
  "owner": "expressjs",
  "repo": "express",
  "score": 96,                        // 0–100
  "verdict": "Trusted",               // "Trusted" | "Likely safe" | "Caution" | "High risk" | "Malicious"
  "scoreColor": "green",              // "green" | "blue" | "yellow" | "red" (fixed product color logic)
  "reportUrl": "https://clauderabbit.in/expressjs/express",
  "cached": false,
  "fresh": true,                      // true = a fresh scan just ran; false = served from cache
  "escalationDecided": false,         // the fast path DECIDED to escalate (NOT proof the sandbox ran)
  "sandboxActuallyRan": false,        // true ONLY when a forensic record is attached (the honest signal)
  "commitSha": "18e5985b…" ,          // resolved commit, or null
  "resolvedVia": "github",            // "github" | "npm" — how the target was resolved
  "npmPackage": null,                 // the npm package name, when resolvedVia === "npm"

  // Code/behavior findings ONLY (kind !== "rep") — kept separate from reputation.
  "behavior": [
    { "title": "…", "severity": "high|med|low", "kind": "behavior|code", "detail": "…" }
  ],

  // Reputation signals — owner/community — kept structurally separate from code/behavior.
  "reputation": {
    "owner":     { "handle": "…", "name": "…", "age": "…", "established": true, "repos": 49, "note": "" },
    "community": { "stars": "69.2k", "forks": "23.9k", "sentiment": "…", "sentScore": 100 },
    "findings":  [ { "title": "…", "severity": "…", "kind": "rep", "detail": "…" } ]
  },

  // The honest "what was NOT verified" list. EMPTY when the sandbox genuinely ran.
  "notVerified": [
    "Full runtime behavior (this repo was not executed in a sandbox on this pass)",
    "Every conditional and time-triggered branch",
    "Behavior under real credentials (no sandbox was run on this pass)"
  ],

  "hedge": "Static read only …; this repo was NOT executed in a sandbox …",  // one-line honest caveat
  "summary": "…",
  "stats": { "loc": "…", "packages": 0, "stars": "…", "created": "…" },
  "packages": [ { "name": "…", "score": 0, "note": "…" } ],
  "forensics": null,                  // full forensic record, present ONLY when sandboxActuallyRan === true

  "proceed": { "trusted": false, "strongWarning": false }  // convenience flags for scripted/agent logic
}
```

### Field notes / rails encoded in the schema

- **`sandboxActuallyRan` vs `escalationDecided`.** A scan runs the **fast path** only. It can
  *decide* a repo should escalate to the dynamic sandbox (`escalationDecided: true`) without
  the sandbox having actually executed. `sandboxActuallyRan` is `true` **only** when a
  forensic record is attached (`forensics !== null`). Key "did the sandbox run" off
  `sandboxActuallyRan` / `forensics`, **never** off `escalationDecided` alone.
- **`behavior` vs `reputation`.** Code/behavior signals and reputation signals are never
  blended — they are separate top-level fields, matching the product's structural rule.
- **`notVerified`.** Non-empty for a static read; empty when the sandbox genuinely ran
  (running the code is the point, not a caveat). This is the machine-readable form of the
  "never a bare Safe" rail.

## What a scan does and does NOT prove

ClaudeRabbit is a two-speed system. The fast path (what `scan` calls) runs on
essentially every request: static analysis, reputation lookup, and a fast model reading only
the flagged regions. A small share of ambiguous repos get **escalated** to a full
dynamic-sandbox detonation — the repo is actually built and run inside a hermetic,
network-locked-down, single-use VM. That detonation is a separate, privileged process and is
**not** something this public API call forces to complete synchronously.

So a scan result reflects the fast-path read plus reputation. When `sandboxActuallyRan` is
`false`, no code was executed — the verdict is a **static-read** assessment and the
`notVerified` list is real. Do not read any scan result as a guarantee of safety; read it as
"here is the score, here is the evidence, and here is exactly what we did not check."

## Configuration

All optional — the CLI works with zero setup against ClaudeRabbit's production project.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_RABBIT_SUPABASE_URL` | ClaudeRabbit's project URL | Supabase project to call. |
| `CLAUDE_RABBIT_SUPABASE_PUBLISHABLE_KEY` | ClaudeRabbit's public key | Publishable key — safe client-side, same one the web app uses. |
| `CLAUDE_RABBIT_SITE_URL` | `https://clauderabbit.in` | Base URL used to build the report links in output. |
| `CLAUDE_RABBIT_SCAN_TIMEOUT_MS` | `120000` | How long a fresh (uncached) scan will stream before giving up. |
| `NO_COLOR` | — | Set to disable ANSI color (also auto-disabled when stdout is not a TTY). |

## Development

```bash
npm run build       # compile TypeScript to dist/
npm run typecheck   # tsc --noEmit
npm run dev         # watch mode
```

## Architecture

- `src/lib/env.ts` — configuration (public defaults + env overrides); never reads a secret.
- `src/lib/client.ts` — the only module that makes ClaudeRabbit HTTP calls. Mirrors the main
  app's `lib/scan.ts` (`runScan`, NDJSON stream + cache-hit JSON), reimplemented standalone
  (mirrors the production-verified `mcp-server/` client).
- `src/lib/resolve.ts` — turns a user target into either a GitHub repo (`owner/repo, URL,
  owner/repo@ref`) or an npm package target (`{ package, version? }`). Purely local detection:
  an npm name is passed through to the API, which scans the real published artifact — the
  registry→GitHub-repo redirect this module used to do is gone (it was blind to a malicious
  version published only to the registry).
- `src/lib/normalize.ts` — coerces an arbitrary API payload into a strict `Report` and
  enforces the "never a bare Safe verdict" rail (mirrors the app's `normalizeReport` /
  `enforceVerdict`).
- `src/lib/format.ts` — the text and `--json` renderers, the score-color logic, the honest
  hedge/not-verified copy, and the proceed policy exposed via `--json`'s `proceed` field.
  Terminal styling is real (`chalk` for colors/badges, `boxen` for the bordered score/verdict
  box), gated by an explicit `color: boolean` the caller computes from
  `--no-color`/`NO_COLOR`/TTY — never chalk's own independent auto-detection, so it can't
  disagree with the CLI's decision.
- `src/commands/scan.ts` — the `scan` command.
- `src/index.ts` — arg parsing and command dispatch.
- `src/lib/auth.ts` — the shared login flow (`login`/`logout`/`ensureLoggedIn`), persisted to
  `~/.clauderabbit/credentials.json` (shared with `mcp-server/`).
- `src/lib/claude-desktop-config.ts` — locates the real `claude_desktop_config.json`
  (classic path or, on Windows, the MSIX/Store package path) and merges an entry into it.
- `src/commands/mcp-install.ts` — the `mcp install` command.
