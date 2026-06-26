#!/usr/bin/env python3
"""
test_knowledge_graph.py — proves the knowledge graph surfaces what a
flagged-region-only scan would miss.

Runs build_graph() against the EXISTING synthetic fixtures in sandbox/fixtures/
and asserts the buried malicious files rank HIGH in `hotspots`, the benign
fixture stays low, and the structural extraction (install scripts, manifests,
import edges) is correct. stdlib unittest only.

Run: python sandbox/agent/test_knowledge_graph.py

Note on the miner fixture: a crypto-miner's malice is RUNTIME behavior (CPU burn
+ a beacon to a plain hostname). The existing static-scan pattern set — which we
deliberately do NOT fork (audit rule M3) — does not flag a bare hostname or a
hash loop, so static signals alone cannot separate the miner from benign code.
The graph still elevates the miner's index.js as the top node in its repo (entry
point), and catching the miner is precisely the job of the dynamic detonation
sandbox the graph feeds. The tests below assert what the graph legitimately
proves and document that boundary rather than pretending static catches it.
"""
from __future__ import annotations

import shutil
import unittest
from pathlib import Path

# Import the module under test (same directory).
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from knowledge_graph import build_graph  # noqa: E402

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
DENO_AVAILABLE = shutil.which("deno") is not None


def _hotspot_for(graph: dict, path: str) -> dict | None:
    for h in graph["hotspots"]:
        if h["path"] == path:
            return h
    return None


def _rank_of(graph: dict, path: str) -> int | None:
    """1-based rank of `path` in the (already sorted) hotspots list."""
    for i, h in enumerate(graph["hotspots"]):
        if h["path"] == path:
            return i + 1
    return None


class CredStealerTests(unittest.TestCase):
    """The malice is buried in scripts/postinstall.js — a stage-1 flagged-region
    scan over a few top-level files might never read it."""

    @classmethod
    def setUpClass(cls):
        cls.graph = build_graph(FIXTURES / "cred-stealer")

    def test_buried_postinstall_is_top_hotspot(self):
        rank = _rank_of(self.graph, "scripts/postinstall.js")
        self.assertEqual(rank, 1, "buried postinstall.js must be the #1 hotspot")

    def test_postinstall_has_high_suspicion_and_severity(self):
        h = _hotspot_for(self.graph, "scripts/postinstall.js")
        self.assertIsNotNone(h)
        self.assertEqual(h["severity_hint"], "high")
        self.assertGreaterEqual(h["suspicion"], 80)

    def test_real_static_signals_present(self):
        h = _hotspot_for(self.graph, "scripts/postinstall.js")
        self.assertIn("signal:obfuscation", h["reasons"])
        self.assertIn("signal:credAccess", h["reasons"])

    def test_postinstall_ranks_far_above_benign_entrypoint(self):
        buried = _hotspot_for(self.graph, "scripts/postinstall.js")
        entry = _hotspot_for(self.graph, "index.js")
        self.assertIsNotNone(entry)
        self.assertGreater(buried["suspicion"], entry["suspicion"] * 5)

    def test_install_script_detected(self):
        paths = [s["path"] for s in self.graph["install_scripts"]]
        self.assertIn("scripts/postinstall.js", paths)

    def test_manifest_install_hook_detected(self):
        pkg = next(m for m in self.graph["manifests"] if m["type"] == "package.json")
        self.assertIn("postinstall", pkg["install_scripts"])

    def test_edges_non_empty(self):
        # postinstall.js requires fs/os/path/https — external edges.
        self.assertTrue(self.graph["edges"])
        specs = {e["spec"] for e in self.graph["edges"]}
        self.assertIn("https", specs)


