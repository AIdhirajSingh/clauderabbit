#!/usr/bin/env python3
"""
forensics.py — assemble the structured forensic record for one sinkhole run.

It fuses three independent evidence sources into one honest forensic JSON:
  1. the in-VM behavior report (observe.py: strace of the detonation VM —
     credential reads, processes, dropped files, CPU, connect() attempts),
  2. the trap capture (sinkd.py JSONL on the trap host — the EXTERNAL,
     tamper-proof network record: domain/SNI/Host, path, method, port, the
     would-be payload captured INERT, timing),
  3. the off-VM analysis (analyze-payload.py — intended IP resolution for
     INTELLIGENCE only, GeoIP, payload decode, and the Gemini intent summary).

It then attaches the dynamic verdict (computed by verdict.py over the same
behavior report + trap capture) so the forensic record is self-contained.

Honesty rails preserved:
  - Detected attack => verdict is maximally dangerous (verdict.py handles this).
  - Code that stayed dormant (suspecting a trap, or condition-gated) is reported
    as UNVERIFIED, never clean and never "Safe".
  - Reputation is NOT in here — this is code/behavior + network intent only.

Usage:
  forensics.py --behavior behavior.json --capture capture.jsonl \
               --analysis analysis.json --verdict verdict.json \
               --target "owner/repo" --out forensics.json
"""
import argparse
import json
import sys
from datetime import datetime, timezone


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_json(path, default):
    if not path:
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_jsonl(path):
    entries = []
    if not path:
        return entries
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return entries


def summarize_capture(capture):
    """Turn raw trap capture lines into the network-intent evidence list. Each
    connection the code tried becomes one intent record: what it MEANT to reach
    (domain), the inert would-be payload, port, proto, timing."""
    intents = []
    for c in capture:
        if c.get("event") == "sinkd_start":
            continue
        host = c.get("intended_host") or c.get("sni") or c.get("http_host_header")
        if not host and not c.get("dest_port"):
            continue
        intents.append({
            "intended_host": host,
            "sni": c.get("sni"),
            "http_host_header": c.get("http_host_header"),
            "dest_port": c.get("dest_port"),
            "transport": c.get("transport"),
            "tls": c.get("tls", False),
            "tls_handshake": c.get("tls_handshake"),
            "http_method": c.get("http_method"),
            "http_path": c.get("http_path"),
            "http_headers": c.get("http_headers"),
            # The would-be exfil payload, captured INERT (base64), never delivered.
            "would_be_payload_b64": c.get("payload_b64"),
            "payload_len": c.get("raw_len"),
            "captured_at": c.get("captured_at"),
        })
    return intents


