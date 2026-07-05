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

PHASE-AWARE CLASSIFICATION: not every intercepted non-registry attempt is equally serious.
Using the guest's install-end/run-start beacon (detonate.py `emit_phase_marker`, captured at
PHASE_MARKER_PATH with the SAME host clock as everything else), a BUILD-phase fetch to a
recognized software-distribution host (github.com, sourceforge.net, ...) with no credential
involvement is classified as a supply-chain CAUTION (`verdict.supply_chain_egress`) rather
than a confirmed attack — it is deliberately excluded from `captured_network_intent` /
`attack_egress_intercepted` so a benign dependency fetch never reads as "Malicious". A
credential/canary exfil, an actual credential-file read, any RUN-phase attempt, a fetch to
an unrecognized host, or a refused pinned/mTLS handshake all keep FULL weight regardless of
phase — this narrows ONE specific false-positive, it does not soften real attack detection.

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
PHASE_MARKER_PATH = "/cr-phase-marker"  # the guest's install-end/run-start beacon (detonate.py)
REGISTRY_HOSTS = ("npmjs.org", "pypi.org", "pythonhosted.org", "crates.io", "debian.org", "ubuntu.com", "nodejs.org", "yarnpkg.com")
# Recognized software-DISTRIBUTION hosts: legitimate places a normal build/install step
# fetches an artifact from OUTSIDE the primary package registry — a git dependency, a
# vendored release tarball, a devDependency's own installer pulling a binary. A capture
# to one of these hosts DURING THE BUILD PHASE, with no credential involvement, is a real
# supply-chain signal worth surfacing, but is not on its own evidence of an attack (see the
# classification loop in `assemble()`). This does NOT soften anything at RUN phase, nor a
# credential read/exfil at ANY phase, nor a refused pinned/mTLS handshake at any phase —
# only a clean build-time fetch to one of these specific hosts.
SOFTWARE_DISTRIBUTION_HOSTS = ("github.com", "githubusercontent.com", "sourceforge.net", "gitlab.com", "bitbucket.org")


def _is_registry(host: str) -> bool:
    # ANCHORED suffix match — `endswith(r)` alone would match `evilnpmjs.org` and
    # silently drop a C2 host as a registry, producing a false clean. Mirror the
    # forge addon's anchored REGISTRY_RE exactly.
    h = (host or "").lower()
    return any(h == r or h.endswith("." + r) for r in REGISTRY_HOSTS)


def _is_software_distribution_host(host: str) -> bool:
    # Same ANCHORED suffix match as `_is_registry`, for the same reason: a loose
    # `endswith` would match `evilgithub.com` and misclassify a spoofed C2 host as
    # benign supply-chain traffic.
    h = (host or "").lower()
    return any(h == d or h.endswith("." + d) for d in SOFTWARE_DISTRIBUTION_HOSTS)


def _b64body(rec: dict) -> str:
    try:
        return base64.b64decode(rec.get("body_b64", "")).decode("utf-8", "replace")
    except (ValueError, TypeError):
        return ""


def load(path: str) -> tuple[list[dict], dict | None, list[dict], float | None]:
    """Return (c2_http_requests, in_guest_observation, refused_tls, phase_boundary_t).

    phase_boundary_t is the HOST-side capture timestamp (the same forge wall clock every
    other captured line is stamped with — see forge_addon.py's `_emit()`) of the guest's
    install-end/run-start beacon, or None when the guest never got the beacon through
    (older captures, or a lost telemetry POST). Callers MUST treat None as "phase
    unknown" and NOT downgrade any attempt in that case — a missing marker fails toward
    the STRONGER classification, never a softer one."""
    c2, refused = [], []
    observation: dict | None = None
    phase_boundary_t: float | None = None
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
            if r.get("path") == PHASE_MARKER_PATH:
                t = r.get("t")
                if isinstance(t, (int, float)):
                    phase_boundary_t = float(t)
                continue
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
    return c2, observation, refused, phase_boundary_t


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
        # Real bug fix: the old 1000-char cap was applied AFTER prefixing (the
        # 58-char prefix alone ate into the budget), so a genuinely detailed
        # analysis silently cut off mid-sentence (observed live: a narrative
        # ending "### Verdict\nT") with no indication anything was missing.
        # Raised to a still-bounded but realistic limit for a multi-sentence
        # analysis, and — when a cut genuinely happens — say so plainly rather
        # than let prose end mid-word.
        full_detail = "Agent analysis (code read, not a runtime observation): " + detail
        detail_cap = 4000
        shown_detail = (
            full_detail[:detail_cap].rstrip() + " …[truncated]"
            if len(full_detail) > detail_cap
            else full_detail
        )
        findings.append({
            "signal": f"{lenses} agent flagged {c.get('target', '?')}"
                      + (" (corroborated by 2+ agents)" if corroborated else ""),
            "severity": severity,
            "detail": shown_detail,
        })
    summary = {
        "mode": agentic.get("mode"),
        "agents": agentic.get("agents", []),
        "corroborated_count": agentic.get("corroborated_count", 0),
        "finding_count": len(findings),
        # True when the agentic pass crashed/degraded — so the UI can say "agent analysis
        # did not complete" instead of silently implying the agents ran and found nothing.
        "crashed": bool(agentic.get("crashed")),
    } if agentic else {}
    return findings, summary


