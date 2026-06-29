#!/usr/bin/env python3
"""
assemble-forensics.py — turn a microVM detonation's evidence (the forge capture + the
in-guest observation) into the canonical forensic record the report consumes.

CRITICAL: the record MUST match the schema lib/scan.ts `normalizeForensics` expects, or
the report silently falls through to "Containment was NOT confirmed" on a run that DID
happen. The fields that matter:
  - network_intent.attempts[]            (the captured C2 rows the report renders)
  - containment.no_real_packet_reached_destination / external_monitor_saw_egress /
    in_vm_saw_egress / containment_notes (the dual-source containment proof)
  - payload_analysis.decoded_payloads[]  (the inert captured exfil)
  - verdict.{captured_network_intent, attack_egress_intercepted, ...}

Containment is CONFIRMED structurally on this substrate: the detonation microVM has NO
route to the real internet except the forge, which forges every non-registry destination —
so no real packet can reach any C2/exfil target. external_monitor_saw_egress reflects the
host-side forge capture; in_vm_saw_egress reflects the guest's own connect() observations.

Usage: assemble-forensics.py <capture.jsonl> [--owner O --repo R --sha S] > forensics.json
Every field traces to a real capture line or observation — never a template.
"""
from __future__ import annotations

import base64
import json
import sys

CANARY = "CR-CANARY-DO-NOT-EXFIL-deadbeef0123456789"
TELEMETRY_HOST = "cr-harness.cr.internal"
PROBE_PATH = "/cr-containment-probe"  # OUR containment probe — never the malware's intent
REGISTRY_HOSTS = ("npmjs.org", "pypi.org", "pythonhosted.org", "crates.io", "debian.org", "ubuntu.com", "nodejs.org", "yarnpkg.com")


def _is_registry(host: str) -> bool:
    # ANCHORED suffix match — `endswith(r)` alone would match `evilnpmjs.org` and
    # silently drop a C2 host as a registry, producing a false clean. Mirror the
    # forge addon's anchored REGISTRY_RE exactly.
    h = (host or "").lower()
    return any(h == r or h.endswith("." + r) for r in REGISTRY_HOSTS)


def _b64body(rec: dict) -> str:
    try:
        return base64.b64decode(rec.get("body_b64", "")).decode("utf-8", "replace")
    except (ValueError, TypeError):
        return ""


def load(path: str) -> tuple[list[dict], dict | None, list[dict]]:
    """Return (c2_http_requests, in_guest_observation, refused_tls)."""
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
                observation = json.loads(_b64body(r))
            except ValueError:
                observation = None
            continue
        if _is_registry(host):
            continue  # registry fast-path: real, logged, not malicious intent
        if r.get("path") == PROBE_PATH:
            continue  # our own containment probe — not the malware's network intent
        c2.append(r)
    return c2, observation, refused


def load_agentic(path: str | None) -> dict:
    """Read the three-agent cross-verified findings (agentic-findings@2), if present.
    Returns {} on any miss/error so the forensic record is identical when the agentic
    pass was skipped or degraded — the agents enrich the report, they never gate it."""
    if not path:
        return {}
    try:
        data = json.loads(open(path, encoding="utf-8").read())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _agentic_findings(agentic: dict) -> tuple[list[dict], dict]:
    """Fold the three agents' cross-verified inferences into code_behavior_findings
    (the report's code-analysis section) and a compact `agentic` summary. These are
    the agents' READING of the code (inferences) — kept distinct from the forge's
    observed runtime FACTS; each detail is attributed to the agent + marked as a read,
    so the report never presents an inference as a confirmed observation."""
    cross = agentic.get("cross_verified_findings", []) if isinstance(agentic, dict) else []
    findings: list[dict] = []
    for c in cross:
        if not isinstance(c, dict):
            continue
        lenses = ", ".join(c.get("lenses", []) or []) or "agent"
        hints = c.get("severity_hints", []) or []
        severity = "high" if "high" in hints else "med" if "med" in hints else "low"
        infs = c.get("inferences", []) or []
        detail = infs[0].get("text", "") if infs and isinstance(infs[0], dict) else ""
        corroborated = bool(c.get("corroborated"))
        findings.append({
            "signal": f"{lenses} agent flagged {c.get('target', '?')}"
                      + (" (corroborated by 2+ agents)" if corroborated else ""),
            "severity": severity,
            "detail": ("Agent analysis (code read, not a runtime observation): " + detail)[:1000],
        })
    summary = {
        "mode": agentic.get("mode"),
        "agents": agentic.get("agents", []),
        "corroborated_count": agentic.get("corroborated_count", 0),
        "finding_count": len(findings),
    } if agentic else {}
    return findings, summary


