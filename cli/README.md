# claude-rabbit CLI

A command-line client for [Claude Rabbit](https://github.com/AIdhirajSingh/clauderabbit) — a
free, no-login web tool that scans a public GitHub repo or npm package and returns an honest
0–100 safety score. This CLI lets you (or an AI coding agent) get that verdict **before you
install a dependency or clone a repo**, from the terminal, and optionally wire it in as an
opt-in shell hook so it runs automatically before `npm install` / `pnpm install` / `git clone`.

It is a thin, self-contained client of the real, deployed Claude Rabbit API — the same public
Supabase edge function and database read the web app and the
[MCP server](../mcp-server) use. It does not reimplement any scanning, scoring, or sandboxing
logic; it only calls the existing API and formats the response.

## The one rule it never breaks

Per Claude Rabbit's core rail, **this CLI never states a bare "Safe."** Every result shows the
score, the verdict, the evidence behind it, and — critically — states plainly what was **not**
verified. A scan that has not run the dynamic sandbox is reported honestly as a *static read*,
never as a clearance. See "What a scan does and does not prove" below.

## Install

This is a self-contained package — it has its own `package.json` and does **not** touch or
depend on the root Claude Rabbit repo's `package.json`, `node_modules`, or build.

```bash
cd cli
npm install
npm run build      # produces dist/index.js
```

Then run it directly, or link it onto your PATH:

```bash
node dist/index.js scan expressjs/express
# or, to get the `claude-rabbit` command globally:
npm link           # inside cli/  (uses the "bin" field)
claude-rabbit scan expressjs/express
```

Requires Node.js >= 18 (uses the built-in `fetch`). No API key, login, or token is ever
needed — every call is the same anonymous, public call the website makes for a logged-out
visitor. The Supabase URL and **publishable** key are shipped as built-in defaults (they are
not secrets — they are the exact two client-safe values the web app ships; see the repo root
`.env.example` and `docs/INFRASTRUCTURE.md`). Override them for a fork via the env vars in the
[Configuration](#configuration) table.

## Commands

### `scan <target> [--json] [--ref <ref>] [--no-color]`

Run (or hit the cache for) a Claude Rabbit fast-path scan and print the verdict.

`<target>` may be:

| Form | Example | Resolves to |
|---|---|---|
| `owner/repo` | `expressjs/express` | that GitHub repo |
| `owner/repo@ref` or `owner/repo#ref` | `expressjs/express@5.0.0` | that repo at a ref |
| a GitHub URL | `https://github.com/expressjs/express` | that repo |
| an **npm package name** | `left-pad`, `@scope/pkg` | its GitHub repo, via the npm registry `repository` field |

`--json` emits the machine-readable object documented in [JSON output](#json-output-schema).

```bash
claude-rabbit scan expressjs/express
claude-rabbit scan left-pad --json          # resolved via npm → stevemao/left-pad
claude-rabbit scan https://github.com/owner/repo --ref main
```

### `report <target> [--json]`

Read an **existing** cached report from Claude Rabbit's public database **without** triggering
a new scan. Prints an honest "not found" (exit code 4) if the repo has never been scanned —
never fabricated data.

### `npm-install` / `pnpm-install` / `git-clone` — the install wrappers

```
claude-rabbit npm-install  <args...>   [--yes] [--dry-run] [--no-color]
claude-rabbit pnpm-install <args...>   [--yes] [--dry-run] [--no-color]
claude-rabbit git-clone    <args...>   [--yes] [--dry-run] [--no-color]
```

Each one scans the package/repo being fetched, prints the honest verdict, then runs the real
underlying command (`npm <args>`, `pnpm <args>`, `git clone <args>`) with stdio inherited.

The **proceed policy** is deliberately honest and never implies bare safety:

- Only a **Trusted** verdict (score ≥ 90) may proceed on a brief one-line confirmation.
- **Likely safe** and below always print the full hedge (what was / wasn't verified) and the
  code/behavior findings **before** proceeding, so a human or agent always sees exactly what
  was and wasn't verified — never just a green light.
- Scores below 60 (**High risk** / **Malicious**) additionally print a loud STRONG WARNING.
- It never silently **blocks** either (a wrong auto-deny is also false certainty). In an
  interactive terminal it prompts; non-interactively it refuses to auto-run unless `--yes` is
  given, and even then it proceeds only *after* printing the full verdict.

Flags:

- `--yes` (`-y`) — non-interactive/agent mode: proceed after printing the verdict (never a
  silent green light).
- `--dry-run` — scan and report only; never run the underlying command.

Exit codes: `0` ran (or dry-run of a non-warning target); `2` user declined at the prompt;
`3` non-interactive and no `--yes`; `10` dry-run that surfaced a strong warning; `126`
refused because an argument contained shell metacharacters; otherwise the underlying command's
own exit code.

### `install-hooks` / `uninstall-hooks` — opt-in shell integration

```
claude-rabbit install-hooks   [--shell bash|zsh|powershell] [--profile <path>] [--print]
claude-rabbit uninstall-hooks [--shell bash|zsh|powershell] [--profile <path>]
```

Adds (or removes) shell **functions** that wrap `npm`/`pnpm`/`git` so an install or clone is
scanned first. The block is written between clearly delimited markers, so re-installing is
idempotent and uninstalling removes exactly what was added, leaving the rest of your profile
untouched. `--print` prints the block to stdout without writing anything.

Default profile per shell: bash → `~/.bashrc`, zsh → `~/.zshrc`, PowerShell →
`~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1` (Windows) or
`~/.config/powershell/Microsoft.PowerShell_profile.ps1` (POSIX). Override with `--profile`.
Restart the shell (or `source` the profile) afterward.

#### Honest coverage — what the hooks DO and DO NOT wrap

Shell functions can only intercept the exact invocation *shapes* they recognize. This is a
real, bounded blast radius, and pretending otherwise would itself be a false-certainty
failure. The hooks:

**Wrapped** (scanned before running):
- `npm install <pkg>`, `npm i <pkg>`, `npm add <pkg>`
- `pnpm install <pkg>`, `pnpm i <pkg>`, `pnpm add <pkg>`
- `git clone <url>`

**NOT wrapped** — these fall straight through to the real tool, **unscanned**:
- **Bare `npm install`** / `pnpm install` with no package argument (installing an existing
  `package.json` / lockfile) — no single new dependency is being fetched to scan.
- **`npm ci`** — installs the whole lockfile; not a single-target fetch.
- **`npx <pkg>`** — runs a package; not routed through the `npm` function.
- **`corepack`-invoked pnpm/yarn** — corepack spawns the manager binary directly, bypassing
  the shell function.
- **`yarn`** (any form) — not wrapped.
- **Scoped/workspace/monorepo installs** (`-w`, `--filter`, `--workspace`) — the wrapper
  extracts explicit package targets from the command line but does not fully model every
  workspace resolution; a workspace-internal dependency graph is not expanded and scanned.
- **`--save-dev` / `--save` / other flags** — recognized and skipped as flags; they do not
  change which package targets are scanned, but the wrapper does not special-case dev-vs-prod.
- **Any other tool that shells out to npm/git**, any aliased or absolute-path invocation
  (`/usr/bin/npm`, `command npm`), and anything inside a subshell that did not source the
  hook.

If you need a guarantee that a specific dependency was scanned, run `claude-rabbit scan <pkg>`
explicitly. The hooks are a convenience for the common interactive case, not a security
boundary.

## JSON output schema

`claude-rabbit scan <target> --json` (and `report <target> --json`) print a single JSON object
to **stdout**. On error, the object is `{ "error": string, "target": string }` (and, for a
cache miss on `report`, also `"notFound": true`) — so a consumer always gets parseable JSON,
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
  "reportUrl": "http://localhost:2311/expressjs/express",
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

  "proceed": { "trusted": false, "strongWarning": false }  // convenience flags for hook/agent logic
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

## Reconciliation with the Claude Code plugin

The sibling Claude Code plugin (`plugins/claude-rabbit`) ships a `PreToolUse` hook
(`scripts/pre-install-scan.sh`) that shells out to **`claude-rabbit scan <target> --json`** and
parses fields from the stdout JSON. The plugin's expected field set is:
`target`, `score`, `verdict`, `reportUrl`, `reputation`, `behavior`, `notVerified`.

**This CLI's `--json` output provides every one of those fields at the top level**, so the
plugin's existing extraction works as-is:

| Plugin expects | This CLI emits | Match |
|---|---|---|
| `.target` | `target` (`"owner/repo"`) | ✅ exact |
| `.score` | `score` (0–100) | ✅ exact |
| `.verdict` | `verdict` (word) | ✅ exact |
| `.reportUrl` | `reportUrl` | ✅ exact |
| `.reputation` | `reputation` **(object: `owner`/`community`/`findings`)** | ✅ present; see note |
| `.behavior` | `behavior` (array of code/behavior findings) | ✅ exact |
| `.notVerified` | `notVerified` (array of strings) | ✅ exact |

The one place to reconcile deliberately: `reputation` here is a **structured object** (owner +
community + reputation-kind findings), not a flat string. That is the correct shape given the
real `Report` type and the product's rule that reputation is a distinct, itemized signal — a
flat string would lose the owner/community separation. The plugin's current hook only reads
`.score`, `.verdict`, and `.reportUrl` via `jq` (it does not yet dereference `.reputation` or
`.behavior`), so nothing breaks today; when the plugin starts surfacing those, it should read
`reputation.owner` / `reputation.community` / `reputation.findings` and the `behavior` array
rather than expecting flat strings. No contortion was applied on the CLI side to match a
lossy guessed shape.

## What a scan does and does NOT prove

Claude Rabbit is a two-speed system. The fast path (what `scan`/`report` call) runs on
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

All optional — the CLI works with zero setup against Claude Rabbit's production project.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_RABBIT_SUPABASE_URL` | Claude Rabbit's project URL | Supabase project to call. |
| `CLAUDE_RABBIT_SUPABASE_PUBLISHABLE_KEY` | Claude Rabbit's public key | Publishable key — safe client-side, same one the web app uses. |
| `CLAUDE_RABBIT_SITE_URL` | `http://localhost:2311` | Base URL used to build the report links in output. |
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
- `src/lib/client.ts` — the only module that makes Claude Rabbit HTTP calls. Mirrors the main
  app's `lib/scan.ts` (`runScan`, NDJSON stream + cache-hit JSON) and `lib/report-fetch.ts`
  (`fetchLatestReportRest`), reimplemented standalone (mirrors the production-verified
  `mcp-server/` client).
- `src/lib/resolve.ts` — turns a user target (owner/repo, URL, or npm name) into an
  `{ owner, repo, ref? }`; npm names are resolved via the public npm registry `repository` field.
- `src/lib/normalize.ts` — coerces an arbitrary API payload into a strict `Report` and
  enforces the "never a bare Safe verdict" rail (mirrors the app's `normalizeReport` /
  `enforceVerdict`).
- `src/lib/format.ts` — the text and `--json` renderers, the score-color logic, the honest
  hedge/not-verified copy, and the install-wrapper proceed policy.
- `src/commands/scan.ts` — the `scan` command.
- `src/commands/wrap.ts` — the `npm-install` / `pnpm-install` / `git-clone` wrappers (target
  extraction, proceed policy, safe child spawn with a shell-metacharacter guard).
- `src/commands/hooks.ts` — `install-hooks` / `uninstall-hooks` (bash/zsh/PowerShell blocks,
  idempotent write/remove).
- `src/index.ts` — arg parsing and command dispatch.
```
