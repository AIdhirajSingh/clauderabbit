#!/usr/bin/env python3
"""
parallel_agents.py — THREE real agents exploring the repo concurrently, then a
cross-verification pass, on the controller (OUTSIDE the blast radius).

This is the C-track upgrade of the single-lead loop (agent_loop.py): instead of one
executor draining the whole work-list, three genuinely-distinct agents run in
PARALLEL, each with its own LENS over a DISJOINT partition of the repo, each its own
real `AgentLoop` (so every C3/C4/C5 rail — untrusted-data fencing, per-step budget
gates, fact-vs-inference — holds unchanged for each agent). They stream their real
reasoning live as they work, and a final cross-verification reconciles their findings
before the deterministic engine scores.

WHY THIS IS SAFE (the boundary is the relay, not the brain): the three agents only
DECIDE what to detonate. Every detonation still goes through the SAME fixed-grammar
`detonator.detonate()` relay, the SAME `allowed_targets` allow-list, and the SAME
sinkhole. Adding a second and third brain on the controller does not widen what can
run inside the sealed VM. The disjoint partition makes each `allowed_targets` a subset
of the whole, so the three agents cannot even detonate the same file twice.

The three lenses (genuinely different jobs, not three copies of one prompt):
  - install   : install scripts + manifests + lifecycle hooks (the #1 supply-chain
                vector — malware that fires at `npm install`/`pip install` time).
  - runtime   : entry points + network/credential/exfil behavior at run time.
  - payload   : obfuscated/encoded/dynamic-eval hotspots — hidden second stages.

Cross-verification (audit M1: peer review for PRIORITIZATION, never to promote a
finding to FACT): a target flagged by >=2 lenses, or carrying code-verified facts, is
"corroborated" and ranked first. Facts STILL come only from sandbox observations
(C5) — cross-verification adjusts confidence/ordering, it never fabricates a fact.
The three agents' detonation observations are UNIONed into ONE ScoringDynamicOutcome
(any agent that observed a cred-read/egress means it happened), which is what the
deterministic scorer (scoring.ts / verdict.py) consumes. The agents narrate; the
engine scores.

Model-agnostic: each agent is driven by an injected `model_call` factory, so the
SAME orchestrator runs on the Vertex-direct client (vertex_client.py, the proven
path) OR the OpenCode client (opencode_client.py) — `make_model_call` per lens is
supplied by the caller. Stdlib only; the loop + tests never import an SDK.
"""
from __future__ import annotations

import json
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Optional

from agent_loop import AgentLoop

# --- the three lenses --------------------------------------------------------

# A lens is a genuinely distinct analyst role. `system_addendum` is a fixed,
# code-authored suffix appended to the shared SYSTEM_PROMPT (still no untrusted
# byte enters it — C3 holds). `keywords` drive the disjoint partition: a file is
# assigned to the lens whose keywords best match its graph signals.
@dataclass(frozen=True)
class AgentLens:
    lens_id: str
    label: str
    system_addendum: str
    keywords: tuple[str, ...]


LENSES: tuple[AgentLens, ...] = (
    AgentLens(
        lens_id="install",
        label="install-time supply-chain",
        system_addendum=(
            "YOUR LENS: install-time supply chain. Concentrate on install/build "
            "scripts, package manifests, and lifecycle hooks (postinstall, preinstall, "
            "prepare, setup.py, build.rs). Most package-ecosystem malware fires the "
            "moment a victim installs — that is your beat."
        ),
        keywords=("install", "postinstall", "preinstall", "prepare", "package.json",
                  "setup.py", "pyproject", "build", "lifecycle", "hook", "npmrc"),
    ),
    AgentLens(
        lens_id="runtime",
        label="runtime exfil/C2",
        system_addendum=(
            "YOUR LENS: runtime behavior. Concentrate on entry points and anything "
            "that talks to the network, reads credentials, or exfiltrates data at run "
            "time — beacons, C2 callbacks, environment/secret harvesting."
        ),
        keywords=("index", "main", "entry", "server", "fetch", "request", "http",
                  "socket", "net", "credential", "token", "env", "exfil", "beacon"),
    ),
    AgentLens(
        lens_id="payload",
        label="obfuscation/hidden payload",
        system_addendum=(
            "YOUR LENS: hidden payloads. Concentrate on obfuscated, encoded, packed, "
            "or dynamically-evaluated code (base64 blobs, eval/exec, char-code arrays, "
            "minified droppers) — the second stage that the other two lenses' files "
            "may pull in."
        ),
        keywords=("eval", "exec", "base64", "obfusc", "encode", "decode", "payload",
                  "loader", "dropper", "wasm", "vm", "minified"),
    ),
)


