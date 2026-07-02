# Changelog

## 0.1.0 — 2026-07-02

Initial plugin scaffold.

- Added `scan-repo` skill: manual/auto-invoked inline scan report, shelling out to a `claude-rabbit scan <target> --json` CLI (dependency not yet landed on `main` — see plugin README).
- Added `PreToolUse` hook on the `Bash` matcher: detects `npm install`, `npm i`, `pnpm add`/`install`, `yarn add`, and `git clone` commands, extracts the install/clone target, and (when the `claude-rabbit` CLI is present) surfaces a scan verdict via `permissionDecision: "ask"` before the command runs. Fails open (no decision, normal permission flow) when the CLI or `jq` is missing, or the scan errors/times out.
- Added root-level `.claude-plugin/marketplace.json` so this repository can act as a self-hosted, testable marketplace.
- Verified with `claude plugin validate --strict` (plugin and marketplace level) and a live local marketplace-add / install / uninstall cycle against Claude Code CLI v2.1.198.
