#!/usr/bin/env python3
"""
test_parallel_agents.py — deterministic, no-SDK, no-host tests for the three-parallel-
agent orchestrator + cross-verification. Mocks the model_call and ssh_exec, so the
tests never touch Vertex/OpenCode/the GCP host (audit: deterministic, offline).
"""
from __future__ import annotations

import json
import unittest

from parallel_agents import (
    LENSES,
    AgentEvent,
    ParallelAnalysis,
    partition_graph,
)


def _fake_make_model(record=None):
    """A model_call factory whose calls emit a tiny narrative and no tool calls."""
    def make(lens):
        def call(system, messages, tools):
            if record is not None:
                record.append(lens.lens_id)
            return {"text": f"[{lens.lens_id}] reviewed", "tool_calls": [], "usage": {"total_tokens": 5}}
        return call
    return make


def _fake_ssh(_cmd):
    # A relay that returns an empty-but-valid observation (no malice observed).
    return json.dumps({"aggregate_observations": {}, "_detonated": {}})


def _counter_now():
    n = {"v": 0.0}
    def now():
        n["v"] += 1.0
        return n["v"]
    return now


class PartitionTests(unittest.TestCase):
    def test_partition_is_disjoint_and_complete(self):
        graph = {
            "files": [
                {"path": "postinstall.js", "reason": "lifecycle hook", "signals": ["installHook"]},
                {"path": "src/index.js", "reason": "entry", "signals": ["network"]},
                {"path": "vendor/loader.js", "reason": "obfuscation", "signals": ["eval", "base64"]},
                {"path": "README.md"},  # zero-affinity → round-robin, must still land somewhere
            ],
            "hotspots": [{"path": "postinstall.js", "severity_hint": "high"}],
            "install_scripts": ["postinstall.js"],
            "summary": {"file_count": 4},
        }
        parts = partition_graph(graph)
        # Exactly the three lenses.
        self.assertEqual(set(parts.keys()), {l.lens_id for l in LENSES})
        # Every file assigned to exactly one lens (disjoint + complete).
        assigned = [f["path"] for p in parts.values() for f in p["files"]]
        self.assertEqual(sorted(assigned), ["README.md", "postinstall.js", "src/index.js", "vendor/loader.js"])
        self.assertEqual(len(assigned), len(set(assigned)), "a file landed in two partitions")
        # Affinity routing: install hook → install lens, obfuscation → payload lens.
        self.assertIn("postinstall.js", [f["path"] for f in parts["install"]["files"]])
        self.assertIn("vendor/loader.js", [f["path"] for f in parts["payload"]["files"]])
        # The install_scripts ride along to the install lens.
        self.assertEqual(parts["install"]["install_scripts"], ["postinstall.js"])

    def test_allowed_targets_are_disjoint_subsets(self):
        # Each agent's graph["files"] becomes its allowed_targets — so the union equals
        # the whole repo and the intersection is empty (no double-detonation possible).
        graph = {"files": [{"path": f"f{i}.py", "signals": []} for i in range(9)],
                 "hotspots": [], "install_scripts": [], "summary": {}}
        parts = partition_graph(graph)
        sets = [set(f["path"] for f in p["files"]) for p in parts.values()]
        union = set().union(*sets)
        self.assertEqual(union, {f"f{i}.py" for i in range(9)})
        for i in range(len(sets)):
            for j in range(i + 1, len(sets)):
                self.assertEqual(sets[i] & sets[j], set(), "partitions overlap")


class ParallelRunTests(unittest.TestCase):
    def _graph(self):
        # Non-detonable (.txt) hotspots so the orchestration is exercised without
        # driving the detonator relay — keeps the test about the parallel machinery.
        return {
            "files": [
                {"path": "install_notes.txt", "reason": "install", "signals": []},
                {"path": "runtime_notes.txt", "reason": "fetch network", "signals": []},
                {"path": "payload_notes.txt", "reason": "eval base64", "signals": []},
            ],
            "hotspots": [
                {"path": "install_notes.txt", "severity_hint": "high"},
                {"path": "runtime_notes.txt", "severity_hint": "med"},
                {"path": "payload_notes.txt", "severity_hint": "low"},
            ],
            "install_scripts": [],
            "summary": {"file_count": 3},
        }

    def test_three_agents_run_and_stream_live(self):
        events: list[AgentEvent] = []
        seen_lenses: list[str] = []
        pa = ParallelAnalysis(
            repo_dir=".", graph=self._graph(), commit_sha="sha1", name="t", trap_ip="169.254.0.9",
            ssh_exec=_fake_ssh, make_model_call=_fake_make_model(seen_lenses), base_system="SYS",
            time_budget_s=10, token_budget=900, results_dir="/tmp/cr-pa-test1",
            on_event=events.append, now=_counter_now(),
        )
        out = pa.run()
        # Exactly three agents ran.
        self.assertEqual(len(out["agents"]), 3)
        self.assertEqual({a["lens"] for a in out["agents"]}, {l.lens_id for l in LENSES})
        # All three were actually invoked (the model factory recorded each lens).
        self.assertEqual(set(seen_lenses), {l.lens_id for l in LENSES})
        # Live stream: every agent emitted a 'start' and a 'done' event.
        kinds_by_lens = {}
        for ev in events:
            kinds_by_lens.setdefault(ev.agent_id, set()).add(ev.kind)
        for l in LENSES:
            self.assertIn("start", kinds_by_lens.get(l.lens_id, set()))
            self.assertIn("done", kinds_by_lens.get(l.lens_id, set()))
        # The schema is the @2 cross-verified record.
        self.assertEqual(out["schema"], "claude-rabbit/agentic-findings@2")
        self.assertEqual(out["mode"], "three-parallel-cross-verified")

    def test_one_agent_crash_is_isolated(self):
        # A model factory where ONLY the runtime lens raises — the other two must still
        # finish and produce results (never-blank).
        def make(lens):
            def call(system, messages, tools):
                if lens.lens_id == "runtime":
                    raise RuntimeError("boom")
                return {"text": "ok", "tool_calls": [], "usage": {"total_tokens": 1}}
            return call
        pa = ParallelAnalysis(
            repo_dir=".", graph=self._graph(), commit_sha="sha2", name="t2", trap_ip="169.254.0.9",
            ssh_exec=_fake_ssh, make_model_call=make, base_system="SYS",
            time_budget_s=10, token_budget=900, results_dir="/tmp/cr-pa-test2", now=_counter_now(),
        )
        out = pa.run()
        self.assertEqual(len(out["agents"]), 3)  # all three accounted for
        reasons = {a["lens"]: a["stopped_reason"] for a in out["agents"]}
        self.assertTrue(str(reasons["runtime"]).startswith("crashed"))
        # The other two drained normally.
        self.assertEqual(reasons["install"], "work_list_drained")
        self.assertEqual(reasons["payload"], "work_list_drained")


