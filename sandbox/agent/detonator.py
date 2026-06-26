#!/usr/bin/env python3
"""
detonator.py — the constrained detonate relay (audit C1/C3).

Phase 2 of the agentic sandbox. The off-VM agent brain (agent_loop.py) decides
WHICH repo file to detonate; this module is the ONLY way that decision turns into
execution, and it does so under a fixed grammar that an injected/hostile repo can
never widen into arbitrary or root execution.

The single load-bearing security property (audit C1):
  Untrusted code runs ONLY through `run-harness.sh run-target` as the NON-ROOT
  `runner` uid, under the sinkhole + observer. The sinkhole DNAT exempts uid 0,
  so root traffic would BYPASS the sink — an egress leak. This relay therefore
  emits EXACTLY one fixed command shape and NEVER builds a free-form shell string
  from model- or repo-authored text.

What `detonate()` guarantees before it relays anything:
  - runtime is one of a FIXED allowlist {node, python3, sh};
  - target is a member of the caller-supplied allowed-file set (the knowledge
    graph's file list), AND independently re-checked for traversal / absolute /
    NUL / empty — even if the allowed set were somehow poisoned, the path grammar
    still holds;
  - the relayed command is the exact `CR_TRAP_IP=<ip> sudo bash
    /opt/cr/run-harness.sh run-target <runtime> <target>` form.

It is PURE with respect to the injected `ssh_exec`: tests pass a mock that
captures the exact command string and returns canned harness output; the real
caller passes orchestrate's `ssh_det`. No network, no subprocess here.

The returned value is the per-target observation facts (the same
`aggregate_observations`-shaped dict the harness/observer emit), parsed from the
JSON the harness wrote and `ssh_exec` surfaces. The agent reads FACTS from this,
never from model claims.
"""
from __future__ import annotations

import json
import re
import secrets
import sys
from typing import Callable, Optional

# --- Fixed grammar (audit C1) -----------------------------------------------

# The ONLY runtimes the agent may request. A repo cannot smuggle "bash -c ..."
# or an interpreter flag in here — it is an exact-match allowlist.
ALLOWED_RUNTIMES = ("node", "python3", "sh")

# The remote path of the harness on the detonation VM (orchestrate stages it
# here). A constant, never derived from untrusted input.
REMOTE_HARNESS = "/opt/cr/run-harness.sh"

# A conservative trap-IP shape so a poisoned trap_ip cannot inject shell
# metacharacters into the relayed command. Matches the orchestrator's own check.
TRAP_IP_RE = re.compile(r"^10\.200\.\d{1,3}\.\d{1,3}$")

# A target path must be a plain repo-relative POSIX path: no absolute, no
# traversal, no NUL, no shell metacharacters at all. This is a WHITELIST of
# allowed characters, not a blacklist of bad ones.
SAFE_PATH_RE = re.compile(r"^[A-Za-z0-9_./\-]+$")

# HIGH-3: the per-target observation file is named by the CONTROLLER, not the VM.
# The controller passes a unique run token (CR_RUN_N) drawn from this tiny safe
# grammar; the harness writes /tmp/cr-run-<token>.json; the controller then reads
# back THAT exact, controller-computed path with a separate fixed `cat`. We never
# pipe VM stdout into a shell that word-splits, so a hostile "last line" such as
# `;curl evil` or a path with spaces can never become a command on the controller.
RUN_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# The full readback path the harness writes and we `cat`. Re-validated as a whole
# before it is ever placed in a command, so nothing but this exact shape is read.
RUN_OUTPUT_PATH_RE = re.compile(r"^/tmp/cr-run-[A-Za-z0-9_-]+\.json$")


class DetonationRejected(ValueError):
    """Raised when a detonate request violates the fixed grammar. The agent loop
    catches this and records a `not_verified` outcome — it NEVER relays an
    invalid target."""