# --- live-event streaming ----------------------------------------------------

# A streamed event from one agent, in arrival order across all three. `kind` is one
# of: "start", "thinking", "tool", "detonate", "finding", "done", "error".
@dataclass(frozen=True)
class AgentEvent:
    agent_id: str
    label: str
    kind: str
    text: str
    t: float


OnEvent = Callable[[AgentEvent], None]


class _EventSink:
    """Thread-safe ordered fan-in. Each agent thread pushes; the orchestrator drains
    in arrival order and forwards to the caller's `on_event` AS events arrive, so the
    UI sees three agents thinking live rather than a batch at the end."""

    def __init__(self) -> None:
        self._q: "queue.Queue[Optional[AgentEvent]]" = queue.Queue()

    def emit(self, ev: AgentEvent) -> None:
        self._q.put(ev)

    def close(self) -> None:
        self._q.put(None)  # sentinel: a single agent finished

    def drain_until(self, n_close: int, on_event: OnEvent, now: Callable[[], float]) -> None:
        """Forward events until `n_close` close-sentinels seen (all agents done)."""
        seen = 0
        while seen < n_close:
            ev = self._q.get()
            if ev is None:
                seen += 1
                continue
            try:
                on_event(ev)
            except Exception:  # noqa: BLE001 — a bad sink must never stall the agents
                pass


# --- disjoint partition ------------------------------------------------------

def _file_text_for_match(f: dict) -> str:
    """A lowercased haystack of a file's path + graph signals, for lens affinity."""
    parts = [str(f.get("path", ""))]
    for key in ("reason", "language", "kind"):
        if f.get(key):
            parts.append(str(f.get(key)))
    for sig in f.get("signals", []) or []:
        parts.append(str(sig))
    return " ".join(parts).lower()


def _affinity(haystack: str, lens: AgentLens) -> int:
    return sum(1 for kw in lens.keywords if kw in haystack)


def partition_graph(graph: dict, lenses: tuple[AgentLens, ...] = LENSES) -> dict[str, dict]:
    """Split the knowledge graph into one DISJOINT sub-graph per lens. Every file is
    assigned to exactly one lens (highest keyword affinity; ties + zero-affinity
    files round-robin so load stays balanced and NOTHING is dropped). Each sub-graph
    keeps the same shape AgentLoop expects (files/hotspots/install_scripts/summary),
    so each agent's `allowed_targets` becomes its own partition — disjoint detonation
    is enforced at the security layer, not just by convention."""
    buckets: dict[str, dict] = {
        l.lens_id: {"files": [], "hotspots": [], "install_scripts": [],
                    "summary": graph.get("summary", {}), "lens": l.lens_id}
        for l in lenses
    }
    rr = 0
    file_owner: dict[str, str] = {}
    for f in graph.get("files", []):
        if not isinstance(f, dict) or "path" not in f:
            continue
        hay = _file_text_for_match(f)
        scored = sorted(lenses, key=lambda l: _affinity(hay, l), reverse=True)
        best = scored[0]
        if _affinity(hay, best) == 0:
            best = lenses[rr % len(lenses)]  # unaffiliated → round-robin
            rr += 1
        buckets[best.lens_id]["files"].append(f)
        file_owner[f["path"]] = best.lens_id

    # Route hotspots + install_scripts to whichever lens owns their file (so a lens's
    # ranked work-list matches its files); a hotspot with no owned file is added to the
    # install lens (or the first lens) so nothing is dropped.
    for h in graph.get("hotspots", []):
        owner = file_owner.get(h.get("path"))
        if owner is None:
            owner = "install" if any(l.lens_id == "install" for l in lenses) else lenses[0].lens_id
            buckets[owner]["files"].append({"path": h.get("path"), "reason": "hotspot"})
            file_owner[h.get("path")] = owner
        buckets[owner]["hotspots"].append(h)
    install_bucket = buckets.get("install", buckets[lenses[0].lens_id])
    for s in graph.get("install_scripts", []):
        install_bucket["install_scripts"].append(s)
    return buckets