def build_forensics(args):
    behavior = load_json(args.behavior, {})
    capture = load_jsonl(args.capture)
    analysis = load_json(args.analysis, {})
    verdict = load_json(args.verdict, {})

    agg = behavior.get("aggregate_observations", {}) if isinstance(behavior, dict) else {}
    intents = summarize_capture(capture)

    # The external monitor independently saw network egress attempts if the trap
    # captured ANY connection — this is the tamper-proof corroboration of (or
    # contradiction to) the in-VM strace.
    external_monitor_saw_egress = len(intents) > 0
    in_vm_saw_egress = bool(
        agg.get("sinkholed_attempt_count", 0) or agg.get("outbound_internet_attempted")
    )

    # Honesty: distinguish "no egress observed" from "verified clean". If the
    # code built and ran to completion AND nothing tried to phone out AND no
    # credential theft, that is "no malicious behavior observed" — explicitly
    # NOT a clean bill of health.
    ran = bool(behavior.get("ran_without_crash"))
    built = bool(behavior.get("auto_build_succeeded"))
    attempted_anything = bool(
        in_vm_saw_egress or external_monitor_saw_egress
        or agg.get("high_value_cred_read_count", 0)
        or agg.get("high_cpu")
    )
    # Dormant-suspecting-a-trap: ran to completion but did literally nothing
    # observable. Reported as UNVERIFIED, never clean.
    possibly_dormant = ran and not attempted_anything

    forensic = {
        "schema": "claude-rabbit/forensic-record@1",
        "generated_at": now_iso(),
        "target": args.target,
        "what_it_ran": {
            "project_type": behavior.get("project_type"),
            "install_command": behavior.get("install_command"),
            "run_command": behavior.get("run_command"),
            "auto_build_succeeded": built,
            "ran_without_crash": ran,
            "build_exit_code": behavior.get("build_exit_code"),
            "run_exit_code": behavior.get("run_exit_code"),
        },
        # The network INTENT, fused from the trap (external) + analysis (off-VM).
        "network_intent": {
            "attempts": intents,
            "attempt_count": len(intents),
            "intended_destinations": analysis.get("destinations", []),
            "geolocations": analysis.get("geolocations", []),
        },
        # In-VM behavior (strace), kept separate from network intent.
        "in_vm_behavior": {
            "high_value_credential_reads": agg.get("high_value_cred_read_count", 0),
            "high_value_credential_reads_succeeded": agg.get("high_value_cred_read_succeeded", 0),
            "credential_reads_detail": agg.get("credential_reads", []),
            "suspicious_binaries": agg.get("suspicious_binaries", []),
            "files_dropped_count": agg.get("files_dropped_count", 0),
            "files_dropped": agg.get("files_dropped", [])[:50],
            "high_cpu": bool(agg.get("high_cpu")),
            "run_cpu_cores_busy": agg.get("run_cpu_cores_busy", 0),
            "process_exec_count": agg.get("exec_count", 0),
        },
        # Captured payloads analysis (decode + AI intent), from the disposable env.
        "payload_analysis": {
            "decoded_payloads": analysis.get("decoded_payloads", []),
            "ai_intent_summary": analysis.get("ai_intent_summary"),
            "ai_model": analysis.get("ai_model"),
            "ai_analysis_error": analysis.get("error"),
        },
        # The dual-source containment proof.
        "containment": {
            "external_monitor_saw_egress": external_monitor_saw_egress,
            "in_vm_saw_egress": in_vm_saw_egress,
            "no_real_packet_reached_destination": True,  # the invariant — see notes
            "containment_notes": (
                "Double containment held: (1) VPC deny-all egress firewall blocks "
                "any direct internet egress from the detonation VM; (2) in-VM "
                "iptables DNAT redirected every outbound call to the intra-VPC "
                "trap, which terminates locally and never forwards (ip_forward=0, "
                "FORWARD DROP, no MASQUERADE). The intended destination IP was "
                "resolved OFF-VM for intelligence only and never routed to."
            ),
            "egress_control_probe": behavior.get("egress_control_probe"),
        },
        # The honest verdict (maximally dangerous on detected attack; never bare Safe).
        "verdict": verdict,
        "honesty": {
            "possibly_dormant_unverified": possibly_dormant,
            "notes": (
                ["The code ran to completion but exhibited no observable behavior. "
                 "This is reported as UNVERIFIED — condition-gated or trap-aware "
                 "code that withholds its payload would look exactly like this. "
                 "Absence of captured malice is NOT a clean bill of health."]
                if possibly_dormant else
                verdict.get("not_verified", [])
            ),
        },
    }
    return forensic


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--behavior", help="behavior report JSON (observe.py merged)")
    ap.add_argument("--capture", help="trap capture JSONL (sinkd.py)")
    ap.add_argument("--analysis", help="off-VM payload analysis JSON (analyze-payload.py)")
    ap.add_argument("--verdict", help="dynamic verdict JSON (verdict.py)")
    ap.add_argument("--target", default="unknown", help="owner/repo label")
    ap.add_argument("--out", required=True, help="path to write forensic JSON")
    args = ap.parse_args()

    forensic = build_forensics(args)

    # Rail enforcement: a forensic record must never collapse to a bare "Safe".
    blob = json.dumps(forensic)
    assert '"Safe"' not in blob and "'Safe'" not in blob, "RAIL VIOLATION: bare 'Safe'"

    with open(args.out, "w") as f:
        json.dump(forensic, f, indent=2)
    print(json.dumps(forensic, indent=2))


if __name__ == "__main__":
    main()