def _run_output_path(run_token: str) -> str:
    """Compute the controller-determined observation path for a run token.
    The token is validated against RUN_TOKEN_RE first; the assembled path is then
    re-validated against RUN_OUTPUT_PATH_RE as belt-and-suspenders before use."""
    if not isinstance(run_token, str) or not RUN_TOKEN_RE.match(run_token):
        raise DetonationRejected(
            f"run token has disallowed characters (expected [A-Za-z0-9_-]+): {run_token!r}"
        )
    path = f"/tmp/cr-run-{run_token}.json"
    if not RUN_OUTPUT_PATH_RE.match(path):
        # Unreachable given the token check, but never emit an unvalidated path.
        raise DetonationRejected(f"computed run-output path is not well-formed: {path!r}")
    return path


def _validate_runtime(runtime: str) -> None:
    if runtime not in ALLOWED_RUNTIMES:
        raise DetonationRejected(
            f"invalid runtime {runtime!r}; allowed: {', '.join(ALLOWED_RUNTIMES)}"
        )


def _validate_target(target: str, allowed_targets: set[str]) -> None:
    """Validate a target path against BOTH the allowed graph set and the
    standalone path grammar. Either failing rejects the detonation."""
    if not isinstance(target, str) or not target:
        raise DetonationRejected("target path is empty")
    if "\x00" in target:
        raise DetonationRejected("target path contains a NUL byte")
    if target.startswith("/"):
        raise DetonationRejected(f"target path must be repo-relative, not absolute: {target!r}")
    if ".." in target.split("/"):
        raise DetonationRejected(f"target path must not contain '..': {target!r}")
    if not SAFE_PATH_RE.match(target):
        raise DetonationRejected(f"target path has disallowed characters: {target!r}")
    # The path must be a file the knowledge graph actually indexed. The agent can
    # only detonate what exploration discovered, never an arbitrary path.
    if target not in allowed_targets:
        raise DetonationRejected(
            f"target {target!r} is not in the allowed knowledge-graph file set"
        )


def build_detonate_command(runtime: str, target: str, trap_ip: str, run_token: str) -> str:
    """Build the EXACT fixed-grammar relay command. Separated out so tests can
    assert the precise string. Inputs are assumed already validated; trap_ip and
    run_token are re-checked here as defense in depth before they touch the
    command string.

    HIGH-3: the run_token (CR_RUN_N) is supplied by the CONTROLLER and makes the
    harness write its observation JSON to a controller-determined path
    (/tmp/cr-run-<token>.json). The controller reads that exact path back with a
    SEPARATE fixed `cat` — never by piping the harness's stdout into a shell."""
    if not TRAP_IP_RE.match(trap_ip or ""):
        raise DetonationRejected(f"trap_ip is not a valid 10.200.x address: {trap_ip!r}")
    if not isinstance(run_token, str) or not RUN_TOKEN_RE.match(run_token):
        raise DetonationRejected(
            f"run token has disallowed characters (expected [A-Za-z0-9_-]+): {run_token!r}"
        )
    # NOTE: this is the ONLY command shape this module ever emits. runtime,
    # target, and run_token are constrained to a tiny safe-character grammar
    # above, so no quoting tricks are possible; we still keep the form rigid+flat.
    # The env vars go AFTER `sudo` (sudo passes VAR=val args into the command's
    # environment but STRIPS a caller-set environment) — a `CR_TRAP_IP=x sudo …`
    # prefix is dropped by sudo, which made run-target refuse for lack of a trap IP
    # (the live proof-3 failure). This mirrors orchestrate's working `sudo
    # CR_TRAP_IP=$TRAP_IP bash run-harness.sh run`.
    return (
        f"sudo CR_TRAP_IP={trap_ip} CR_RUN_N={run_token} bash {REMOTE_HARNESS} "
        f"run-target {runtime} {target}"
    )


