#!/usr/bin/env python3
"""
verdict.py — turn a behavior report into an honest dynamic-path verdict.

This is the deep-path side of the scoring. It consumes the structured behavior
report produced by the harness (real observed facts) and emits a 0-100 dynamic
score plus a plain-language verdict.

It enforces Claude Rabbit safety rail #1: NEVER state a bare "Safe." Every
verdict states what was observed AND what was not verified. The cleanest
possible repo gets a verdict like "No malicious behavior observed in our
sandbox run" — never the word "Safe" standing alone.

It also keeps reputation and code/behavior signals separate: this module emits
ONLY code/behavior signals (it has no reputation input). The orchestrator/edge
function blends this with the separately-tracked reputation signal.

Run: verdict.py behavior-report.json
"""
import json
import sys

# One-word verdict labels mapped to the fixed score-color logic
# (green=high/secure, blue=upper-middle, yellow=warning, red=low/dangerous).
# NOTE: "Secure" is the green label — never a bare "Safe".
COLOR_BANDS = [
    (85, "green", "Clean run"),
    (65, "blue", "Likely clean"),
    (40, "yellow", "Caution"),
    (0, "red", "Dangerous"),
]


def band(score):
    for threshold, color, label in COLOR_BANDS:
        if score >= threshold:
            return color, label
    return "red", "Dangerous"