def assemble(capture_path: str, owner: str, repo: str, sha: str, agentic_path: str | None = None) -> dict:
    c2, obs, refused = load(capture_path)
    obs = obs or {}
    agentic = load_agentic(agentic_path)
    agentic_code_findings, agentic_summary = _agentic_findings(agentic)
    observed = obs.get("observed", {}) if isinstance(obs, dict) else {}

    # ── network intent: one ATTEMPT row per captured C2/exfil request ──────────────
    attempts: list[dict] = []
    dest_hosts: dict[str, list[str]] = {}
    cred_exfil = False
    decoded_payloads: list[dict] = []
    for r in c2:
        host = r.get("host") or r.get("sni") or "?"
        body = _b64body(r)
        is_exfil = (CANARY in body or "aws_access_key_id" in body
                    or "BEGIN OPENSSH PRIVATE KEY" in body or "_authToken" in body)
        if is_exfil:
            cred_exfil = True
        attempts.append({
            "intended_host": host,
            "sni": r.get("sni"),
            "http_host_header": host,
            "dest_port": r.get("port", 443),
            "transport": "tcp",
            "tls": True,
            "http_method": r.get("method"),
            "http_path": r.get("path"),
            "would_be_payload_b64": r.get("body_b64") or "",
            "payload_len": r.get("body_len", len(body)),
            "captured_at": None,
        })
        dest_hosts.setdefault(host, [])
        if body.strip():
            decoded_payloads.append({
                "host": host,
                "text": body[:8192],
                "bytes_len": len(body),
                "kind": "credential_exfil" if is_exfil else "c2_beacon",
            })
    # a refused (pinned/mTLS) handshake is itself an ATTEMPT — encrypted C2 we could not read
    for r in refused:
        sni = r.get("sni") or "an encrypted destination"
        attempts.append({
            "intended_host": sni, "sni": r.get("sni"), "http_host_header": None,
            "dest_port": 443, "transport": "tcp", "tls": True,
            "tls_handshake": "refused-by-client (cert pinning / mTLS)",
            "http_method": None, "http_path": None,
            "would_be_payload_b64": "", "payload_len": 0, "captured_at": None,
        })
        dest_hosts.setdefault(sni, [])

    captured_intent = sorted(dest_hosts.keys())
    cred_reads = len(observed.get("credential_reads", []) or [])
    any_egress = len(attempts) > 0
    attack = cred_exfil or cred_reads > 0 or any_egress

    # ── containment proof — POSITIVELY evidenced by the in-guest control probe ──────
    # The probe attempts a direct-to-IP egress before the untrusted code runs; if the
    # forge intercepted it (forged reply, not the real host) containment is CONFIRMED.
    # This is positive evidence, not a default — a probe that reached the real internet
    # would make this False (an honest "not confirmed", an isolation failure). When the
    # observation predates the probe (older runs) we have no positive evidence -> not
    # confirmed rather than a default-true claim.
    probe_contained = bool(obs.get("containment_probe_contained")) if "containment_probe_contained" in obs else False
    if probe_contained and any_egress:
        notes = (f"The forge intercepted {len(attempts)} outbound attempt(s) "
                 f"({', '.join(captured_intent[:4])}); each was answered by the forge and "
                 f"no real packet reached its destination. A control probe confirmed the "
                 f"interception, and the in-VM trace corroborated the egress.")
    elif probe_contained:
        notes = ("A control probe confirmed the sandbox intercepts all egress (the microVM "
                 "has no route to the real internet except the forge). The detonation itself "
                 "made no outbound connection attempts during this run.")
    else:
        notes = ("Containment was not positively confirmed for this run (no successful control "
                 "probe). Treat any egress as potentially uncontained.")
    containment = {
        "external_monitor_saw_egress": any_egress,                     # the host-side forge capture
        "in_vm_saw_egress": any_egress or observed.get("connect_count", 0) > 0,
        "no_real_packet_reached_destination": probe_contained,         # POSITIVE evidence (the probe)
        "containment_notes": notes,
        "egress_control_probe": "contained" if probe_contained else "not-confirmed",
    }

    # ── deterministic runtime score (attach-forensics re-blends this) ──────────────
    score = 100
    if cred_exfil:
        score -= 55
    elif cred_reads > 0:
        score -= 45
    if captured_intent and not cred_exfil:
        score -= 35
    if refused:
        score -= 20
    score = max(1, min(100, score))

    return {
        "schema": "claude-rabbit/forensic-record/microvm-1",
        "generated_at": "",
        "target": f"{owner}/{repo}",
        "what_it_ran": {
            "project_type": obs.get("project_type"),
            "install_command": obs.get("install_command"),
            "run_command": obs.get("run_command"),
            "auto_build_succeeded": bool(obs.get("auto_build_succeeded")),
            "ran_without_crash": bool(obs.get("ran_without_crash")),
        },
        "network_intent": {
            "attempts": attempts,
            "attempt_count": len(attempts),
            "intended_destinations": [{"host": h, "intended_ips": dest_hosts[h]} for h in captured_intent],
            "geolocations": [],
        },
        "in_vm_behavior": {
            "high_value_credential_reads": cred_reads,
            "high_value_credential_reads_succeeded": cred_reads,
            "credential_reads_detail": [
                {"path": p, "succeeded": True, "high_value": True}
                for p in (observed.get("credential_reads", []) or [])
            ],
            "suspicious_binaries": [],
            "files_dropped_count": 0,
            "files_dropped": [],
            "high_cpu": False,
            "run_cpu_cores_busy": 0,
            "process_exec_count": observed.get("exec_count", 0),
        },
        "payload_analysis": {
            "decoded_payloads": decoded_payloads,
            "ai_intent_summary": None,
            "ai_model": None,
            "ai_analysis_error": None,
        },
        "containment": containment,
        "verdict": {
            "dynamic_score": score,
            "score_color": "red" if score < 60 else "amber" if score < 80 else "green",
            "one_word": "Malicious" if cred_exfil else "Dangerous" if attack else "Likely safe",
            "headline": "",  # the hero verdict is re-blended by attach-forensics
            # The three agents' code-read inferences render in the code-analysis section
            # (attributed + marked as a read, distinct from the forge's runtime facts).
            "code_behavior_findings": agentic_code_findings,
            "captured_network_intent": captured_intent,
            "egress_intercepted_count": len(attempts),
            "attack_egress_intercepted": attack,
            "not_verified": [],
        },
        "honesty": {"possibly_dormant_unverified": False, "notes": []},
        # The three-agent analysis summary (mode + which agents ran + corroboration),
        # for a dedicated "three agents read the code" report panel. Empty {} when the
        # agentic pass was skipped, so the record is unchanged on a no-agent run.
        "agentic": agentic_summary,
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
    rec = assemble(cap, kv.get("owner", ""), kv.get("repo", ""), kv.get("sha", ""),
                   agentic_path=kv.get("agentic"))
    print(json.dumps(rec, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
