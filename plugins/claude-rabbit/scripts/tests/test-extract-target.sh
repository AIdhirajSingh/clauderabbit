#!/usr/bin/env bash
# Tests for extract_target() in ../pre-install-scan.sh.
#
# These reproduce the exact adversarial-review repro cases confirmed against
# the pre-fix parser (which only skipped tokens starting with "-" and had no
# concept of flag arity):
#
#   git clone -b main <url>                        -> used to extract "main"
#   git clone --depth 1 <url>                       -> used to extract "1"
#   git clone -o upstream <url>                     -> used to extract "upstream"
#   git clone --branch main <url> myrepo            -> used to extract "main"
#
# Run directly: bash plugins/claude-rabbit/scripts/tests/test-extract-target.sh

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook_script="$script_dir/../pre-install-scan.sh"

# Source the hook script in test mode: this defines extract_target() and its
# flag tables without running the stdin-reading `run_hook` body.
CLAUDE_RABBIT_SOURCED_FOR_TEST=1
export CLAUDE_RABBIT_SOURCED_FOR_TEST
# shellcheck disable=SC1090
source "$hook_script"

pass_count=0
fail_count=0

# assert_target FAMILY EXPECTED_TARGET WORD...
# Calls extract_target with FAMILY and the given words, and checks that the
# resulting $target equals EXPECTED_TARGET and parse_failed is 0.
assert_target() {
  family="$1"
  expected="$2"
  shift 2

  extract_target "$family" "$@"
  status=$?

  if [ "$parse_failed" -eq 1 ]; then
    echo "FAIL: [$family] args=($*) -> parse_failed=1, expected target='$expected'"
    fail_count=$((fail_count + 1))
    return
  fi

  if [ "$status" -ne 0 ]; then
    echo "FAIL: [$family] args=($*) -> extract_target returned no target, expected '$expected'"
    fail_count=$((fail_count + 1))
    return
  fi

  if [ "$target" = "$expected" ]; then
    echo "PASS: [$family] args=($*) -> target='$target'"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: [$family] args=($*) -> target='$target', expected '$expected'"
    fail_count=$((fail_count + 1))
  fi
}

# assert_parse_failed FAMILY WORD...
# Checks that extract_target sets parse_failed=1 (ambiguous/unresolvable
# argument shape) rather than guessing a target.
assert_parse_failed() {
  family="$1"
  shift

  extract_target "$family" "$@"

  if [ "$parse_failed" -eq 1 ]; then
    echo "PASS: [$family] args=($*) -> correctly flagged parse_failed"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL: [$family] args=($*) -> expected parse_failed=1, got target='$target' parse_failed=$parse_failed"
    fail_count=$((fail_count + 1))
  fi
}

echo "=== Bug 1 repro cases (must now extract the URL, not the flag value) ==="

# git clone -b main <url>  ->  must scan the URL, not "main"
assert_target "git-clone" "https://github.com/foo/bar.git" -b main https://github.com/foo/bar.git

# git clone --depth 1 <url>  ->  must scan the URL, not "1"
assert_target "git-clone" "https://github.com/foo/bar.git" --depth 1 https://github.com/foo/bar.git

# git clone -o upstream <url>  ->  must scan the URL, not "upstream"
assert_target "git-clone" "https://github.com/foo/bar.git" -o upstream https://github.com/foo/bar.git

# git clone --branch main <url> myrepo  ->  must scan the URL, not "main"
assert_target "git-clone" "https://github.com/foo/bar.git" --branch main https://github.com/foo/bar.git myrepo

echo ""
echo "=== Additional git-clone flag-arity coverage ==="

# Multiple value-taking flags stacked before the URL.
assert_target "git-clone" "https://github.com/foo/bar.git" -b main -o upstream --depth 1 https://github.com/foo/bar.git

# --flag=value form (self-contained, single word) must not eat the next word.
assert_target "git-clone" "https://github.com/foo/bar.git" --branch=main https://github.com/foo/bar.git

# Boolean long flags (no value) must not eat the URL.
assert_target "git-clone" "https://github.com/foo/bar.git" --bare --mirror https://github.com/foo/bar.git

# Boolean short flag must not eat the URL.
assert_target "git-clone" "https://github.com/foo/bar.git" -q https://github.com/foo/bar.git

# -- end-of-options marker: everything after is positional.
assert_target "git-clone" "--looks-like-a-flag" -b main -- --looks-like-a-flag

# Unresolvable bundled short flag containing a value-taking letter (-ob) must
# fail closed rather than guess.
assert_parse_failed "git-clone" -ob upstream https://github.com/foo/bar.git

echo ""
echo "=== npm / pnpm / yarn flag-arity coverage ==="

# npm install --registry <url> <pkg>  ->  must scan the package, not the registry URL.
assert_target "npm" "left-pad" --registry https://registry.example.com left-pad

# npm install -w <workspace> <pkg>
assert_target "npm" "left-pad" -w packages/foo left-pad

# npm install --save-exact (boolean) <pkg>
assert_target "npm" "left-pad" --save-exact left-pad

# pnpm add --filter <pkg-selector> <pkg>
assert_target "pnpm" "left-pad" --filter my-app left-pad

# pnpm add -D (boolean) <pkg>
assert_target "pnpm" "left-pad" -D left-pad

# yarn add --registry <url> <pkg>
assert_target "yarn" "left-pad" --registry https://registry.example.com left-pad

echo ""
echo "=== Summary ==="
echo "Passed: $pass_count"
echo "Failed: $fail_count"

if [ "$fail_count" -ne 0 ]; then
  exit 1
fi
exit 0
