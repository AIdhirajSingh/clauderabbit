#!/usr/bin/env bash
# Claude Rabbit PreToolUse hook: fast safety scan before npm/pnpm/yarn install
# or git clone commands run.
#
# Contract (Claude Code PreToolUse hooks, confirmed against the live docs at
# code.claude.com/docs/en/hooks and code.claude.com/docs/en/plugins-reference):
#   - stdin:  JSON payload with .tool_name and .tool_input.command
#   - stdout: JSON with hookSpecificOutput.permissionDecision one of
#             allow | deny | ask | defer, plus permissionDecisionReason
#   - exit 0 with no stdout JSON = no decision, normal permission flow
#   - PreToolUse cannot use async:true and still block — this hook is
#     synchronous by design, kept fast with a short internal timeout, and
#     fails OPEN (falls through to the default permission flow) on any
#     error, timeout, or missing dependency. It never blocks Bash usage
#     just because Claude Rabbit itself is unavailable.
#
# This script intentionally does its OWN filtering (rather than using several
# `if`-scoped hook entries in hooks.json) so that all install/clone pattern
# matching lives in one testable, extensible place. See plugins/claude-rabbit/README.md
# for the tradeoff this implies (the script runs on every Bash call, not just
# installs — it exits immediately for non-matching commands).

set -u

# --- read stdin payload -------------------------------------------------
input="$(cat)"

# Requires jq. If jq is missing we cannot safely parse tool_input, so fail
# open immediately rather than risk a bad regex against raw JSON.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

command_str="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"

if [ -z "$command_str" ]; then
  exit 0
fi

# --- detect install/clone targets ---------------------------------------
# Matches (case-sensitive, matching real CLI usage):
#   npm install <pkg>, npm i <pkg>
#   pnpm add <pkg>, pnpm install <pkg>
#   yarn add <pkg>
#   git clone <url>
# Deliberately conservative: only fires on recognizable subcommands, and
# only extracts a target when one is present (bare `npm install` with no
# args, e.g. installing from an existing package.json/lockfile, is not a
# new-dependency-fetch event and is skipped).

target=""

extract_first_non_flag_arg() {
  # Reads remaining words on stdin, returns the first one that isn't a
  # flag (doesn't start with -) and isn't a bare npm/yarn/pnpm subcommand
  # keyword we've already consumed.
  for word in "$@"; do
    case "$word" in
      -*) continue ;;
      "") continue ;;
      *) printf '%s' "$word"; return 0 ;;
    esac
  done
  return 1
}

# git clone <url> [dir]
if printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*git clone\b'; then
  # shellcheck disable=SC2086
  after_clone="$(printf '%s' "$command_str" | sed -E 's/.*git clone[[:space:]]+//')"
  # shellcheck disable=SC2206
  read -ra words <<< "$after_clone"
  target="$(extract_first_non_flag_arg "${words[@]:-}")"

# npm install / npm i <pkg...>
elif printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*npm (install|i)\b'; then
  after="$(printf '%s' "$command_str" | sed -E 's/.*npm (install|i)[[:space:]]*//')"
  read -ra words <<< "$after"
  target="$(extract_first_non_flag_arg "${words[@]:-}")"

# pnpm add / pnpm install <pkg...>
elif printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*pnpm (add|install)\b'; then
  after="$(printf '%s' "$command_str" | sed -E 's/.*pnpm (add|install)[[:space:]]*//')"
  read -ra words <<< "$after"
  target="$(extract_first_non_flag_arg "${words[@]:-}")"

# yarn add <pkg...>
elif printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*yarn add\b'; then
  after="$(printf '%s' "$command_str" | sed -E 's/.*yarn add[[:space:]]*//')"
  read -ra words <<< "$after"
  target="$(extract_first_non_flag_arg "${words[@]:-}")"

else
  # Not an install/clone command we recognize — no decision, fall through.
  exit 0
fi

if [ -z "$target" ]; then
  # Recognized subcommand but no extractable target (e.g. bare `npm install`
  # reading an existing lockfile). Nothing new is being fetched; skip.
  exit 0
fi

# --- run the scan ---------------------------------------------------------
# Fail open on any problem: missing CLI, non-zero exit, timeout, or bad JSON.
if ! command -v claude-rabbit >/dev/null 2>&1; then
  exit 0
fi

# `timeout` may not exist on all platforms (e.g. some minimal containers);
# fall back to running without it rather than failing the whole hook.
if command -v timeout >/dev/null 2>&1; then
  scan_json="$(timeout 15s claude-rabbit scan "$target" --json 2>/dev/null)"
else
  scan_json="$(claude-rabbit scan "$target" --json 2>/dev/null)"
fi
scan_exit=$?

if [ $scan_exit -ne 0 ] || [ -z "$scan_json" ]; then
  exit 0
fi

score="$(printf '%s' "$scan_json" | jq -r '.score // empty' 2>/dev/null)"
verdict="$(printf '%s' "$scan_json" | jq -r '.verdict // empty' 2>/dev/null)"
report_url="$(printf '%s' "$scan_json" | jq -r '.reportUrl // empty' 2>/dev/null)"

if [ -z "$score" ]; then
  # Malformed/unexpected output shape — do not block on data we can't trust.
  exit 0
fi

# Always "ask", never "deny": Claude Rabbit's own product rule is to never
# assert false certainty in either direction. A low score is surfaced as a
# strong warning that requires human/agent judgment, not an automatic block,
# because a wrong auto-deny is also a false-certainty failure mode.
reason="Claude Rabbit scanned '${target}': score ${score}/100"
if [ -n "$verdict" ]; then
  reason="${reason} (${verdict})"
fi
reason="${reason}. Evidence is not exhaustive — no scan proves absence of malicious behavior, only what was and wasn't observed."
if [ -n "$report_url" ]; then
  reason="${reason} Full report: ${report_url}"
fi

jq -n \
  --arg reason "$reason" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "ask",
      "permissionDecisionReason": $reason
    }
  }'
exit 0
