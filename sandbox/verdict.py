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
    any_outbound = bool(agg.get("outbound_internet_attempted", False)
                        or agg.get("egress_blocked_confirmed", False)
                        or agg.get("exfil_blocked_app_signal", False))
    app_blocked = agg.get("exfil_blocked_app_signal", False)

    malicious_outbound = (cred_reads > 0 and any_outbound) or run_outbound
    if malicious_outbound:
        when = "after install (run phase)" if run_outbound else "during install"
        blocked_phrase = (
            f"{net_blocked} of {internet_attempts} internet-bound connect(s) "
            f"blocked by sandbox egress lockdown"
            if internet_attempts else
            "the attempt failed because the sandbox denies all egress"
            if app_blocked else "blocked by sandbox egress lockdown"
        )
        findings.append({
            "signal": "outbound_network",
            "severity": "critical" if cred_reads > 0 else "high",
            "detail": (
                f"Code attempted to reach a non-local internet host {when} "
                f"({blocked_phrase}). Outbound from the sandbox is denied by "
                f"firewall; the attempt itself is the signal."
            ),
        })
        score -= 30
    elif any_outbound:
        # build-phase-only outbound, no cred theft → dependency fetch, honest note
        not_verified.append(
            "The project tried to reach the network during install (typical of "
            "a package manager fetching dependencies); the sandbox blocks egress, "
            "so dependency installation could not complete in this run."
        )

    # --- exfiltration pattern: high-value cred read + outbound attempt ------
    if cred_reads > 0 and any_outbound:
        findings.append({
            "signal": "exfiltration_pattern",
            "severity": "critical",
            "detail": (
                "Behavior matches a credential-exfiltration pattern: read of "
                "high-value credential paths combined with an outbound network "
                "attempt. This is the classic install-time supply-chain attack "
                "shape."
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
    if not report.get("auto_build_succeeded"):
        not_verified.append(
            "The project did not build/install cleanly unattended, so its full "
            "runtime behavior could not be exercised in this run."
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
    if not findings:
        headline = (
            "No malicious behavior observed in our sandbox run."
            if report.get("auto_build_succeeded")
            else "No malicious behavior observed, but the project did not run to completion."
        )
    else:
        crit = sum(1 for f in findings if f["severity"] == "critical")
        if crit:
            headline = "Malicious behavior observed when we ran this code."
        else:
            headline = "Suspicious behavior observed when we ran this code."

    return {
        "schema": "claude-rabbit/dynamic-verdict@1",
        "dynamic_score": score,            # 0-100, code/behavior only
        "score_color": color,              # fixed color logic
        "one_word": label,                 # never a bare "Safe"
        "headline": headline,
        "code_behavior_findings": findings,
        "not_verified": not_verified,
        "signal_class": "code_behavior",   # explicitly NOT reputation
        "auto_build_succeeded": report.get("auto_build_succeeded", False),
        "ran_without_crash": report.get("ran_without_crash", False),
        "project_type": report.get("project_type"),
    }


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