# MED-2: an observation object is only ACCEPTED if it carries a recognizable
# observation schema. A hostile VM can append a tiny zeroed object (e.g.
# {"high_value_cred_read_succeeded": 0}) AFTER the real report to make the LAST
# JSON object look "clean" and suppress findings. We therefore require one of
# these markers and scan for the LAST object that actually validates.
_SCHEMA_MARKER_FIELDS = ("schema", "aggregate_observations", "observations")
# Known aggregate keys: if a bare aggregate dict (no wrapper) is surfaced, it
# must look like a real aggregate_observations record, not an arbitrary object.
# These mirror the fields the observer/harness merge emits.
_KNOWN_AGGREGATE_KEYS = frozenset({
    "high_value_cred_read_succeeded", "high_value_cred_read_count",
    "run_sinkholed_attempt_count", "sinkholed_attempt_count", "high_cpu",
    "files_dropped_count", "exec_count",
    "network_attempt_count", "internet_attempt_count", "network_blocked_count",
    "credential_read_count", "outbound_internet_attempted",
})


def _is_valid_observation(obj: dict) -> bool:
    """True iff `obj` looks like a genuine harness/observer observation report.

    Accepts an object that carries an explicit schema marker
    (`schema` / `aggregate_observations` / `observations`), OR a bare aggregate
    dict that contains at least one KNOWN aggregate key. A crafted zeroed object
    like {"high_value_cred_read_succeeded": 0} alone would pass the bare-aggregate
    gate (it is a known key) — but it can only ever DOWNGRADE nothing: it has no
    truthy facts, and because we scan for the last object that ALSO carries a
    schema marker first, the real wrapped report (which always has `schema` and
    `aggregate_observations`) is preferred over a bare zeroed tail object."""
    if not isinstance(obj, dict):
        return False
    if any(k in obj for k in _SCHEMA_MARKER_FIELDS):
        return True
    return bool(_KNOWN_AGGREGATE_KEYS & set(obj.keys()))


def _has_schema_marker(obj: dict) -> bool:
    """Stricter check: the object carries an EXPLICIT report wrapper marker."""
    return isinstance(obj, dict) and any(k in obj for k in _SCHEMA_MARKER_FIELDS)


def _parse_observation(raw: str) -> dict:
    """Parse the harness output into the per-target observation facts.

    The controller reads back a fixed `cat <validated-path>`, so `raw` is the
    observation JSON file content. We accept the LAST JSON object that passes
    schema validation (MED-2) — never just the last balanced object, so a hostile
    VM cannot append a zeroed "clean" object to suppress real findings. If nothing
    validates, we record a non-silent parse error (treated as not-verified, never
    clean). Returns a dict that always carries `aggregate_observations`.
    """
    text = raw or ""
    # Find the last SCHEMA-VALID JSON object in the output (the real report).
    obj = _extract_last_json_object(text)
    if obj is None:
        # No valid observation surfaced — honest, non-silent failure marker. The
        # agent treats a missing observation as "not verified", never as clean.
        return {
            "parse_error": "no schema-valid JSON observation found in harness output",
            "raw_tail": text[-500:],
            "aggregate_observations": {},
        }
    # The observer writes a single-phase report with `observations`; the merge
    # step (and forensics) use `aggregate_observations`. Normalize to expose
    # `aggregate_observations` regardless of which shape we received.
    agg = obj.get("aggregate_observations")
    if agg is None:
        agg = obj.get("observations", {})
        obj = dict(obj)
        obj["aggregate_observations"] = agg
    return obj


