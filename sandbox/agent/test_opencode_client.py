#!/usr/bin/env python3
"""
test_opencode_client.py — deterministic tests for the OpenCode model_call seam. The
subprocess `run` is injected with canned `opencode run` output, so the tests never
require the opencode binary, Vertex, or the network (audit: deterministic, offline).
"""
from __future__ import annotations

import subprocess
import unittest

from opencode_client import (
    OpenCodeUnavailable,
    _build_prompt,
    _parse_opencode_output,
    make_opencode_model_call,
)


class _Proc:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


class ParseTests(unittest.TestCase):
    def test_decision_json_on_last_line(self):
        out = (
            "Let me analyze this file.\n"
            "It reads ~/.aws/credentials then POSTs to an external host.\n"
            '{"text": "credential exfil suspected", "tool_calls": [{"name": "detonate", '
            '"args": {"runtime": "node", "target": "index.js"}}]}'
        )
        r = _parse_opencode_output(out)
        self.assertEqual(r["text"], "credential exfil suspected")
        self.assertEqual(r["tool_calls"], [{"name": "detonate", "args": {"runtime": "node", "target": "index.js"}}])

    def test_multiline_json_blob(self):
        out = 'Reasoning...\n{\n  "text": "looks fine",\n  "tool_calls": []\n}\n'
        r = _parse_opencode_output(out)
        self.assertEqual(r["text"], "looks fine")
        self.assertEqual(r["tool_calls"], [])

    def test_tool_calls_normalized(self):
        # Missing/!dict args coerced to {}, non-dict tool entries dropped.
        out = '{"text": "x", "tool_calls": [{"name": "grep"}, "junk", {"name": "graph_query", "args": null}]}'
        r = _parse_opencode_output(out)
        self.assertEqual(r["tool_calls"], [{"name": "grep", "args": {}}, {"name": "graph_query", "args": {}}])

    def test_usage_extracted(self):
        out = '{"text": "x", "tool_calls": [], "usage": {"total_tokens": 1234}}'
        self.assertEqual(_parse_opencode_output(out)["usage"], {"total_tokens": 1234})

    def test_unparseable_raises(self):
        with self.assertRaises(OpenCodeUnavailable):
            _parse_opencode_output("just prose, no json at all")

    def test_json_without_contract_keys_raises(self):
        # A JSON object that isn't a decision (no text/tool_calls) is not accepted.
        with self.assertRaises(OpenCodeUnavailable):
            _parse_opencode_output('{"something": "else"}')


class PromptTests(unittest.TestCase):
    def test_prompt_preserves_system_and_fenced_content(self):
        system = "FIXED RULES"
        fenced = "<<<CR_UNTRUSTED_DATA_BEGIN>>>\nevil()\n<<<CR_UNTRUSTED_DATA_END>>>"
        prompt = _build_prompt(system, [{"role": "user", "content": fenced}])
        self.assertIn("FIXED RULES", prompt)
        self.assertIn(fenced, prompt)                    # C3 fence preserved verbatim
        self.assertIn("Valid tool names", prompt)        # decision instruction present


class ModelCallTests(unittest.TestCase):
    def test_drop_in_model_call_contract(self):
        captured = {}
        def fake_run(argv, **kw):
            captured["argv"] = argv
            captured["cwd"] = kw.get("cwd")
            return _Proc(stdout='thinking\n{"text": "ok", "tool_calls": []}')
        call = make_opencode_model_call(model="google-vertex/gemini-3.1-flash-lite",
                                        project="p", location="us-central1",
                                        scratch_dir="/tmp/cr-oc-test", run=fake_run)
        resp = call("SYS", [{"role": "user", "content": "hi"}], [])
        self.assertEqual(resp, {"text": "ok", "tool_calls": [], "usage": {"total_tokens": 0}})
        # Invoked the real `opencode run` shape, pinned model, in the scratch dir.
        self.assertEqual(captured["argv"][:4], ["opencode", "run", "--model", "google-vertex/gemini-3.1-flash-lite"])
        self.assertEqual(captured["cwd"], "/tmp/cr-oc-test")

    def test_missing_binary_raises_unavailable(self):
        def fake_run(argv, **kw):
            raise FileNotFoundError("opencode")
        call = make_opencode_model_call(scratch_dir="/tmp/cr-oc-test2", run=fake_run)
        with self.assertRaises(OpenCodeUnavailable):
            call("SYS", [{"role": "user", "content": "hi"}], [])

    def test_timeout_raises_unavailable(self):
        def fake_run(argv, **kw):
            raise subprocess.TimeoutExpired(cmd=argv, timeout=1)
        call = make_opencode_model_call(scratch_dir="/tmp/cr-oc-test3", run=fake_run)
        with self.assertRaises(OpenCodeUnavailable):
            call("SYS", [{"role": "user", "content": "hi"}], [])

    def test_nonzero_rc_with_empty_stdout_raises(self):
        def fake_run(argv, **kw):
            return _Proc(stdout="", stderr="provider error", returncode=1)
        call = make_opencode_model_call(scratch_dir="/tmp/cr-oc-test4", run=fake_run)
        with self.assertRaises(OpenCodeUnavailable):
            call("SYS", [{"role": "user", "content": "hi"}], [])

    def test_drives_a_real_agentloop_turn(self):
        # The OpenCode-backed model_call must satisfy the AgentLoop's expectations:
        # plug it into a one-file loop and confirm a finding is recorded.
        from agent_loop import AgentLoop
        def fake_run(argv, **kw):
            return _Proc(stdout='{"text": "reviewed; benign", "tool_calls": []}')
        model_call = make_opencode_model_call(scratch_dir="/tmp/cr-oc-test5", run=fake_run)
        graph = {"files": [{"path": "a.txt"}], "hotspots": [{"path": "a.txt", "severity_hint": "low"}],
                 "install_scripts": [], "summary": {}}
        loop = AgentLoop(repo_dir=".", graph=graph, commit_sha="sha", name="oc",
                         trap_ip="169.254.0.9", ssh_exec=lambda c: "{}",
                         model_call=model_call, time_budget_s=10, token_budget=500,
                         results_dir="/tmp/cr-oc-loop")
        result = loop.run()
        self.assertEqual(len(result["findings"]), 1)
        self.assertEqual(result["findings"][0]["target"], "a.txt")
        self.assertIn("benign", result["findings"][0]["inference"])


if __name__ == "__main__":
    unittest.main()
