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
#
# Testability: this file can be `source`d (with CLAUDE_RABBIT_SOURCED_FOR_TEST=1
# set beforehand) to load extract_target() and its flag tables into the
# calling shell without running the stdin-reading hook body or calling exit.
# See plugins/claude-rabbit/scripts/tests/test-extract-target.sh.

set -u

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

# extract_target() walks the argument words for a given tool family and
# returns the first true positional argument (the clone URL / package spec),
# correctly skipping both flags AND the value each flag consumes.
#
# A naive "skip anything starting with -" parser is wrong: several very
# common flags (git clone -b <branch>, --depth <n>, -o <name>) take a
# following value that is itself not a flag, so a naive skip treats that
# value as the target. This has been confirmed to misfire on ordinary
# invocations like `git clone -b main <url>` (extracts "main") and
# `git clone --depth 1 <url>` (extracts "1"). The fix: know each flag's
# real arity (verified against `git clone -h` / the installed git's own
# usage text, and against npm/pnpm's documented CLI options) and consume
# the value token along with the flag when the flag takes one.
#
# $1        = tool family: "git-clone" | "npm" | "pnpm" | "yarn"
# $2..$n    = remaining words after the subcommand
#
# Sets the global `target` on success. On any ambiguity — an unrecognized
# flag we cannot confidently classify as value-taking or boolean, or a
# value-taking flag with nothing after it — this function sets
# `parse_failed=1` and does NOT set target, so the caller can fail open
# visibly rather than silently scanning the wrong thing.
#
# NOTE: `target` and `parse_failed` are intentionally globals (not locals)
# so the caller (the hook body, or a test harness) can read the outcome
# after calling this function — matching this script's existing style of
# plain global variables rather than local-scoped helpers.
extract_target() {
  family="$1"
  shift

  target=""
  parse_failed=0

  # Flags (long form, without the leading --/- stripped here — matched
  # with it below) that consume a following word as their value, i.e.
  # `--flag value` uses two argv words. `--flag=value` is always a single
  # self-contained word regardless of arity and is handled generically.
  case "$family" in
    git-clone)
      # From `git clone -h` (git's own usage text) on the installed git:
      # value-taking: -j/--jobs, --template, --reference,
      # --reference-if-able, -o/--origin, -b/--branch, --revision,
      # -u/--upload-pack, --depth, --shallow-since, --shallow-exclude,
      # --separate-git-dir, --ref-format, -c/--config, --server-option,
      # --filter, --bundle-uri.
      # --recurse-submodules / --recursive / --no-recurse-submodules take
      # an OPTIONAL value only via `=<pathspec>` form (never a bare
      # trailing word), so they are boolean for space-separated purposes.
      long_value_flags="template reference reference-if-able origin branch revision upload-pack depth shallow-since shallow-exclude separate-git-dir ref-format config server-option filter bundle-uri"
      short_value_flags="j o b u c"
      ;;
    npm)
      # From `npm install --help` on the installed npm: value-taking
      # long flags relevant here, plus --registry (documented global npm
      # config-override flag accepted by install-family commands).
      long_value_flags="install-strategy omit include before min-release-age cpu os libc workspace registry tag-version-prefix"
      short_value_flags="w"
      ;;
    pnpm)
      # From pnpm's documented `add`/`install` CLI options: value-taking
      # long flags, plus --registry (same npm-config-style override).
      long_value_flags="save-catalog-name allow-build filter cpu os libc registry"
      short_value_flags=""
      ;;
    yarn)
      # yarn add's own value-taking long flags relevant to this hook's
      # existing scope (yarn add <pkg>).
      long_value_flags="cwd registry cache-folder"
      short_value_flags=""
      ;;
  esac

  end_of_options=0
  skip_next=0
  for word in "$@"; do
    if [ "$skip_next" -eq 1 ]; then
      skip_next=0
      continue
    fi

    if [ "$end_of_options" -eq 0 ] && [ "$word" = "--" ]; then
      end_of_options=1
      continue
    fi

    if [ "$end_of_options" -eq 0 ]; then
      case "$word" in
        --*=*)
          # Self-contained long flag=value; consumes no extra word.
          continue
          ;;
        --*)
          flag_name="${word#--}"
          matched=0
          for lf in $long_value_flags; do
            if [ "$flag_name" = "$lf" ]; then
              matched=1
              skip_next=1
              break
            fi
          done
          if [ "$matched" -eq 1 ]; then
            continue
          fi
          # Unknown long flag. We don't have positive confirmation it's
          # boolean, but git/npm/pnpm/yarn boolean long flags vastly
          # outnumber value-taking ones and every value-taking one we
          # could find is enumerated above; still, to stay conservative,
          # we treat it as safely-skippable boolean noise and keep
          # scanning — do NOT flag parse_failed here, since erring toward
          # "kept scanning past an unrecognized boolean flag" is far more
          # common and safe than erring toward "aborted every invocation
          # with an unrecognized flag".
          continue
          ;;
        -*)
          # Short flag(s), possibly bundled (e.g. -qb). Only single-letter
          # short flags are enumerated for value-taking; bundled short
          # flags (e.g. `-ob upstream`) are ambiguous, so if a bundle is
          # longer than one flag character and any letter in it is a
          # known value-taking short flag, we cannot confidently tell
          # which trailing word belongs to it — fail closed on target
          # extraction (visible skip), not silently.
          bare="${word#-}"
          if [ "${#bare}" -eq 1 ]; then
            matched=0
            for sf in $short_value_flags; do
              if [ "$bare" = "$sf" ]; then
                matched=1
                skip_next=1
                break
              fi
            done
            continue
          else
            # Bundled short flags. If none of the letters are value-taking
            # short flags for this family, it's safe boolean noise.
            has_value_letter=0
            i=0
            while [ "$i" -lt "${#bare}" ]; do
              ch="${bare:$i:1}"
              for sf in $short_value_flags; do
                if [ "$ch" = "$sf" ]; then
                  has_value_letter=1
                fi
              done
              i=$((i + 1))
            done
            if [ "$has_value_letter" -eq 1 ]; then
              parse_failed=1
              return 1
            fi
            continue
          fi
          ;;
      esac
    fi

    # First true positional word: this is the target.
    if [ -z "$word" ]; then
      continue
    fi
    target="$word"
    return 0
  done

  return 1
}

