#!/usr/bin/env bash
#
# test_run_harness_paths.sh — regression tests for the run-harness.sh security
# fixes that do NOT require root:
#
#   CRIT-1: run-target path validation REFUSES an intermediate-dir symlink
#           escape (e.g. `lib` -> /etc, target `lib/passwd`), absolute paths,
#           parent-dir traversal, the final element being a symlink, and a
#           missing file. A valid repo-relative file PASSES the check.
#   HIGH-1: source_plan refuses a plan file that is not root-owned / is
#           group-or-other-writable. (Ownership cannot be forced without root,
#           so the writable-mode rejection is the part we assert here; the
#           root-owned write path is exercised by `prepare`.)
#
# The harness constants WORK / FLIP / PLAN_DIR are env-overridable purely so this
# test can drive the REAL script logic without root. Production never sets them.
#
# Exit 0 = all pass. Run: bash sandbox/harness/test_run_harness_paths.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$HERE/run-harness.sh"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# Each invocation gets a fresh temp tree so symlinks/files never leak between
# cases. We export CR_WORK_DIR (the repo root the harness validates against) and
# CR_FLIP_SCRIPT (a stub that, if reached, proves we got PAST path validation).
setup_tree() {
  TREE="$(mktemp -d)"
  WORKDIR="$TREE/target"
  mkdir -p "$WORKDIR"
  # A legitimate repo file and a legit subdir file.
  printf 'console.log("hi")\n' > "$WORKDIR/index.js"
  mkdir -p "$WORKDIR/scripts"
  printf 'console.log("hook")\n' > "$WORKDIR/scripts/postinstall.js"
  # A flip stub that writes a sentinel iff path validation passed and we reached
  # containment re-assert. `assert` returns 0 so the script proceeds to sudo
  # (which fails without root, but that is swallowed by the script's `|| true`).
  FLIP_STUB="$TREE/flip.sh"
  cat > "$FLIP_STUB" <<EOF
#!/usr/bin/env bash
echo "REACHED_FLIP \$*" >> "$TREE/flip.log"
exit 0
EOF
  chmod +x "$FLIP_STUB"
}

teardown_tree() { rm -rf "$TREE" 2>/dev/null || true; }

# Run the harness run-target subcommand; capture rc + whether the flip stub was
# reached (proxy for "passed path validation").
run_target() {
  local runtime="$1" path="$2"
  : > "$TREE/flip.log"
  CR_WORK_DIR="$WORKDIR" CR_FLIP_SCRIPT="$FLIP_STUB" CR_TRAP_IP="10.200.0.5" \
    bash "$HARNESS" run-target "$runtime" "$path" >/dev/null 2>&1
  RC=$?
  if [ -s "$TREE/flip.log" ]; then REACHED_FLIP=1; else REACHED_FLIP=0; fi
}

echo "== CRIT-1: run-target path validation =="

# 1. Intermediate-dir symlink escape: lib -> /etc, target lib/passwd. MUST refuse.
setup_tree
if ln -s /etc "$WORKDIR/lib" 2>/dev/null && [ -L "$WORKDIR/lib" ]; then
  run_target node "lib/passwd"
  if [ "$RC" = "3" ] && [ "$REACHED_FLIP" = "0" ]; then
    ok "intermediate-dir symlink escape (lib -> /etc, lib/passwd) is REFUSED (exit 3, no detonation)"
  else
    bad "intermediate-dir symlink escape NOT refused (rc=$RC reached_flip=$REACHED_FLIP)"
  fi
else
  echo "  SKIP: platform cannot create symlinks (intermediate-dir escape case)"
fi
teardown_tree

# 2. Absolute path MUST refuse.
setup_tree
run_target node "/etc/passwd"
if [ "$RC" = "3" ] && [ "$REACHED_FLIP" = "0" ]; then
  ok "absolute path is REFUSED"
else
  bad "absolute path NOT refused (rc=$RC reached_flip=$REACHED_FLIP)"
fi
teardown_tree

# 3. Parent-dir traversal MUST refuse.
setup_tree
run_target node "../../etc/passwd"
if [ "$RC" = "3" ] && [ "$REACHED_FLIP" = "0" ]; then
  ok "parent-dir traversal is REFUSED"
else
  bad "parent-dir traversal NOT refused (rc=$RC reached_flip=$REACHED_FLIP)"
fi
teardown_tree

# 4. Final element is a symlink pointing outside MUST refuse.
setup_tree
if ln -s /etc/passwd "$WORKDIR/sneaky.js" 2>/dev/null && [ -L "$WORKDIR/sneaky.js" ]; then
  run_target node "sneaky.js"
  if [ "$RC" = "3" ] && [ "$REACHED_FLIP" = "0" ]; then
    ok "final-element symlink is REFUSED"
  else
    bad "final-element symlink NOT refused (rc=$RC reached_flip=$REACHED_FLIP)"
  fi
else
  echo "  SKIP: platform cannot create symlinks (final-element symlink case)"
fi
teardown_tree

# 5. Nonexistent file MUST refuse (strict realpath requires existence).
setup_tree
run_target node "does/not/exist.js"
if [ "$RC" = "3" ] && [ "$REACHED_FLIP" = "0" ]; then
  ok "nonexistent target is REFUSED"
else
  bad "nonexistent target NOT refused (rc=$RC reached_flip=$REACHED_FLIP)"
fi
teardown_tree

# 6. A legitimate repo-relative file PASSES path validation (reaches the flip).
setup_tree
run_target node "scripts/postinstall.js"
if [ "$REACHED_FLIP" = "1" ]; then
  ok "legitimate repo-relative file PASSES validation (reaches containment re-assert)"
else
  bad "legitimate file did NOT pass validation (rc=$RC reached_flip=$REACHED_FLIP)"
fi
teardown_tree

echo "== HIGH-1: plan-file ownership / mode gate (source_plan) =="

# build phase sources the plan via source_plan. A group/other-writable plan MUST
# be refused (exit 3) before any deps are touched. We point CR_PLAN_DIR at a temp
# dir, write a plan owned by the current (non-root) user with a writable mode,
# and assert the build phase refuses to source it.
setup_tree
PLAN_DIR_T="$TREE/plan"
mkdir -p "$PLAN_DIR_T"
printf 'PTYPE=node\nINSTALL_CMD=true\nRUN_CMD=true\n' > "$PLAN_DIR_T/plan.env"
chmod 666 "$PLAN_DIR_T/plan.env"   # world-writable: the exact HIGH-1 hazard
CR_PLAN_DIR="$PLAN_DIR_T" CR_WORK_DIR="$WORKDIR" \
  bash "$HARNESS" build >/dev/null 2>&1
RC=$?
# Not root-owned (current user) AND world-writable -> source_plan must exit 3.
if [ "$RC" = "3" ]; then
  ok "world-writable / non-root plan file is REFUSED by source_plan (exit 3)"
else
  bad "writable non-root plan file NOT refused (rc=$RC)"
fi
teardown_tree

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