class CrossVerifyTests(unittest.TestCase):
    def _pa(self):
        return ParallelAnalysis(
            repo_dir=".", graph={"files": [], "hotspots": [], "install_scripts": [], "summary": {}},
            commit_sha="sha", name="cv", trap_ip="169.254.0.9", ssh_exec=_fake_ssh,
            make_model_call=_fake_make_model(), base_system="SYS", time_budget_s=5,
            token_budget=300, results_dir="/tmp/cr-pa-cv", now=_counter_now(),
        )

    def test_corroboration_and_ranking(self):
        # target A: flagged by 2 lenses (corroborated, no facts).
        # target B: flagged by 1 lens but fact-backed (corroborated + fact_backed, ranked first).
        # target C: flagged by 1 lens, no facts (NOT corroborated).
        results = {
            "install": {"findings": [
                {"target": "A", "inference": "i1", "fact_count": 0, "facts": [], "severity_hint": "med"},
                {"target": "C", "inference": "i3", "fact_count": 0, "facts": []},
            ], "detonated_targets": ["A", "C"], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": False, "egressIntercepted": False, "autoBuildSucceeded": True}},
            "runtime": {"findings": [
                {"target": "A", "inference": "i2", "fact_count": 0, "facts": []},
                {"target": "B", "inference": "ib", "fact_count": 1,
                 "facts": [{"source": "observation", "field": "high_value_cred_read_succeeded", "value": 1}]},
            ], "detonated_targets": ["A", "B"], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": True, "egressIntercepted": False, "autoBuildSucceeded": False}},
            "payload": {"findings": [], "detonated_targets": [], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": False, "egressIntercepted": True, "autoBuildSucceeded": False}},
        }
        out = self._pa()._cross_verify(results)
        cross = {c["target"]: c for c in out["cross_verified_findings"]}
        self.assertTrue(cross["A"]["corroborated"])      # 2 lenses
        self.assertFalse(cross["A"]["fact_backed"])
        self.assertTrue(cross["B"]["corroborated"])       # fact-backed
        self.assertTrue(cross["B"]["fact_backed"])
        self.assertFalse(cross["C"]["corroborated"])      # single lens, no facts
        # Fact-backed B ranks first.
        self.assertEqual(out["cross_verified_findings"][0]["target"], "B")
        self.assertEqual(out["corroborated_count"], 2)
        # Detonated union across all three.
        self.assertEqual(out["detonated_targets"], ["A", "B", "C"])

    def test_dynamic_outcome_is_unioned(self):
        # cred-read seen by runtime; egress seen by payload; build by install → all True.
        results = {
            "install": {"findings": [], "detonated_targets": [], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": False, "egressIntercepted": False, "autoBuildSucceeded": True}},
            "runtime": {"findings": [], "detonated_targets": [], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": True, "egressIntercepted": False, "autoBuildSucceeded": False}},
            "payload": {"findings": [], "detonated_targets": [], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": False, "egressIntercepted": True, "autoBuildSucceeded": False}},
        }
        out = self._pa()._cross_verify(results)
        self.assertEqual(out["dynamic_outcome"], {
            "credentialReadObserved": True, "egressIntercepted": True, "autoBuildSucceeded": True})

    def test_cross_verify_never_invents_facts(self):
        # An inference-only finding (no observation) stays fact_count 0 — cross-verify
        # cannot promote it to fact-backed (C5).
        results = {
            "install": {"findings": [{"target": "X", "inference": "looks bad", "fact_count": 0, "facts": []}],
                "detonated_targets": [], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": False, "egressIntercepted": False, "autoBuildSucceeded": False}},
            "runtime": {"findings": [], "detonated_targets": [], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": False, "egressIntercepted": False, "autoBuildSucceeded": False}},
            "payload": {"findings": [], "detonated_targets": [], "not_verified": [],
                "dynamic_outcome": {"credentialReadObserved": False, "egressIntercepted": False, "autoBuildSucceeded": False}},
        }
        out = self._pa()._cross_verify(results)
        x = out["cross_verified_findings"][0]
        self.assertEqual(x["target"], "X")
        self.assertFalse(x["fact_backed"])
        self.assertEqual(x["fact_count"], 0)


if __name__ == "__main__":
    unittest.main()