# --- one agent, event-wrapped ------------------------------------------------

def _wrap_model_call(inner: Callable, sink: _EventSink, lens: AgentLens,
                     now: Callable[[], float]) -> Callable:
    """Wrap a model_call so each turn emits the agent's REAL narrative as a live
    'thinking' event (and any tool requests as 'tool' events) before returning the
    response unchanged to the loop."""
    def wrapped(system: str, messages: list, tools: list) -> dict:
        resp = inner(system, messages, tools) or {}
        text = (resp.get("text") or "").strip()
        if text:
            sink.emit(AgentEvent(lens.lens_id, lens.label, "thinking", text[:600], now()))
        for tc in resp.get("tool_calls", []) or []:
            name = tc.get("name") or (tc.get("function") or {}).get("name") or "?"
            sink.emit(AgentEvent(lens.lens_id, lens.label, "tool", str(name), now()))
        return resp
    return wrapped


def _wrap_ssh_exec(inner: Callable[[str], str], sink: _EventSink, lens: AgentLens,
                   now: Callable[[], float]) -> Callable[[str], str]:
    """Wrap ssh_exec so each real detonation relay emits a live 'detonate' event."""
    def wrapped(command: str) -> str:
        head = (command or "").strip().splitlines()[0] if command else ""
        sink.emit(AgentEvent(lens.lens_id, lens.label, "detonate", head[:200], now()))
        return inner(command)
    return wrapped


def _system_for(base_system: str, lens: AgentLens) -> str:
    """Append the lens addendum to the shared fixed system prompt (still code-authored;
    no untrusted byte enters — C3)."""
    return f"{base_system}\n\n{'-' * 60}\n{lens.system_addendum}"


# --- the parallel orchestrator ----------------------------------------------

