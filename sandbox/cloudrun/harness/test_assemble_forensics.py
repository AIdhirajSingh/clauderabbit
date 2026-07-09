#!/usr/bin/env python3
"""
test_assemble_forensics.py — regression tests for the PHASE-AWARE egress classification
in the Cloud Run harness's assemble-forensics.py, with special focus on the
`build_phase_unrecognized_egress` field.

WHY THIS FIELD EXISTS: the edge function (attach-forensics extractRuntime) may live-verify
an attack-grade captured host and downgrade it to a supply-chain caution — the static
SOFTWARE_DISTRIBUTION_HOSTS list cannot know every legitimate mirror/CDN. But that rescue
must apply ONLY to a BUILD-phase fetch to an unrecognized host (a dependency-fetch context),
NEVER to a RUN-phase attempt (the untrusted code executing and reaching out). A live C2
trivially answers HTTPS, so downgrading run-phase egress on liveness alone is a moat bypass.
This file locks in that only build-phase-unrecognized hosts populate the eligibility field,
and that a run-phase host — even to the same name — never does.

END-TO-END: writes a synthetic capture.jsonl (forge_addon.py's schema, incl. the guest's
phase-marker beacon) and runs assemble-forensics.py as a real subprocess.

Run: python3 sandbox/cloudrun/harness/test_assemble_forensics.py   (exit 0 = all pass)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ASSEMBLE = os.path.join(HERE, "assemble-forensics.py")
TELEMETRY_HOST = "cr-harness.cr.internal"
PHASE_MARKER_PATH = "/cr-phase-marker"

_fails: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        _fails.append(name)
        print(f"  FAIL  {name}  {detail}")


def run(records: list[dict]) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
        path = f.name
    try:
        out = subprocess.check_output(
            [sys.executable, ASSEMBLE, path, "--owner", "o", "--repo", "r", "--sha", "s"],
            stderr=subprocess.STDOUT,
        )
        return json.loads(out)
    finally:
        os.unlink(path)


def marker(t: float) -> dict:
    return {"kind": "http_request", "host": TELEMETRY_HOST, "path": PHASE_MARKER_PATH, "t": t}


def http(host: str, t: float, path: str = "/x", body_b64: str = "") -> dict:
    return {"kind": "http_request", "host": host, "method": "GET", "path": path, "t": t, "body_b64": body_b64}


# 1. build-phase unrecognized host → eligible; run-phase host → NOT eligible.
rec = run([
    marker(100.0),
    http("mirror.unknown-cdn.example", 50.0),   # BUILD phase (before marker), unrecognized
    http("live-c2.attacker.example", 150.0),     # RUN phase (after marker)
])
v = rec["verdict"]
check(
    "build-phase unrecognized host is eligible for the liveness downgrade",
    v["build_phase_unrecognized_egress"] == ["mirror.unknown-cdn.example"],
    f"got {v['build_phase_unrecognized_egress']}",
)
check(
    "run-phase C2 is captured but NEVER eligible for the downgrade (moat-bypass guard)",
    "live-c2.attacker.example" in v["captured_network_intent"]
    and "live-c2.attacker.example" not in v["build_phase_unrecognized_egress"],
    f"captured={v['captured_network_intent']} eligible={v['build_phase_unrecognized_egress']}",
)
check("attack egress intercepted when a run-phase host is present", v["attack_egress_intercepted"] is True)

# 2. build-phase RECOGNIZED distribution host → supply-chain, NOT eligibility, NOT attack.
rec = run([marker(100.0), http("github.com", 50.0)])
v = rec["verdict"]
check("build-phase recognized host is supply-chain, not attack", v["supply_chain_egress"] == ["github.com"])
check("recognized host is not in the unrecognized-eligibility set", v["build_phase_unrecognized_egress"] == [])
check("recognized build-phase fetch alone is not attack_egress_intercepted", v["attack_egress_intercepted"] is False)

# 3. NO phase marker → phase unknown → fail STRICT: nothing is build-phase, so nothing is eligible.
rec = run([http("mirror.unknown-cdn.example", 50.0)])
v = rec["verdict"]
check(
    "with no phase marker, an unrecognized host stays attack-grade and NOT eligible (fail-safe)",
    "mirror.unknown-cdn.example" in v["captured_network_intent"]
    and v["build_phase_unrecognized_egress"] == [],
    f"captured={v['captured_network_intent']} eligible={v['build_phase_unrecognized_egress']}",
)

if _fails:
    print(f"\n{len(_fails)} test(s) FAILED")
    sys.exit(1)
print("\nAll phase-classification tests passed")
sys.exit(0)
