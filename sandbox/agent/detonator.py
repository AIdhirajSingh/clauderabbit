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
from typing import Callable

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


class DetonationRejected(ValueError):
    """Raised when a detonate request violates the fixed grammar. The agent loop
    catches this and records a `not_verified` outcome — it NEVER relays an
    invalid target."""


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


def build_detonate_command(runtime: str, target: str, trap_ip: str) -> str:
    """Build the EXACT fixed-grammar relay command. Separated out so tests can
    assert the precise string. Inputs are assumed already validated; trap_ip is
    re-checked here as defense in depth before it touches the command string."""
    if not TRAP_IP_RE.match(trap_ip or ""):
        raise DetonationRejected(f"trap_ip is not a valid 10.200.x address: {trap_ip!r}")
    # NOTE: this is the ONLY command shape this module ever emits. runtime and
    # target are constrained to a tiny safe-character grammar above, so no
    # quoting tricks are possible; we still keep the form rigid and flat.
    return (
        f"CR_TRAP_IP={trap_ip} sudo bash {REMOTE_HARNESS} "
        f"run-target {runtime} {target}"
    )


def _parse_observation(raw: str) -> dict:
    """Parse the harness output into the per-target observation facts.

    The harness prints the path of the per-target JSON as its LAST stdout line;
    when run over SSH the caller typically `cat`s that file so the JSON itself is
    in the output. We accept either: a JSON document anywhere in the text, else
    fall back to recording the raw tail so a parse failure is never silent.
    Returns a dict that always carries `aggregate_observations`.
    """
    text = raw or ""
    # Find the last JSON object in the output (the observation report).
    obj = _extract_last_json_object(text)
    if obj is None:
        # No JSON surfaced — record an honest, non-silent failure marker. The
        # agent treats a missing observation as "not verified", never as clean.
        return {
            "parse_error": "no JSON observation found in harness output",
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
    """Best-effort: return the LAST balanced top-level JSON object in `text`.
    Pure string scanning — never evaluates anything. Returns None if none parse.
    """
    candidates: list[dict] = []
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
                        if isinstance(parsed, dict):
                            candidates.append(parsed)
                    except ValueError:
                        pass
                    start = -1
    return candidates[-1] if candidates else None


def detonate(
    runtime: str,
    target: str,
    *,
    ssh_exec: Callable[[str], str],
    trap_ip: str,
    allowed_targets: set[str],
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

    Returns:
      The per-target observation dict, always carrying `aggregate_observations`.

    Raises:
      DetonationRejected: if runtime/target/trap_ip violate the fixed grammar.
        The relay is NEVER invoked on a rejected request.
    """
    _validate_runtime(runtime)
    _validate_target(target, allowed_targets)
    command = build_detonate_command(runtime, target, trap_ip)
    # Relay EXACTLY the fixed command. To get the observation JSON back over SSH
    # we append a read of the per-target file the harness names on its last line;
    # the read is a flat `cat` of a fixed-prefix path, no untrusted interpolation.
    relay = f"{command} | tail -1 | xargs -r cat"
    raw = ssh_exec(relay)
    facts = _parse_observation(raw)
    facts["_detonated"] = {"runtime": runtime, "target": target}
    return facts