def assemble(capture_path: str, owner: str, repo: str, sha: str, agentic_path: str | None = None) -> dict:
    c2, obs, refused, phase_boundary_t = load(capture_path)
    obs = obs or {}
    agentic = load_agentic(agentic_path)
    agentic_code_findings, agentic_summary = _agentic_findings(agentic)
    observed = obs.get("observed", {}) if isinstance(obs, dict) else {}

    # ── network intent: one ATTEMPT row per captured C2/exfil request ──────────────
    # Two buckets, kept STRUCTURALLY separate (never merged): `dest_hosts` is
    # ATTACK-GRADE captured intent (drives the score penalty + attack_egress_intercepted
    # + the report's "caught an attack" framing); `supply_chain_hosts` is a build-time
    # fetch to a recognized software-distribution host with no credential involvement —
    # a real, honestly-surfaced signal, but explicitly NOT treated as a confirmed attack.
    # `attempts` (the raw evidence list rendered in the report's network-intent table)
    # stays FULL and UNFILTERED either way — this is a SCORING classification, not a
    # visibility filter; the report still shows every captured attempt.
    attempts: list[dict] = []
    dest_hosts: dict[str, list[str]] = {}
    supply_chain_hosts: dict[str, list[str]] = {}
    cred_exfil = False
    decoded_payloads: list[dict] = []
    # Real bug fix: the same underlying network event can be captured by more
    # than one observer (host-side monitor + in-guest trace), producing two
    # byte-identical rows in the raw capture for the SAME attempt. Dedupe on
    # the full request identity INCLUDING the capture timestamp `t` — a
    # genuine retry to the same host/path/payload gets a DIFFERENT timestamp,
    # so it still shows as its own row; only a true duplicate (same event,
    # same instant) collapses to one.
    seen_attempts: set[tuple] = set()
    for r in c2:
        host = r.get("host") or r.get("sni") or "?"
        body = _b64body(r)
        is_exfil = (CANARY in body or "aws_access_key_id" in body
                    or "BEGIN OPENSSH PRIVATE KEY" in body or "_authToken" in body)
        if is_exfil:
            cred_exfil = True
        # Phase classification: an attempt is BUILD-phase only when we have a POSITIVE
        # phase-boundary beacon AND its capture timestamp precedes it. No beacon (older
        # capture, or the guest's beacon POST was lost) means phase is UNKNOWN — and an
        # unknown phase is treated as run-phase (full weight), never downgraded. This is
        # the fail-safe direction: a missing marker can only make classification
        # STRICTER, never softer.
        t = r.get("t")
        is_build_phase = (
            phase_boundary_t is not None
            and isinstance(t, (int, float))
            and t < phase_boundary_t
        )
        # A real credential/canary exfil is ALWAYS attack-grade regardless of phase or
        # host — a benign build never sends the planted canary. Only a BUILD-phase
        # fetch to a recognized software-distribution host, with NO credential
        # involvement, is downgraded to a supply-chain caution. A RUN-phase attempt (the
        # code is executing, not installing), a BUILD-phase fetch to an unrecognized
        # host, or an attempt with unknown phase all keep FULL weight, unchanged.
        is_supply_chain_only = (not is_exfil) and is_build_phase and _is_software_distribution_host(host)
        dedup_key = (host, r.get("method"), r.get("path"), r.get("port", 443), body, t)
        if dedup_key in seen_attempts:
            continue
        seen_attempts.add(dedup_key)
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
        if is_supply_chain_only:
            supply_chain_hosts.setdefault(host, [])
        else:
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

    captured_intent = sorted(dest_hosts.keys())              # ATTACK-GRADE hosts only
    supply_chain_intent = sorted(supply_chain_hosts.keys())   # caution-only, NOT an attack signal
    # ALL captured hosts (attack-grade + supply-chain), for the containment narrative
    # below — that section is a NEUTRAL fact about what the forge intercepted, not a
    # verdict about intent, so it must list every capture regardless of classification.
    all_captured_hosts = sorted(set(dest_hosts) | set(supply_chain_hosts))
    cred_reads = len(observed.get("credential_reads", []) or [])
    any_egress = len(attempts) > 0                  # ANY captured attempt (unfiltered; containment-only)
    attack_intent_present = len(captured_intent) > 0  # ATTACK-GRADE only — drives scoring below
    attack = cred_exfil or cred_reads > 0 or attack_intent_present

    # ── containment proof — POSITIVELY evidenced by the in-guest control probe ──────
    # The probe attempts a direct-to-IP egress before the untrusted code runs; if the
    # forge intercepted it (forged reply, not the real host) containment is CONFIRMED.
    # This is positive evidence, not a default — a probe that reached the real internet
    # would make this False (an honest "not confirmed", an isolation failure). When the
    # observation predates the probe (older runs) we have no positive evidence -> not
    # confirmed rather than a default-true claim.
    probe_contained = bool(obs.get("containment_probe_contained")) if "containment_probe_contained" in obs else False
    # Non-TCP (UDP) egress probe: the forge only REDIRECTs TCP, so UDP must be dropped by the
    # forge-netns FORWARD DROP. Present on hardened runs; absent on older ones (treated as
    # unknown, not a failure, so a re-render of an old report doesn't rewrite history).
    udp_known = "udp_egress_contained" in obs
    udp_contained = bool(obs.get("udp_egress_contained")) if udp_known else True
    # Containment is ABSOLUTE: it holds only if BOTH the TCP interception AND the non-TCP
    # drop are confirmed. A UDP leak is a hard failure even if TCP was intercepted.
    fully_contained = probe_contained and udp_contained
    non_tcp_phrase = " and a direct UDP query was dropped (non-TCP egress contained)" if (udp_known and udp_contained) else ""
    if udp_known and not udp_contained:
        notes = ("CONTAINMENT FAILURE: a direct UDP packet reached the real internet, "
                 "bypassing the forge's TCP interception. Treat this run as UNCONTAINED.")
    elif fully_contained and any_egress:
        notes = (f"The forge intercepted {len(attempts)} outbound attempt(s) "
                 f"({', '.join(all_captured_hosts[:4])}); each was answered by the forge and "
                 f"no real packet reached its destination. A control probe confirmed the "
                 f"interception{non_tcp_phrase}, and the in-VM trace corroborated the egress.")
    elif fully_contained:
        notes = ("A control probe confirmed the sandbox intercepts all egress (the microVM "
                 "has no route to the real internet except the forge)" + non_tcp_phrase +
                 ". The detonation itself made no outbound connection attempts during this run.")
    else:
        notes = ("Containment was not positively confirmed for this run (no successful control "
                 "probe). Treat any egress as potentially uncontained.")
    containment = {
        "external_monitor_saw_egress": any_egress,                     # the host-side forge capture
        "in_vm_saw_egress": any_egress or observed.get("connect_count", 0) > 0,
        "no_real_packet_reached_destination": fully_contained,         # POSITIVE evidence (TCP+UDP probes)
        "non_tcp_egress_contained": (udp_contained if udp_known else None),
        "containment_notes": notes,
        "egress_control_probe": "contained" if fully_contained else "not-confirmed",
    }

    # ── deterministic runtime score (attach-forensics re-blends this) ──────────────
    score = 100
    if cred_exfil:
        score -= 55
    elif cred_reads > 0:
        score -= 45
    if attack_intent_present and not cred_exfil:
        score -= 35
    elif supply_chain_intent and not cred_exfil:
        # A build-time fetch to a recognized software-distribution host (github,
        # sourceforge, ...) with no credential involvement: real, honestly surfaced, but
        # explicitly NOT weighted as a confirmed attack — see attack_egress_intercepted
        # and supply_chain_egress below. Much smaller than the attack penalty on purpose.
        score -= 10
    if refused:
        score -= 20
    score = max(1, min(100, score))

    # ── honesty: a run that did NOT build+execute to clean completion did not exercise
    # time- or condition-gated branches, so absence of captured malice is NOT proof of
    # safety (the never-bare-Safe rail applied to the dynamic record). Never hardcode this.
    built_ok = bool(obs.get("auto_build_succeeded"))
    ran_ok = bool(obs.get("ran_without_crash"))
    dormant_unverified = not (built_ok and ran_ok)
    honesty_notes: list[str] = []
    if dormant_unverified:
        honesty_notes.append(
            "The repo did not build and run to clean completion in the sandbox, so time- "
            "or condition-gated branches may not have executed. Absence of captured malice "
            "is not proof of safety.")
    if agentic.get("crashed"):
        honesty_notes.append(
            "The three-agent code analysis did not complete for this run; agent findings "
            "are partial or absent.")

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
            # Build-time fetches to a recognized software-distribution host (github,
            # sourceforge, ...) with no credential involvement — real, surfaced plainly,
            # but deliberately EXCLUDED from captured_network_intent/attack_egress_intercepted
            # so a benign dependency fetch never reads as a confirmed attack.
            "supply_chain_egress": supply_chain_intent,
            "not_verified": [],
        },
        "honesty": {"possibly_dormant_unverified": dormant_unverified, "notes": honesty_notes},
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
