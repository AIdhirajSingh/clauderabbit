# Distribution checklist — Claude Code plugin, CLI, and beyond

Honest status of every distribution surface for Claude Rabbit's terminal/agent tooling, as of 2026-07-02. Items marked **done** were actually completed and verified in this repository. Everything else is an accurate, concrete, not-yet-done checklist — nothing here is implemented today unless explicitly marked done.

## Claude Code plugin marketplace

- [x] **Plugin built and validated.** `plugins/claude-rabbit/` passes `claude plugin validate --strict`. Root `.claude-plugin/marketplace.json` passes `claude plugin validate . --strict`. Both were run live against Claude Code CLI v2.1.198 — see `plugins/claude-rabbit/README.md` for full verification log.
- [x] **Self-hosted marketplace works today.** `claude plugin marketplace add AIdhirajSingh/clauderabbit` + `claude plugin install claude-rabbit@clauderabbit-marketplace` is a real, functional path the moment this merges to `main` and the repo is public. No approval needed.
- [ ] **Community marketplace submission** (`claude-community`, reviewed by Anthropic). Real, documented forms exist:
  - claude.ai: `claude.ai/admin-settings/directory/submissions/plugins/new` (needs Team/Enterprise org + directory-management access)
  - Console: `platform.claude.com/plugins/submit` (path for individual authors)
  Not submitted yet — deliberately deferred until the `claude-rabbit-cli` dependency lands on `main`, since the hook/skill are inert without it. Submitting now would put a plugin whose core feature silently no-ops in front of reviewers and users.
- [ ] **Official marketplace** (`claude-plugins-official`). Confirmed from docs: **no application process exists.** Anthropic curates this entirely at its own discretion; the submission forms above do not add to it. Nothing to do here except be a good, widely-adopted plugin and hope to be noticed — do not represent this as an actionable checklist item with a process.

## npm — the `claude-rabbit-cli` package

- [x] **Name availability checked live.** `npm view claude-rabbit-cli` and `npm view claude-rabbit` both returned `404 Not Found` against the real public registry on 2026-07-02 — both names are currently unclaimed and available to publish under, unscoped.
- [ ] **CLI itself does not exist yet** in this repository (confirmed via `git branch -a` / `git fetch origin` — no `cli/` directory on any local or remote branch as of this work). This is a hard blocker for everything below.
- [ ] **Decide unscoped vs. scoped name.** `claude-rabbit-cli` (unscoped, per the task's stated package name) is available today, but availability can change before the sibling branch ships — re-check with `npm view claude-rabbit-cli` immediately before the first publish. A scoped alternative (e.g. `@clauderabbit/cli`) is a fallback if the unscoped name is taken by then.
- [ ] **Publish setup**: `npm login` under whatever npm org/account will own the package, `package.json` with `bin` field pointing at the CLI entrypoint, `files`/`.npmignore` to avoid shipping source-only files, and a real `npm publish` — none of this exists yet since the CLI doesn't exist.
- [ ] **`--json` flag contract**: this plugin's hook and skill both assume `claude-rabbit scan <target> --json` prints a single JSON object to stdout and exits non-zero on failure. Once the CLI exists, verify this plugin's parsing against its *actual* output shape (field names may differ from the guessed shape in `plugins/claude-rabbit/skills/scan-repo/SKILL.md` and `plugins/claude-rabbit/scripts/pre-install-scan.sh`).

## Homebrew

- [ ] **Not started.** Requires: at least one tagged GitHub release of the CLI with a built, checksummed release tarball (doesn't exist — no CLI, no releases). A `Formula/claude-rabbit.rb` in either a personal tap (`AIdhirajSingh/homebrew-claude-rabbit`) or a submission to homebrew-core (much higher bar: notability requirements, maintainer review) would need:
  - `url` pointing at a release tarball
  - `sha256` of that tarball
  - `depends_on` for any runtime deps (e.g. `jq` if the CLI shells out to it, which it should not need to since it'd be a compiled/bundled binary or Node package)
  - A `test do` block exercising `claude-rabbit --version` or similar
- [ ] Personal tap is the realistic near-term path; homebrew-core submission is a later-stage distribution goal, not a V1 concern.

## Scoop (Windows)

- [ ] **Not started.** Same blocker: no tagged release exists yet. A `bucket/claude-rabbit.json` manifest would need:
  - `version`, `url` (Windows-built zip/exe asset), `hash` (sha256)
  - `bin` pointing at the executable name
  - Either a personal bucket (`scoop bucket add clauderabbit https://github.com/AIdhirajSingh/scoop-claude-rabbit`) or submission to the `extras` bucket (community-maintained, has its own review process)
- [ ] Needs a Windows release artifact from whatever build/packaging the CLI's own repo sets up (e.g. `pkg`/`nexe` if Node-based, or a native binary if written in Go/Rust) — this doesn't exist yet since the CLI doesn't exist.

## MCP server distribution

Out of scope for this checklist's detail level since `mcp-server/` doesn't exist on any branch yet either (confirmed alongside the `cli/` check). Once it lands, it has its own distribution surface (MCP registry, `npx`-installable stdio server) that should get the same treatment as this checklist gives the CLI — not duplicated here since it wasn't asked for.

## Summary of what's real right now

The only distribution channel that is genuinely live today is: this repository itself, once public, as a self-hosted Claude Code marketplace via `.claude-plugin/marketplace.json`. Every other channel in this checklist is blocked on the `claude-rabbit-cli` package existing, which is tracked on the sibling branch `feat/cli-install-hooks` and was not visible to this work (not present on `origin` or any local branch at the time of writing).
