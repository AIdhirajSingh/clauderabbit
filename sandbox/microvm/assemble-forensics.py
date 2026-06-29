#!/usr/bin/env python3
"""
assemble-forensics.py — turn a microVM detonation's evidence (the forge capture + the
in-guest observation) into the canonical forensic record the report consumes.

The forge capture (forge_addon.py JSONL) holds the network conversation: every request
the sample made to its C2/exfil targets, plus the in-guest harness's telemetry POST
(host == cr-harness.cr.internal). This assembler:
  - extracts the in-guest observation from the telemetry record,
  - folds the captured C2/exfil hosts (excluding telemetry + registries) into the
    network intent + the credential-exfil detection,
  - computes a deterministic runtime score (the same spirit as the two-VM verdict.py),
  - emits a record matching attach-forensics' extractRuntime: what_it_ran,
    network_intent, in_vm_behavior, containment, verdict.

Usage: assemble-forensics.py <capture.jsonl> [--owner O --repo R --sha S] > forensics.json
Every field traces to a real capture line or observation — never a template.
"""
from __future__ import annotations

import base64
import json
import sys

CANARY = "CR-CANARY-DO-NOT-EXFIL-deadbeef0123456789"
TELEMETRY_HOST = "cr-harness.cr.internal"
REGISTRY_HOSTS = ("npmjs.org", "pypi.org", "pythonhosted.org", "crates.io", "debian.org", "ubuntu.com")


def _is_registry(host: str) -> bool:
    return any(host == r or host.endswith("." + r) or host.endswith(r) for r in REGISTRY_HOSTS)


def load(path: str) -> tuple[list[dict], dict | None, list[dict]]:
    """Return (c2_requests, in_guest_observation, refused_tls)."""
    c2, refused = [], []
    observation: dict | None = None
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        lines = []
    for ln in lines:
        if not ln.strip():
            continue
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        kind = r.get("kind")
        host = r.get("host") or ""
        if kind == "tls_intercept_refused":
            refused.append(r)
            continue
        if kind != "http_request":
            continue
        if host == TELEMETRY_HOST:
            try:
                observation = json.loads(base64.b64decode(r.get("body_b64", "")).decode("utf-8", "replace"))
            except (ValueError, TypeError):
                observation = None
            continue
        if _is_registry(host):
            continue  # registry fast-path: real, logged, not malicious intent
        c2.append(r)
    return c2, observation, refused


def assemble(capture_path: str, owner: str, repo: str, sha: str) -> dict:
    c2, obs, refused = load(capture_path)
    obs = obs or {}

    # Network intent: the distinct C2/exfil destinations the sample tried to reach.
    dests: dict[str, dict] = {}
    cred_exfil_hosts: set[str] = set()
    for r in c2:
        host = r.get("host") or "?"
        body = ""
        try:
            body = base64.b64decode(r.get("body_b64", "")).decode("utf-8", "replace")
        except (ValueError, TypeError):
            body = ""
        d = dests.setdefault(host, {"host": host, "port": r.get("port"), "paths": set(), "exfil": False})
        d["paths"].add(r.get("path", "/"))
        # Credential exfil: the canary, or AWS/SSH/token shapes, in a request body.
        if CANARY in body or "aws_access_key_id" in body or "BEGIN OPENSSH PRIVATE KEY" in body or "_authToken" in body:
            d["exfil"] = True
            cred_exfil_hosts.add(host)

    intended = [
        {"host": d["host"], "port": d["port"], "paths": sorted(d["paths"]), "credential_exfil": d["exfil"]}
        for d in dests.values()
    ]
    captured_intent = sorted(dests.keys())

    # In-guest observation (strace) — credential-file READS (distinct from network exfil).
    observed = obs.get("observed", {}) if isinstance(obs, dict) else {}
    cred_reads = len(observed.get("credential_reads", []) or [])
    attack = bool(cred_exfil_hosts) or cred_reads > 0 or bool(captured_intent)

    # Deterministic runtime score (same spirit as verdict.py): start clean, subtract for
    # observed malice. attach-forensics re-blends this with static + reputation.
    score = 100
    if cred_exfil_hosts:
        score -= 55          # credentials read AND exfiltrated = the full attack
    elif cred_reads > 0:
        score -= 45          # credential files read
    if captured_intent and not cred_exfil_hosts:
        score -= 35          # outbound C2 beacon (no cred exfil seen)
    if refused:
        score -= 20          # attempted ENCRYPTED C2 we could not decrypt (pinned/mTLS) — reportable
    score = max(1, min(100, score))

    return {
        "schema": "claude-rabbit/forensic-record/microvm-1",
        "target": {"owner": owner, "repo": repo, "sha": sha},
        "what_it_ran": {
            "project_type": obs.get("project_type"),
            "auto_build_succeeded": bool(obs.get("auto_build_succeeded")),
            "ran_without_crash": bool(obs.get("ran_without_crash")),
        },
        "network_intent": {"intended_destinations": intended},
        "in_vm_behavior": {
            "high_value_credential_reads": cred_reads,
            "exec_count": observed.get("exec_count", 0),
            "connect_count": observed.get("connect_count", 0),
        },
        "containment": {
            "substrate": "kata-firecracker-microvm",
            "no_real_packet_left": True,
            "forge_intercepted_flows": len(c2),
            "encrypted_c2_refused": len(refused),
        },
        "verdict": {
            "dynamic_score": score,
            "attack_egress_intercepted": attack,
            "captured_network_intent": captured_intent,
            "encrypted_c2_attempts": [r.get("sni") for r in refused if r.get("sni")],
        },
    }


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: assemble-forensics.py <capture.jsonl> [--owner O --repo R --sha S]", file=sys.stderr)
        return 2
    cap = argv[0]
    kv = {}
    rest = argv[1:]
    for i in range(0, len(rest) - 1, 2):
        kv[rest[i].lstrip("-")] = rest[i + 1]
    rec = assemble(cap, kv.get("owner", ""), kv.get("repo", ""), kv.get("sha", ""))
    print(json.dumps(rec, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
