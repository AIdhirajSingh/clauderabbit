#!/usr/bin/env python3
"""
test_verdict.py — regression tests for the dynamic-verdict honesty rails.

Run: python3 sandbox/test_verdict.py   (exit 0 = all pass)

These lock the safety-rail behavior that a REAL detonation exposed: a repo that
BUILT but CRASHED on startup (runtime barely exercised) must NOT be presented as
a confident green "Clean run" — it is INCONCLUSIVE, and the verdict must say so.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verdict import build_verdict  # noqa: E402

_fails = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        _fails.append(name)


def report(**agg_and_top):
    """Build a behavior report: aggregate_observations + top-level run facts."""
    top = {
        "auto_build_succeeded": agg_and_top.pop("auto_build_succeeded", True),
        "ran_without_crash": agg_and_top.pop("ran_without_crash", True),
        "project_type": agg_and_top.pop("project_type", "node"),
    }
    top["aggregate_observations"] = agg_and_top
    return top


def no_bare_safe(v):
    blob = json.dumps(v)
    return '"Safe"' not in blob and "'Safe'" not in blob


# 1) Built-but-CRASHED, no malice → INCONCLUSIVE, never green/clean.
v = build_verdict(report(auto_build_succeeded=True, ran_without_crash=False))
check("crashed run: not green", v["score_color"] != "green",
      f'got color={v["score_color"]}')
check("crashed run: label not 'Clean run'", v["one_word"] != "Clean run",
      f'got label={v["one_word"]!r}')
check("crashed run: score below clean band", v["dynamic_score"] < 85,
      f'got score={v["dynamic_score"]}')
# U1: the headline states the crash CONCRETELY (no "did not run to completion /
# largely unverified" hedge) — "exited with an error on startup".
check("crashed run: headline states the crash concretely (no hedge)",
      "exited with an error" in v["headline"].lower()
      or "crash" in v["headline"].lower(),
      f'got headline={v["headline"]!r}')
check("crashed run: headline carries NO 'did not run to completion / unverified' hedge",
      "did not run to completion" not in v["headline"].lower()
      and "largely unverified" not in v["headline"].lower()
      and "could not verify" not in v["headline"].lower(),
      f'got headline={v["headline"]!r}')
check("crashed run: not_verified names the crash",
      any("crash" in n.lower() or "exited with an error" in n.lower()
          or "shortly after starting" in n.lower() for n in v["not_verified"]),
      f'not_verified={v["not_verified"]}')
check("crashed run: no bare Safe", no_bare_safe(v))

# 2) Build FAILED, no malice → inconclusive + the build note (existing rail).
v = build_verdict(report(auto_build_succeeded=False, ran_without_crash=False))
check("build failed: not green", v["score_color"] != "green",
      f'got color={v["score_color"]}')
check("build failed: not_verified names the build failure",
      any("did not build" in n.lower() or "build/install" in n.lower()
          for n in v["not_verified"]),
      f'not_verified={v["not_verified"]}')

# 3) Built AND ran clean, no malice → the genuine green "Clean run" (unchanged).
v = build_verdict(report(auto_build_succeeded=True, ran_without_crash=True))
check("clean exercised run: green", v["score_color"] == "green",
      f'got color={v["score_color"]}')
check("clean exercised run: 'Clean run' label", v["one_word"] == "Clean run",
      f'got label={v["one_word"]!r}')
check("clean exercised run: still states what was not verified",
      len(v["not_verified"]) >= 1)
check("clean exercised run: no bare Safe", no_bare_safe(v))

# 4) Malicious: high-value cred read + outbound → Dangerous/red (unchanged).
v = build_verdict(report(
    auto_build_succeeded=True, ran_without_crash=True,
    high_value_cred_read_count=3, high_value_cred_read_succeeded=3,
    outbound_internet_attempted=True, sinkholed_attempt_count=1,
    run_sinkholed_attempt_count=1,
))
check("malicious run: red", v["score_color"] == "red", f'got color={v["score_color"]}')
check("malicious run: Dangerous", v["one_word"] == "Dangerous", f'got label={v["one_word"]!r}')
check("malicious run: has critical findings",
      any(f["severity"] == "critical" for f in v["code_behavior_findings"]))
check("malicious run: no bare Safe", no_bare_safe(v))

# 5) Malice during build/install, THEN crashed on startup → findings stand, but
#    the headline must not imply a full run (MEDIUM-1). Egress was BLOCKED (not
#    sinkhole-captured), so this lands in the crit headline branch the fix touches.
v = build_verdict(report(
    auto_build_succeeded=True, ran_without_crash=False,
    high_value_cred_read_count=2, high_value_cred_read_succeeded=2,
    outbound_internet_attempted=True, internet_attempt_count=2, network_blocked_count=2,
))
check("build-phase malice + crash: still flags findings",
      len(v["code_behavior_findings"]) >= 1)
check("build-phase malice + crash: headline does not claim a full run",
      "when we ran this code" not in v["headline"].lower(),
      f'got headline={v["headline"]!r}')
check("build-phase malice + crash: headline says build/install",
      "build/install" in v["headline"].lower() or "before the project finished" in v["headline"].lower(),
      f'got headline={v["headline"]!r}')
check("build-phase malice + crash: no bare Safe", no_bare_safe(v))

print()
if _fails:
    print(f"FAILED: {len(_fails)} check(s): {_fails}")
    sys.exit(1)
print("ALL VERDICT HONESTY CHECKS PASSED")