class ParallelAnalysis:
    """Run three lens-specialized AgentLoops concurrently over disjoint partitions,
    stream their reasoning live, then cross-verify and merge into one result + one
    ScoringDynamicOutcome. The deterministic engine still owns the number."""

    def __init__(
        self,
        *,
        repo_dir: str,
        graph: dict,
        commit_sha: str,
        name: str,
        trap_ip: str,
        ssh_exec: Callable[[str], str],
        make_model_call: Callable[[AgentLens], Callable],
        base_system: str,
        time_budget_s: float,
        token_budget: int,
        results_dir: str,
        cage_duration_s: Optional[float] = None,
        on_event: Optional[OnEvent] = None,
        now: Callable[[], float] = time.monotonic,
        lenses: tuple[AgentLens, ...] = LENSES,
    ):
        self.repo_dir = repo_dir
        self.graph = graph
        self.commit_sha = commit_sha
        self.name = name
        self.trap_ip = trap_ip
        self.ssh_exec = ssh_exec
        self.make_model_call = make_model_call
        self.base_system = base_system
        # Split the per-scan budget across the three agents (they run concurrently, so
        # wall-clock is shared; the token budget is divided so the SUM stays within the
        # per-scan cap — the C4 cage contract is per-agent and still <= 60% of the cage).
        self.time_budget_s = float(time_budget_s)
        self.per_agent_token_budget = max(1, int(token_budget) // max(1, len(lenses)))
        self.results_dir = results_dir
        self.cage_duration_s = cage_duration_s
        self.on_event = on_event or (lambda ev: None)
        self._now = now
        self.lenses = lenses

    def _run_one(self, lens: AgentLens, subgraph: dict, sink: _EventSink) -> dict:
        """Build and drive ONE lens's AgentLoop, event-wrapped. Never raises into the
        pool — a single agent's failure degrades to an empty result, the other two
        still finish (never-blank)."""
        try:
            sink.emit(AgentEvent(lens.lens_id, lens.label, "start",
                                 f"{len(subgraph.get('files', []))} files", self._now()))
            inner_call = self.make_model_call(lens)
            loop = AgentLoop(
                repo_dir=self.repo_dir,
                graph=subgraph,
                commit_sha=self.commit_sha,
                name=f"{self.name}-{lens.lens_id}",
                trap_ip=self.trap_ip,
                ssh_exec=_wrap_ssh_exec(self.ssh_exec, sink, lens, self._now),
                model_call=_wrap_model_call(inner_call, sink, lens, self._now),
                time_budget_s=self.time_budget_s,
                token_budget=self.per_agent_token_budget,
                results_dir=self.results_dir,
                cage_duration_s=self.cage_duration_s,
                now=self._now,
            )
            result = loop.run()
            for f in result.get("findings", []):
                sink.emit(AgentEvent(lens.lens_id, lens.label, "finding",
                                     str(f.get("target", "")), self._now()))
            sink.emit(AgentEvent(lens.lens_id, lens.label, "done",
                                 result.get("stopped_reason", ""), self._now()))
            result["lens"] = lens.lens_id
            result["lens_label"] = lens.label
            return result
        except Exception as e:  # noqa: BLE001 — never-blank: isolate one agent's crash
            sink.emit(AgentEvent(lens.lens_id, lens.label, "error", f"{type(e).__name__}: {e}", self._now()))
            return {"lens": lens.lens_id, "lens_label": lens.label, "findings": [],
                    "detonated_targets": [], "stopped_reason": f"crashed: {type(e).__name__}",
                    "dynamic_outcome": {"credentialReadObserved": False,
                                        "egressIntercepted": False, "autoBuildSucceeded": False}}

    def run(self) -> dict:
        """Fan out three agents, stream live, then cross-verify + merge."""
        partitions = partition_graph(self.graph, self.lenses)
        sink = _EventSink()
        results: dict[str, dict] = {}

        with ThreadPoolExecutor(max_workers=len(self.lenses)) as pool:
            futures = {
                lens.lens_id: pool.submit(self._run_one, lens, partitions[lens.lens_id], sink)
                for lens in self.lenses
            }
            # Drain live events on a side thread until every agent has closed; this
            # forwards each agent's reasoning to the UI as it happens, not at the end.
            drainer = threading.Thread(
                target=sink.drain_until, args=(len(self.lenses), self.on_event, self._now), daemon=True
            )
            drainer.start()
            for lens in self.lenses:
                results[lens.lens_id] = futures[lens.lens_id].result()
                sink.close()  # one close-sentinel per finished agent
            drainer.join(timeout=5)

        return self._cross_verify(results)

    # --- cross-verification + merge ------------------------------------------

    def _cross_verify(self, results: dict[str, dict]) -> dict:
        """Reconcile the three agents' findings. Corroboration is for PRIORITIZATION
        only (M1): a target is corroborated if >=2 lenses flagged it OR it carries
        code-verified facts. Facts are NEVER invented here — they come only from the
        per-agent observations (C5). All detonation outcomes are UNIONed into ONE
        ScoringDynamicOutcome the deterministic engine consumes."""
        # Gather findings keyed by target; track which lenses flagged each + fact count.
        by_target: dict[str, dict] = {}
        for lens_id, res in results.items():
            for f in res.get("findings", []):
                tgt = f.get("target")
                if not tgt:
                    continue
                slot = by_target.setdefault(tgt, {
                    "target": tgt, "lenses": [], "inferences": [],
                    "fact_count": 0, "facts": [], "severity_hints": []})
                slot["lenses"].append(lens_id)
                if f.get("inference"):
                    slot["inferences"].append({"lens": lens_id, "text": f["inference"]})
                slot["fact_count"] += int(f.get("fact_count", 0) or 0)
                slot["facts"].extend(f.get("facts", []) or [])
                if f.get("severity_hint"):
                    slot["severity_hints"].append(f["severity_hint"])

        cross: list[dict] = []
        for tgt, slot in by_target.items():
            n_lenses = len(set(slot["lenses"]))
            corroborated = n_lenses >= 2 or slot["fact_count"] > 0
            cross.append({
                **slot,
                "lenses": sorted(set(slot["lenses"])),
                "corroborated": corroborated,
                "fact_backed": slot["fact_count"] > 0,
            })
        # Rank: fact-backed first, then multi-lens corroboration, then lens count.
        cross.sort(key=lambda c: (c["fact_backed"], c["corroborated"], len(c["lenses"]),
                                  c["fact_count"]), reverse=True)

        # UNION the three dynamic outcomes — any agent that observed it means it happened.
        merged_outcome = {
            "credentialReadObserved": any(
                r.get("dynamic_outcome", {}).get("credentialReadObserved") for r in results.values()),
            "egressIntercepted": any(
                r.get("dynamic_outcome", {}).get("egressIntercepted") for r in results.values()),
            "autoBuildSucceeded": any(
                r.get("dynamic_outcome", {}).get("autoBuildSucceeded") for r in results.values()),
        }
        all_detonated = sorted({t for r in results.values() for t in r.get("detonated_targets", [])})
        not_verified = [n for r in results.values() for n in r.get("not_verified", [])]

        return {
            "schema": "claude-rabbit/agentic-findings@2",
            "name": self.name,
            "commit_sha": self.commit_sha,
            "mode": "three-parallel-cross-verified",
            "agents": [
                {"lens": r.get("lens"), "label": r.get("lens_label"),
                 "stopped_reason": r.get("stopped_reason"),
                 "finding_count": len(r.get("findings", [])),
                 "detonated": r.get("detonated_targets", [])}
                for r in results.values()
            ],
            "per_agent": results,
            "cross_verified_findings": cross,
            "corroborated_count": sum(1 for c in cross if c["corroborated"]),
            "detonated_targets": all_detonated,
            "not_verified": not_verified,
            "dynamic_outcome": merged_outcome,
            "authoritative_note": (
                "Three agents narrated; cross-verification ranks findings (peer review "
                "for prioritization only, never to promote an inference to a fact). The "
                "0-100 score is computed by the deterministic engine over the UNIONed "
                "observed facts — the agents never score."
            ),
        }


# --- CLI: wire the real engine + stream events as orchestrate milestones ------

def _emit_milestone(ev: "AgentEvent") -> None:
    """Forward one live agent event to STDERR in the `[agent] ...` shape orchestrate-
    microvm.sh + /api/deep's milestone parser already understand, so three agents'
    real reasoning streams to the UI as it happens."""
    import sys
    txt = (ev.text or "").replace("\n", " ").strip()
    print(f"[agent] {ev.agent_id} {ev.kind}: {txt}"[:400], file=sys.stderr, flush=True)


def main(argv: list[str]) -> int:
    import argparse
    import os as _os
    import shutil
    import subprocess
    import sys

    ap = argparse.ArgumentParser(description="Three-parallel-agent cross-verified analysis")
    ap.add_argument("--repo-dir", required=True)
    ap.add_argument("--graph", required=True, help="knowledge-graph.json path")
    ap.add_argument("--commit-sha", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--trap-ip", required=True)
    ap.add_argument("--results-dir", required=True)
    ap.add_argument("--time-budget-s", type=float, required=True)
    ap.add_argument("--token-budget", type=int, required=True)
    ap.add_argument("--cage-duration-s", type=float, default=None)
    ap.add_argument("--engine", choices=("opencode", "vertex"), default="opencode",
                    help="which brain drives the three agents (opencode falls back to "
                         "vertex if the binary is unavailable)")
    ap.add_argument("--project", help="GCP project for Vertex/OpenCode-Vertex")
    # The 3.x Gemini line serves only on the GLOBAL Vertex endpoint, so global is the
    # known-good default (a regional location 404s gemini-3.1-flash-lite).
    ap.add_argument("--location", default="global", help="Vertex location (default: global)")
    ap.add_argument("--out", help="write agentic-findings.json here")
    ap.add_argument("--explore-only", action="store_true",
                    help="agents read+reason+cross-verify only; per-target detonation is "
                         "deferred to the whole-repo forge detonation (which provides the "
                         "verified facts). Agent findings are honest inferences, not facts.")
    args = ap.parse_args(argv)

    # The vertex engine has no fallback, so it needs creds up front; opencode may run
    # without them (it only needs them IF it has to fall back to vertex).
    if args.engine == "vertex" and (not args.project or not args.location):
        ap.error("--engine vertex requires --project and --location")

    with open(args.graph, "r", encoding="utf-8") as fh:
        graph = json.load(fh)

    from agent_loop import SYSTEM_PROMPT
    base_system = SYSTEM_PROMPT

    # Build a per-lens model_call for the chosen engine. OpenCode is the mandated
    # brain; if it can't run (binary missing/not executable) we fall back at RUNTIME to
    # the proven Vertex-direct client (the design doc's documented fallback) so a scan
    # never fails on OpenCode being unavailable. The lens-specialized system prompt is
    # bound here (the loop passes the shared SYSTEM_PROMPT; we substitute the lens one).
    def make_model_call(lens: AgentLens):
        system = _system_for(base_system, lens)

        _vertex_cache: dict = {}
        def vertex_call(msgs, tools):
            if "fn" not in _vertex_cache:
                from vertex_client import make_vertex_model_call, LEAD_MODEL as V_LEAD
                if not args.project or not args.location:
                    # A regular Exception (NOT SystemExit/BaseException) so a worker
                    # thread degrades gracefully via _run_one and the run still writes
                    # an honest @2 record — never-blank. Missing-creds for the chosen
                    # engine is validated up front in main() below.
                    raise RuntimeError("vertex fallback needs --project/--location")
                _vertex_cache["fn"] = make_vertex_model_call(
                    project=args.project, location=args.location, model=V_LEAD)
            return _vertex_cache["fn"](system, msgs, tools)

        if args.engine == "vertex":
            return lambda sys_, msgs, tools: vertex_call(msgs, tools)

        from opencode_client import make_opencode_model_call, OpenCodeUnavailable, LEAD_MODEL as OC_LEAD
        oc = make_opencode_model_call(
            model=OC_LEAD, project=args.project, location=args.location,
            scratch_dir=f"/tmp/cr-oc-{args.name}-{lens.lens_id}")

        def opencode_then_vertex(sys_, msgs, tools):
            try:
                return oc(system, msgs, tools)
            except OpenCodeUnavailable as e:
                print(f"[agent] {lens.lens_id} opencode unavailable ({e}); vertex fallback",
                      file=sys.stderr, flush=True)
                return vertex_call(msgs, tools)
        return opencode_then_vertex

    gcloud_bin = shutil.which("gcloud") or "gcloud"

    # Explore-only: the per-target detonation relay is a no-op returning a valid EMPTY
    # observation, so detonate() succeeds with NO facts (the agent's finding is an honest
    # inference, fact_count 0) and the whole-repo forge detonation supplies the verified
    # runtime facts. The streamed `[agent] detonate` event still shows the agent's intent.
    def explore_only_relay(command: str) -> str:
        return '{"schema": "claude-rabbit/explore-only@1", "aggregate_observations": {}}'

    def ssh_exec(command: str) -> str:
        # Real intra-VPC relay into the sealed VM (mirrors agent_loop.main). Resilient:
        # a relay failure returns "" so the detonation records unexecuted and the pass
        # continues (never-blank); detonation validity is still enforced by detonator.py.
        try:
            proc = subprocess.run(
                [gcloud_bin, "compute", "ssh", _os.environ.get("CR_DET_VM", ""),
                 "--zone", _os.environ.get("CR_ZONE", ""), "--tunnel-through-iap",
                 "--command", command],
                capture_output=True, text=True, timeout=180,
            )
            if proc.stderr and proc.stderr.strip():
                print(f"[agent] ssh stderr: {proc.stderr.strip()[:800]!r}", file=sys.stderr, flush=True)
            return proc.stdout or ""
        except Exception as e:  # noqa: BLE001 — boundary: never propagate into the loop
            print(f"[agent] ssh_exec failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            return ""

    analysis = ParallelAnalysis(
        repo_dir=args.repo_dir, graph=graph, commit_sha=args.commit_sha, name=args.name,
        trap_ip=args.trap_ip, ssh_exec=(explore_only_relay if args.explore_only else ssh_exec),
        make_model_call=make_model_call, base_system=base_system,
        time_budget_s=args.time_budget_s, token_budget=args.token_budget,
        results_dir=args.results_dir, cage_duration_s=args.cage_duration_s,
        on_event=_emit_milestone,
    )
    print(f"[agent] launching THREE parallel agents ({args.engine}) over disjoint regions",
          file=sys.stderr, flush=True)
    try:
        result = analysis.run()
    except Exception as e:  # noqa: BLE001 — never-blank
        print(f"[agent] parallel analysis crashed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        result = {"schema": "claude-rabbit/agentic-findings@2", "name": args.name,
                  "crashed": f"{type(e).__name__}: {e}", "cross_verified_findings": [],
                  "dynamic_outcome": {"credentialReadObserved": False,
                                      "egressIntercepted": False, "autoBuildSucceeded": False}}
    out_path = args.out or _os.path.join(args.results_dir, f"{args.name}-agentic-findings.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
    # Final live line: closes the "Three agents read the code" stage in /api/deep.
    n_corr = result.get("corroborated_count", 0)
    n_total = len(result.get("cross_verified_findings", []))
    print(f"[agent] cross-verified: {n_corr} corroborated of {n_total} findings",
          file=sys.stderr, flush=True)
    print(json.dumps(result, indent=2))
    return 0


# --- module self-check (no SDK, no host) -------------------------------------

def _smoke() -> None:
    # Tiny smoke run with a deterministic fake model + fake relay, so the file is
    # runnable on its own as a sanity check (the real tests live in test_parallel_agents.py).
    demo_graph = {
        "files": [
            {"path": "postinstall.js", "reason": "lifecycle hook", "signals": ["installHook"]},
            {"path": "index.js", "reason": "entry", "signals": ["network"]},
            {"path": "loader.js", "reason": "obfuscation", "signals": ["eval", "base64"]},
        ],
        "hotspots": [{"path": "postinstall.js", "severity_hint": "high"}],
        "install_scripts": ["postinstall.js"],
        "summary": {"file_count": 3},
    }

    def fake_model(lens):
        def call(system, messages, tools):
            return {"text": f"[{lens.lens_id}] reviewing", "tool_calls": [], "usage": {"total_tokens": 10}}
        return call

    events: list[AgentEvent] = []
    pa = ParallelAnalysis(
        repo_dir=".", graph=demo_graph, commit_sha="deadbeef", name="demo", trap_ip="169.254.0.9",
        ssh_exec=lambda cmd: json.dumps({"aggregate_observations": {}, "_detonated": {}}),
        make_model_call=fake_model, base_system="SYS", time_budget_s=5, token_budget=300,
        results_dir="/tmp/cr-parallel-demo", on_event=events.append, now=time.monotonic,
    )
    out = pa.run()
    print(json.dumps({"agents": out["agents"], "events": len(events),
                      "cross": len(out["cross_verified_findings"]),
                      "outcome": out["dynamic_outcome"]}, indent=2))


if __name__ == "__main__":
    import sys
    # With CLI args, run the real three-agent analysis; with none, the offline smoke.
    if len(sys.argv) > 1:
        raise SystemExit(main(sys.argv[1:]))
    _smoke()