def _extract_last_json_object(text: str) -> dict | None:
    """Return the LAST balanced top-level JSON object in `text` that passes
    observation schema validation (MED-2). Pure string scanning — never evaluates
    anything.

    Two-tier preference (closes the suppression hole):
      1. Prefer the last object that carries an EXPLICIT report wrapper marker
         (`schema` / `aggregate_observations` / `observations`). The genuine
         merged report always has these, so a bare zeroed tail object cannot
         displace it.
      2. If none carry a wrapper marker, fall back to the last object that is at
         least a recognizable bare aggregate (a known aggregate key present).
    Returns None if no candidate validates at either tier.
    """
    schema_marked: list[dict] = []
    bare_valid: list[dict] = []
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    chunk = text[start : i + 1]
                    try:
                        parsed = json.loads(chunk)
                    except ValueError:
                        parsed = None
                    if isinstance(parsed, dict):
                        if _has_schema_marker(parsed):
                            schema_marked.append(parsed)
                        elif _is_valid_observation(parsed):
                            bare_valid.append(parsed)
                    start = -1
    if schema_marked:
        return schema_marked[-1]
    return bare_valid[-1] if bare_valid else None


def detonate(
    runtime: str,
    target: str,
    *,
    ssh_exec: Callable[[str], str],
    trap_ip: str,
    allowed_targets: set[str],
    run_token: Optional[str] = None,
) -> dict:
    """Detonate ONE repo file via the fixed-grammar harness relay.

    Args:
      runtime: one of ALLOWED_RUNTIMES (node | python3 | sh).
      target: a repo-relative path; MUST be a member of `allowed_targets`.
      ssh_exec: injected `command -> output` callable. The real caller passes
        orchestrate's ssh_det (intra-VPC SSH into the sealed VM); tests pass a
        mock. This module NEVER opens its own connection.
      trap_ip: the sinkhole trap private IP (10.200.x.y), validated.
      allowed_targets: the set of repo-relative paths the knowledge graph
        indexed — the agent may detonate ONLY these.
      run_token: a unique CONTROLLER-chosen token (CR_RUN_N) that names the
        observation file. If None, a fresh random token is generated here so the
        output path is ALWAYS controller-determined, never VM-determined.

    Returns:
      The per-target observation dict, always carrying `aggregate_observations`.

    Raises:
      DetonationRejected: if runtime/target/trap_ip/run_token violate the fixed
        grammar. The relay is NEVER invoked on a rejected request.

    HIGH-3 — the readback is a SEPARATE fixed `cat <controller-validated-path>`.
    We do NOT pipe the harness's stdout into any shell (no `tail`/`xargs`), so a
    hostile harness "last line" (`;curl evil`, spaces, metacharacters) can never
    word-split into a command on the controller. The path we `cat` is computed
    HERE from our own run_token and re-validated against RUN_OUTPUT_PATH_RE; we
    ignore whatever path the VM prints.
    """
    _validate_runtime(runtime)
    _validate_target(target, allowed_targets)
    # Controller-chosen, validated run token => controller-determined output path.
    if run_token is None:
        run_token = secrets.token_hex(16)
    command = build_detonate_command(runtime, target, trap_ip, run_token)
    output_path = _run_output_path(run_token)  # validated /tmp/cr-run-<token>.json

    # Step 1: relay EXACTLY the fixed detonation command. We never trust or parse
    # VM-printed paths (HIGH-3); the relay output is logged ONLY for diagnostics,
    # never word-split into a command.
    out1 = ssh_exec(command)
    print(f"[detonator] run-target relay output: {(out1 or '')[:400]!r}", file=sys.stderr, flush=True)

    # Step 2: read the observation JSON back with a SEPARATE, fixed `sudo cat` of
    # the controller-computed path. output_path matches RUN_OUTPUT_PATH_RE (a flat
    # /tmp/cr-run-<safe-token>.json — no shell metacharacters), so `sudo cat` of it
    # is safe; sudo makes the read robust to the obs file being written by the
    # unprivileged `runner` (the cat runs as the SSH login user). The CONTENT is
    # still validated by _parse_observation (MED-2 schema marker).
    raw = ssh_exec(f"sudo cat {output_path}")
    if not (raw or "").strip():
        print(f"[detonator] readback EMPTY for {output_path}", file=sys.stderr, flush=True)
    facts = _parse_observation(raw)
    facts["_detonated"] = {"runtime": runtime, "target": target, "run_token": run_token}
    return facts