class ExfilC2Tests(unittest.TestCase):
    """The exfil logic lives in index.js (credential reads + C2 POST)."""

    @classmethod
    def setUpClass(cls):
        cls.graph = build_graph(FIXTURES / "exfil-c2")

    def test_index_is_top_hotspot(self):
        self.assertEqual(_rank_of(self.graph, "index.js"), 1)

    def test_index_high_severity_cred_access(self):
        h = _hotspot_for(self.graph, "index.js")
        self.assertIsNotNone(h)
        self.assertEqual(h["severity_hint"], "high")
        self.assertIn("signal:credAccess", h["reasons"])
        self.assertGreaterEqual(h["suspicion"], 40)

    def test_manifest_detected(self):
        types = {m["type"] for m in self.graph["manifests"]}
        self.assertIn("package.json", types)

    def test_edges_non_empty(self):
        specs = {e["spec"] for e in self.graph["edges"]}
        # index.js requires fs/os/path/https/dns.
        self.assertIn("dns", specs)


class MinerTests(unittest.TestCase):
    """The miner's index.js is RUNTIME-malicious (CPU burn + beacon). Static
    signals can't separate it from benign code; the graph still elevates it as
    the top node in its own repo so the dynamic sandbox detonates it."""

    @classmethod
    def setUpClass(cls):
        cls.graph = build_graph(FIXTURES / "miner")

    def test_index_is_top_hotspot_of_repo(self):
        self.assertEqual(_rank_of(self.graph, "index.js"), 1)

    def test_index_flagged_as_entry_point(self):
        h = _hotspot_for(self.graph, "index.js")
        self.assertIsNotNone(h)
        self.assertIn("entry-point", h["reasons"])

    def test_manifest_detected(self):
        types = {m["type"] for m in self.graph["manifests"]}
        self.assertIn("package.json", types)


class BenignDepsTests(unittest.TestCase):
    """The benign fixture must stay LOW: no high hotspot, low max suspicion."""

    @classmethod
    def setUpClass(cls):
        cls.graph = build_graph(FIXTURES / "benign-deps")

    def test_low_max_suspicion(self):
        # Only structural (entry-point) signal — no static danger signal.
        self.assertLessEqual(self.graph["summary"]["max_suspicion"], 15)

    def test_no_high_severity_hotspot(self):
        for h in self.graph["hotspots"]:
            self.assertNotEqual(h["severity_hint"], "high",
                                f"{h['path']} should not be high-severity")

    def test_no_danger_signal_in_reasons(self):
        for h in self.graph["hotspots"]:
            for r in h["reasons"]:
                self.assertFalse(r.startswith("signal:"),
                                 f"benign fixture flagged a static signal: {r}")

    def test_declared_dependency_parsed(self):
        pkg = next(m for m in self.graph["manifests"] if m["type"] == "package.json")
        self.assertIn("leftpad", pkg["deps"])


class CrossFixtureTests(unittest.TestCase):
    """The headline property: buried/malicious fixtures out-rank the benign one."""

    @classmethod
    def setUpClass(cls):
        cls.cred = build_graph(FIXTURES / "cred-stealer")
        cls.exfil = build_graph(FIXTURES / "exfil-c2")
        cls.benign = build_graph(FIXTURES / "benign-deps")

    def test_malicious_repos_outrank_benign(self):
        benign_max = self.benign["summary"]["max_suspicion"]
        self.assertGreater(self.cred["summary"]["max_suspicion"], benign_max * 3)
        self.assertGreater(self.exfil["summary"]["max_suspicion"], benign_max * 3)

    @unittest.skipUnless(DENO_AVAILABLE, "deno not on PATH")
    def test_static_scan_actually_ran(self):
        # Proves we used the REAL scanner, not just structure.
        self.assertTrue(self.cred["summary"]["static_scan_ran"])
        self.assertIsNone(self.cred["summary"]["static_scan_note"])


class StructureTests(unittest.TestCase):
    """Graph hygiene: bounds, noise handling, no crash on the fixture set."""

    def test_graph_shape(self):
        g = build_graph(FIXTURES / "cred-stealer")
        for key in ("summary", "files", "edges", "manifests",
                    "install_scripts", "hotspots"):
            self.assertIn(key, g)

    def test_files_indexed(self):
        g = build_graph(FIXTURES / "cred-stealer")
        paths = {f["path"] for f in g["files"]}
        self.assertIn("scripts/postinstall.js", paths)
        self.assertIn("index.js", paths)
        self.assertIn("package.json", paths)


if __name__ == "__main__":
    unittest.main(verbosity=2)