# --- main hook body -------------------------------------------------------
# Wrapped in a function so this file can be `source`d for testing
# (CLAUDE_RABBIT_SOURCED_FOR_TEST=1) without running the stdin-reading,
# exit-calling hook logic below — the test harness only needs
# extract_target() and its flag tables, defined above.
run_hook() {
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

  target=""
  parse_failed=0

  # git clone <url> [dir]
  if printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*git clone\b'; then
    # shellcheck disable=SC2086
    after_clone="$(printf '%s' "$command_str" | sed -E 's/.*git clone[[:space:]]+//')"
    # shellcheck disable=SC2206
    read -ra words <<< "$after_clone"
    extract_target "git-clone" "${words[@]:-}" || true

  # npm install / npm i <pkg...>
  elif printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*npm (install|i)\b'; then
    after="$(printf '%s' "$command_str" | sed -E 's/.*npm (install|i)[[:space:]]*//')"
    read -ra words <<< "$after"
    extract_target "npm" "${words[@]:-}" || true

  # pnpm add / pnpm install <pkg...>
  elif printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*pnpm (add|install)\b'; then
    after="$(printf '%s' "$command_str" | sed -E 's/.*pnpm (add|install)[[:space:]]*//')"
    read -ra words <<< "$after"
    extract_target "pnpm" "${words[@]:-}" || true

  # yarn add <pkg...>
  elif printf '%s' "$command_str" | grep -qE '(^|[;&|]|&&)\s*yarn add\b'; then
    after="$(printf '%s' "$command_str" | sed -E 's/.*yarn add[[:space:]]*//')"
    read -ra words <<< "$after"
    extract_target "yarn" "${words[@]:-}" || true

  else
    # Not an install/clone command we recognize — no decision, fall through.
    exit 0
  fi

  if [ "$parse_failed" -eq 1 ]; then
    # We recognized an install/clone command but hit an argument shape we
    # cannot confidently parse (e.g. an ambiguous bundled short flag whose
    # arity we can't resolve). Per this hook's own safety contract, we must
    # NEVER report a scan result for a guessed/wrong target — that would
    # look like a real safety check happened when it did not. Fail open,
    # but visibly: emit an "ask" decision that plainly says no check ran,
    # rather than exiting silently.
    jq -n \
      '{
        "hookSpecificOutput": {
          "hookEventName": "PreToolUse",
          "permissionDecision": "ask",
          "permissionDecisionReason": "Claude Rabbit could not confidently determine the install/clone target from this command (ambiguous flag usage) and is proceeding WITHOUT a safety scan. No target was checked."
        }
      }'
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
}

if [ "${CLAUDE_RABBIT_SOURCED_FOR_TEST:-0}" != "1" ]; then
  run_hook
fi