def build_verdict(report):
    agg = report.get("aggregate_observations", {})

    findings = []          # code/behavior evidence (separate from reputation)
    not_verified = []      # honest statement of what we could NOT confirm
    score = 100            # start clean, subtract for observed bad behavior

    # --- credential access (highest weight) --------------------------------
    # Only HIGH-VALUE reads (SSH keys, cloud creds, saved tokens, shell history)
    # are a theft signal. Tool-config reads like ~/.npmrc are recorded but not
    # treated as malicious, so a clean `npm install` is not mislabeled.
    cred_reads = agg.get("high_value_cred_read_count", 0)
    cred_ok = agg.get("high_value_cred_read_succeeded", 0)
    if cred_reads > 0:
        findings.append({
            "signal": "credential_access",
            "severity": "critical",
            "detail": (
                f"Code attempted to read {cred_reads} high-value credential "
                f"path(s) (SSH keys, ~/.aws, saved tokens, shell history) during "
                f"install/run; {cred_ok} read(s) returned data from planted decoys."
            ),
        })
        score -= 45 + min(cred_reads * 3, 20)

    # --- outbound network attempts -----------------------------------------
    # Distinguish three cases honestly:
    #  (1) outbound paired with a high-value credential read = exfiltration.
    #  (2) outbound during the RUN phase (after install) = malicious beaconing.
    #  (3) outbound ONLY during BUILD with no cred theft = almost always a
    #      package manager fetching declared dependencies; reported as an
    #      informational note (could not fetch deps, egress locked), NOT malice.
    internet_attempts = agg.get("internet_attempt_count", 0)
    net_blocked = agg.get("network_blocked_count", 0)
    run_outbound = agg.get("run_outbound_attempted", False)
    # Sinkholed = the monitored-sinkhole INTERCEPTED the outbound and redirected
    # it to the trap. Total sinkholed vs RUN-phase-only sinkholed matters a lot:
    # a package manager fetching deps during BUILD also gets sinkholed (its
    # registry connect is redirected to the trap), and that is NOT malicious.
    sinkholed = agg.get("sinkholed_attempt_count", 0)
    run_sinkholed = agg.get("run_sinkholed_attempt_count", 0)
    any_outbound = bool(agg.get("outbound_internet_attempted", False)
                        or agg.get("egress_intercepted_or_blocked", False)
                        or agg.get("egress_blocked_confirmed", False)
                        or agg.get("exfil_blocked_app_signal", False))
    app_blocked = agg.get("exfil_blocked_app_signal", False)

    # Caught network intent gathered by the sinkhole trap (the would-be C2,
    # mining pool, etc.). Captured inert; NO real packet reached it. A captured
    # HOST/SNI/payload is the difference between "the package manager pinged the
    # registry" (no host extracted, build phase) and "the code tried to ship
    # data to evil-c2" (host + payload captured).
    net_intent = report.get("network_intent", {})
    captured_hosts = sorted({
        a.get("intended_host") for a in net_intent.get("attempts", [])
        if a.get("intended_host")
    })
    captured_payload = any(
        a.get("would_be_payload_b64") for a in net_intent.get("attempts", [])
    )

    # A sinkholed connection is the CAUGHT-ATTACK signal only when it is NOT just
    # benign build-phase package-manager chatter. It counts as an attack if any of:
    #   - it happened during the RUN phase (after install completed), OR
    #   - the code also read high-value credentials (exfil shape), OR
    #   - the trap captured a real intended host or a payload (deliberate exfil).
    # Build-phase-only sinkhole hits with no host, no payload, and no cred read
    # are the dependency manager reaching the registry — reported honestly, not
    # as malice.
    attack_sinkholed = bool(
        run_sinkholed or (sinkholed and (cred_reads > 0 or captured_hosts or captured_payload))
    )
    benign_build_sinkhole = bool(sinkholed and not attack_sinkholed)

    malicious_outbound = (cred_reads > 0 and any_outbound) or run_outbound or attack_sinkholed
    if malicious_outbound:
        when = "after install (run phase)" if (run_outbound or run_sinkholed) else "during install"
        if attack_sinkholed:
            host_phrase = (
                f" The sinkhole captured the intended destination(s): "
                f"{', '.join(captured_hosts[:5])}." if captured_hosts else ""
            )
            blocked_phrase = (
                f"{sinkholed} outbound connection(s) INTERCEPTED by the "
                f"monitored sinkhole and redirected to a controlled trap; the "
                f"would-be payload was captured inert and NO real packet reached "
                f"the real destination.{host_phrase}"
            )
        else:
            blocked_phrase = (
                f"{net_blocked} of {internet_attempts} internet-bound connect(s) "
                f"blocked by sandbox egress lockdown"
                if internet_attempts else
                "the attempt failed because the sandbox denies all egress"
                if app_blocked else "blocked by sandbox egress lockdown"
            )
        findings.append({
            "signal": "outbound_network",
            "severity": "critical" if (cred_reads > 0 or attack_sinkholed) else "high",
            "detail": (
                f"Code attempted to reach a non-local internet host {when} "
                f"({blocked_phrase}). The attempt itself is the signal."
            ),
        })
        # A sinkholed (caught) attack is weighted heavier than a merely-blocked one.
        score -= 40 if attack_sinkholed else 30
    elif benign_build_sinkhole:
        # Build-phase package-manager traffic, intercepted by the sinkhole but
        # carrying no host/payload and no credential theft. Honest note, NOT malice.
        not_verified.append(
            "During the build phase the package manager made network connections "
            "(intercepted by the sandbox sinkhole) to fetch declared dependencies; "
            "no credential access, no captured exfil destination, and no payload "
            "were observed — consistent with normal dependency installation."
        )
    elif any_outbound:
        # build-phase-only outbound, no cred theft → dependency fetch, honest note
        not_verified.append(
            "The project tried to reach the network during install (typical of "
            "a package manager fetching dependencies); the sandbox blocks egress, "
            "so dependency installation could not complete in this run."
        )

    # --- exfiltration pattern: high-value cred read + outbound attempt ------
    if cred_reads > 0 and any_outbound:
        caught = (
            " The sinkhole captured the exfil destination and the would-be "
            "payload inert — confirming intent without ever delivering it."
            if attack_sinkholed else ""
        )
        findings.append({
            "signal": "exfiltration_pattern",
            "severity": "critical",
            "detail": (
                "Behavior matches a credential-exfiltration pattern: read of "
                "high-value credential paths combined with an outbound network "
                "attempt. This is the classic install-time supply-chain attack "
                f"shape.{caught}"
            ),
        })
        score -= 25

    # --- mining / unbounded CPU --------------------------------------------
    if agg.get("high_cpu"):
        cores = agg.get("max_cpu_cores_busy", agg.get("max_cpu_busy_fraction"))
        findings.append({
            "signal": "high_cpu",
            "severity": "high",
            "detail": (
                f"Sustained high CPU usage observed "
                f"(~{cores} core(s) pinned during the run). Consistent with "
                f"crypto-mining or a runaway/abuse workload."
            ),
        })
        score -= 20

    # --- suspicious binaries spawned ---------------------------------------
    susp = [b for b in agg.get("suspicious_binaries", [])
            if b.split("/")[-1] in ("curl", "wget", "nc", "ncat", "socat", "xmrig", "minerd")]
    if susp:
        findings.append({
            "signal": "suspicious_process",
            "severity": "medium",
            "detail": f"Spawned network/mining-capable binaries during install/run: {', '.join(susp)}.",
        })
        score -= 10

    # --- files dropped ------------------------------------------------------
    dropped = agg.get("files_dropped_count", 0)
    # node_modules / pip installs legitimately create many files; only flag if
    # paired with other bad behavior or if dropping into sensitive dirs.
    sensitive_drops = [f for f in agg.get("files_dropped", [])
                       if any(s in f for s in ("/.ssh/", "/.config/autostart", "/etc/cron", "/.bashrc", "/.profile"))]
    if sensitive_drops:
        findings.append({
            "signal": "persistence_drop",
            "severity": "high",
            "detail": f"Wrote into persistence/sensitive locations: {sensitive_drops[:5]}.",
        })
        score -= 25

    score = max(0, min(100, score))

    # --- honesty: always state what was NOT verified ------------------------
    # Whether the code was actually EXERCISED gates how confidently we may read
    # an absence of malice. Built AND ran-without-crash = exercised; anything
    # less means the runtime was barely touched and a clean read is unverified.
    built = bool(report.get("auto_build_succeeded"))
    ran = bool(report.get("ran_without_crash"))
    run_exercised = built and ran
    if not built:
        not_verified.append(
            "The project did not build/install cleanly unattended, so its full "
            "runtime behavior could not be exercised in this run."
        )
    elif not ran:
        not_verified.append(
            "The project built but exited with an error shortly after starting "
            "(it crashed on startup), so its runtime behavior was only minimally "
            "exercised in this run."
        )
    if report.get("run_phase", {}).get("strace_available") is False:
        not_verified.append(
            "Syscall tracing was unavailable on the VM; network/credential "
            "observation for this run is best-effort."
        )
    not_verified.append(
        "This reflects one automated sandbox execution with locked egress and "
        "no real credentials present; condition-triggered behavior that did not "
        "fire during our run would not be observed."
    )

    color, label = band(score)

    # --- the verdict line — NEVER a bare "Safe" -----------------------------
    if not findings and not run_exercised:
        # We observed no malice, but we never actually exercised the code (build
        # failed, or it crashed on startup). Rail #1: that is INCONCLUSIVE, never
        # a confident green "Clean run". Keep it out of the clean bands and say so.
        label = "Inconclusive"
        color = "yellow"
        if score > 64:
            score = 64
        headline = (
            "No malicious behavior observed, but the project did not run to "
            "completion in our sandbox, so its runtime behavior is largely "
            "unverified."
        )
    elif not findings:
        headline = "No malicious behavior observed in our sandbox run."
    else:
        crit = sum(1 for f in findings if f["severity"] == "critical")
        if attack_sinkholed:
            headline = (
                "Malicious behavior CAUGHT: this code tried to phone out and the "
                "sinkhole intercepted it — destination and payload captured, "
                "nothing delivered."
            )
        elif crit:
            headline = (
                "Malicious behavior observed during build/install, before the "
                "project finished starting."
                if not run_exercised
                else "Malicious behavior observed when we ran this code."
            )
        else:
            headline = (
                "Suspicious behavior observed during build/install, before the "
                "project finished starting."
                if not run_exercised
                else "Suspicious behavior observed when we ran this code."
            )

    verdict = {
        "schema": "claude-rabbit/dynamic-verdict@1",
        "dynamic_score": score,            # 0-100, code/behavior only
        "score_color": color,              # fixed color logic
        "one_word": label,                 # never a bare "Safe"
        "headline": headline,
        "code_behavior_findings": findings,
        # The intent the sinkhole captured (would-be destinations); empty if none.
        "captured_network_intent": captured_hosts,
        "egress_intercepted_count": sinkholed,
        "attack_egress_intercepted": attack_sinkholed,
        "not_verified": not_verified,
        "signal_class": "code_behavior",   # explicitly NOT reputation
        "auto_build_succeeded": report.get("auto_build_succeeded", False),
        "ran_without_crash": report.get("ran_without_crash", False),
        "project_type": report.get("project_type"),
    }
    # Rail enforcement at the SOURCE (defense in depth): any caller of
    # build_verdict() — not just main() — gets the never-bare-"Safe" guarantee.
    _blob = json.dumps(verdict)
    assert '"Safe"' not in _blob and "'Safe'" not in _blob, "RAIL VIOLATION: bare 'Safe'"
    return verdict


def main():
    if len(sys.argv) < 2:
        print("usage: verdict.py <behavior-report.json>", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1]) as f:
        report = json.load(f)
    verdict = build_verdict(report)
    # Guard rail enforcement: assert the word "Safe" never appears alone.
    blob = json.dumps(verdict)
    assert '"Safe"' not in blob and "'Safe'" not in blob, "RAIL VIOLATION: bare 'Safe'"
    print(json.dumps(verdict, indent=2))


if __name__ == "__main__":
    main()
