# Claude Rabbit — Claude Code plugin

A Claude Code plugin that brings [Claude Rabbit](https://github.com/AIdhirajSingh/clauderabbit)'s repo-safety scanning into your coding-agent sessions: a manual `scan-repo` skill for on-demand checks, and a `PreToolUse` hook that scans install/clone targets before `npm install`, `pnpm add`, `yarn add`, or `git clone` runs.

## What it does

- **`scan-repo` skill** (`/claude-rabbit:scan-repo`): invoke it yourself, or let Claude invoke it automatically when you paste a GitHub URL or package name and ask "is this safe" / "scan this repo" / "check this before I install it". It shells out to the `claude-rabbit` CLI, parses the JSON result, and renders an inline report that preserves Claude Rabbit's core rules — no bare "Safe", reputation signals kept visibly separate from code/behavior signals, and an explicit statement of what was and wasn't verified.
- **Pre-install hook** (`PreToolUse` on `Bash`): before a matching `npm install <pkg>`, `npm i <pkg>`, `pnpm add/install <pkg>`, `yarn add <pkg>`, or `git clone <url>` command actually runs, the hook scans the target and surfaces the verdict via a `permissionDecision: "ask"` response — Claude (or you, at the permission prompt) sees the score and reasoning before the command executes and can decide whether to proceed. It never auto-denies: a wrong "block" is its own false-certainty failure mode, so the decision is always left to the human/agent in the loop, matching Claude Rabbit's own "never state a bare Safe" rule.

## Hard dependency: the `claude-rabbit` CLI

**This plugin does not itself implement scanning.** It shells out to a `claude-rabbit` binary on `PATH`, invoked as:

```bash
claude-rabbit scan <target> --json
```

As of this writing, that CLI (`claude-rabbit-cli` on npm, being built on a sibling branch `feat/cli-install-hooks`) has **not landed on `main`** in this repository. `git fetch origin && git branch -a` and a full-history search for `cli/` and `mcp-server/` directories both come back empty on every branch, local and remote, as of the date this plugin was built.

Until that CLI ships and is installed:

- The **hook fails open**: if `claude-rabbit` isn't found on `PATH`, or the scan errors, times out, or returns unparseable output, the hook exits `0` with no output — Bash commands proceed normally, exactly as if the plugin weren't installed. This was verified directly (see "What was verified" below), not assumed.
- The **skill** will tell you plainly that it cannot run a live scan and will not fabricate a result.

Install the CLI once it ships (`npm install -g claude-rabbit-cli` or equivalent — exact install instructions belong in that package's own README) to get real scans from both the skill and the hook.

## Install locally for testing

From the repository root:

```bash
# Register this repo as a local marketplace
claude plugin marketplace add ./ --scope local

# Install the plugin from it
claude plugin install claude-rabbit@clauderabbit-marketplace --scope local

# Confirm it loaded, and see its component inventory
claude plugin list
claude plugin details claude-rabbit@clauderabbit-marketplace
```

Or, for quick iteration without installing, load the plugin directory directly for a single session:

```bash
claude --plugin-dir ./plugins/claude-rabbit
```

After making changes, run `/reload-plugins` inside a session to pick them up without restarting.

To remove the test install:

```bash
claude plugin uninstall claude-rabbit@clauderabbit-marketplace --scope local
claude plugin marketplace remove clauderabbit-marketplace --scope local
```

## Validate the manifest

```bash
claude plugin validate ./plugins/claude-rabbit --strict
claude plugin validate . --strict   # validates the root marketplace.json too
```

Both commands passed with `--strict` (warnings-as-errors) against Claude Code CLI v2.1.198 at the time this plugin was built.

## What was verified locally, live, and how

All of the following were actually run in this repository, not just described:

1. `claude plugin validate ./plugins/claude-rabbit --strict` → passed.
2. `claude plugin validate . --strict` (marketplace-level) → passed.
3. `claude plugin marketplace add ./ --scope local` → succeeded, registered `clauderabbit-marketplace`.
4. `claude plugin install claude-rabbit@clauderabbit-marketplace --scope local` → succeeded.
5. `claude plugin details claude-rabbit@clauderabbit-marketplace` → correctly reported **Skills (1): scan-repo**, **Hooks (1): PreToolUse**, with real projected token costs — proof the manifest, skill, and hook were all discovered and parsed correctly by the real Claude Code plugin loader.
6. `plugins/claude-rabbit/scripts/pre-install-scan.sh` was run directly (outside of Claude Code) with piped JSON payloads simulating real `PreToolUse` stdin for: `git clone`, `npm install <pkg>`, `npm i <pkg>`, `pnpm add <pkg>`, `yarn add <pkg>`, a bare `npm install` with no target, and an unrelated command (`ls`). Every install/clone-with-target case produced the correct `hookSpecificOutput.permissionDecision: "ask"` JSON with a synthesized reason string; every non-matching or targetless case exited `0` with no output (the documented "no decision, fall through to normal permission flow" behavior).
   - Additionally, `plugins/claude-rabbit/scripts/tests/test-extract-target.sh` unit-tests the argument parser (`extract_target()`) in isolation by sourcing the hook script with `CLAUDE_RABBIT_SOURCED_FOR_TEST=1`. It asserts correct target extraction for `git clone -b main <url>`, `git clone --depth 1 <url>`, `git clone -o upstream <url>`, `git clone --branch main <url> myrepo` (the confirmed flag-arity bug repro cases — see "Known limitations" below), plus `--flag=value` forms, boolean flags, `--` end-of-options, and npm/pnpm/yarn's own value-taking flags (`--registry`, `-w`, `--filter`, etc.). Run it with `bash plugins/claude-rabbit/scripts/tests/test-extract-target.sh`; it exits non-zero if any case fails.
7. The **fail-open path was verified for real**, not assumed: with no `claude-rabbit` binary on `PATH` at all, the script exits `0` silently. With a stub `claude-rabbit` binary that exits non-zero (simulating a scan failure), the script still exits `0` silently. With `jq` absent from `PATH` (the real state of this dev environment before jq was installed for testing), the script exits `0` immediately rather than risk parsing JSON with raw shell string matching.
8. What was **not** and **could not** be verified: an actual scan result from the real Claude Rabbit backend (Supabase edge functions), because the `claude-rabbit` CLI does not exist in this repository yet. The hook and skill logic were verified against a hand-written stub CLI that returns a canned JSON shape (`{target, score, verdict, reportUrl}`), not the real CLI's actual output. When the real CLI lands, this plugin's assumed JSON shape should be re-checked against its actual output and adjusted if it differs.
9. Firing the hook **inside a live interactive Claude Code session** (i.e. actually typing `npm install foo` at a real prompt and watching the hook intercept it) was **not done** — this would require an interactive TTY session, which isn't available in this environment. The component-inventory proof (item 5) and the direct stdin-piped script tests (items 6–7) are the strongest verification achievable non-interactively, but they are not a substitute for an interactive firing test.

## Submitting to the Claude Code plugin marketplace

Two real, distinct paths exist, confirmed directly against the official documentation (`code.claude.com/docs/en/plugins`, fetched during this work):

### 1. Self-hosted marketplace (works today, no approval needed)

Anyone can add `.claude-plugin/marketplace.json` (already present at this repo's root) and share it:

```bash
claude plugin marketplace add AIdhirajSingh/clauderabbit
claude plugin install claude-rabbit@clauderabbit-marketplace
```

This requires no submission or review. It's fully functional the moment this branch merges to `main` and the repo is public.

### 2. Community marketplace (`claude-community`) — requires review

Anthropic runs a public community marketplace at [`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community). Submission is via one of two real, documented in-app forms:

- **claude.ai**: [claude.ai/admin-settings/directory/submissions/plugins/new](https://claude.ai/admin-settings/directory/submissions/plugins/new) — requires a Team or Enterprise organization with directory-management access.
- **Console**: [platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit) — the path for individual authors not on a Team/Enterprise org.

The review pipeline runs `claude plugin validate` (the same command documented above) plus automated safety screening. Approved plugins are pinned to a commit SHA in the community catalog and the pin auto-bumps on new commits; the public catalog syncs nightly, so there's a delay between approval and availability.

**Not done as part of this work**: the actual submission. That's a deliberate choice — the CLI dependency (`claude-rabbit-cli`) hasn't landed yet, and submitting a plugin whose hook silently no-ops for every user until a separate package ships would be premature. Submit once the CLI is on `main` and this plugin's live-scan behavior has been exercised against it.

### 3. Official marketplace (`claude-plugins-official`)

This is curated entirely at Anthropic's discretion. **There is no application process** — the submission forms above add plugins to the community marketplace, not the official one. Confirmed directly from the fetched docs; not asserting anything beyond what they state.

## Known limitations / honest gaps

- **Depends on an unshipped CLI.** Every scan capability in this plugin is inert until `claude-rabbit-cli` (or an equivalent binary named `claude-rabbit` on `PATH`) exists. This plugin does not stub or fake that binary.
- **`jq` is a real runtime dependency of the hook script.** If `jq` isn't installed, the hook silently no-ops (fails open) rather than scanning. This is the correct safety default, but it means the hook provides zero protection on a machine without `jq` unless that's fixed (e.g. bundling a JSON-parsing fallback, or documenting `jq` as a plugin prerequisite more prominently).
- **The hook script runs on every single `Bash` tool call**, not just installs — it does its own filtering internally rather than using several `if`-scoped hook entries in `hooks.json`. Measured overhead for a non-matching command in this environment was ~0.3 seconds (dominated by bash/jq process startup), which did not feel disruptive in manual testing, but this was not measured under real session load or on slower machines.
- **No interactive end-to-end firing test.** See verification item 9 above.
- **The assumed CLI JSON output shape (`target`, `score`, `verdict`, `reputation`, `behavior`, `notVerified`, `reportUrl`) is a guess based on the product's documented report structure, not a contract verified against real CLI output**, since the CLI doesn't exist yet. Revisit both the skill's parsing instructions and the hook script's `jq` field extraction once the real CLI ships.
- **Argument parsing knows real flag arity, not just "starts with a dash."** An earlier version of `extract_target()` (née `extract_first_non_flag_arg()`) treated *any* token starting with `-` as a flag to skip and everything else as the target. That is wrong for flags that take a following value: `git clone -b main <url>` extracted `"main"` as the scan target instead of the URL; `git clone --depth 1 <url>` extracted `"1"`; `git clone -o upstream <url>` extracted `"upstream"`; `git clone --branch main <url> myrepo` extracted `"main"`. Worse, in every one of these cases the hook still emitted a normal-looking `permissionDecision: "ask"` response claiming to have scanned a real target — a fabricated-looking safety check that never inspected the actual clone URL, which is worse than a clean skip because it looks like protection happened when it didn't. This is now fixed: `extract_target()` carries per-tool tables of which flags take a following value, verified directly against `git clone -h` (the installed git's own usage text) for git, and against `npm install --help` / pnpm's documented `add`/`install` CLI options for npm and pnpm. It correctly consumes both the flag and its value token, handles the `--flag=value` self-contained form, handles `--` end-of-options, and is covered by `plugins/claude-rabbit/scripts/tests/test-extract-target.sh`, which reproduces all four cases above plus `--registry`, `-w`/`--filter`, boolean flags, and the `--flag=value` form. Concretely handled now: for `git clone` — `-b`/`--branch`, `-o`/`--origin`, `--depth`, `-c`/`--config`, `-u`/`--upload-pack`, `-j`/`--jobs`, `--template`, `--reference[-if-able]`, `--revision`, `--shallow-since`, `--shallow-exclude`, `--separate-git-dir`, `--ref-format`, `--server-option`, `--filter`, `--bundle-uri`; for `npm install`/`npm i` — `--registry`, `-w`/`--workspace`, `--install-strategy`, `--omit`, `--include`, `--before`, `--min-release-age`, `--cpu`, `--os`, `--libc`, `--tag-version-prefix`; for `pnpm add`/`pnpm install` — `--registry`, `--filter`, `--allow-build`, `--save-catalog-name`, `--cpu`, `--os`, `--libc`; for `yarn add` — `--registry`, `--cwd`, `--cache-folder`.
- **Still-open gap, disclosed rather than silently guessed around: unrecognized long flags are assumed boolean.** If a future git/npm/pnpm/yarn release adds a new value-taking long flag not in the tables above, and a command uses it in the space-separated `--newflag value` form (not `--newflag=value`), the parser will currently treat `--newflag` as boolean noise and may misidentify `value` as the target. This is a real residual risk, not eliminated, only shrunk to "new flags we haven't seen yet" from "the vast majority of common flags in daily use." Bundled short flags are handled more conservatively: if a bundle like `-ob` contains a letter that is a known value-taking short flag for that tool and the bundle is ambiguous, the hook now **fails safely and visibly** — it does not scan, and emits an `ask` decision that plainly states `"Claude Rabbit could not confidently determine the install/clone target from this command (ambiguous flag usage) and is proceeding WITHOUT a safety scan. No target was checked."` It never fabricates a scan result for a guessed-wrong target.
