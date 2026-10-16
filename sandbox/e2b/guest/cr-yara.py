#!/usr/bin/env python3
"""Run the YARA rules in /opt/cr/rules/yara over an extracted tree with yara-x.

Usage: cr-yara.py <rules_dir> <scan_root>

Prints one JSON document on stdout (the contract parsed by
lib/engine/static/scanners.ts parseCrYara):
  { "matches": [ { "rule", "namespace", "path", "line", "tags", "meta": { "severity", "description" } } ],
    "errors": [ str ] }
Runs inside the analysis sandbox, which has no network and never runs repo code.
"""

from __future__ import annotations

import json
import os
import sys

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_MATCHES = 2000


def line_of(data: bytes, offset: int) -> int:
    return data.count(b"\n", 0, max(0, offset)) + 1


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(json.dumps({"matches": [], "errors": ["usage: cr-yara.py <rules_dir> <scan_root>"]}))
        return 2
    rules_dir, root = argv[1], argv[2]
    errors: list[str] = []
    matches: list[dict] = []
    try:
        import yara_x  # pinned yara-x==1.21.0 in the template
    except ImportError as e:
        print(json.dumps({"matches": [], "errors": [f"yara_x import failed: {e}"]}))
        return 1

    compiler = yara_x.Compiler()
    loaded = 0
    for name in sorted(os.listdir(rules_dir)):
        if not name.endswith(".yar"):
            continue
        with open(os.path.join(rules_dir, name), "r", encoding="utf-8") as f:
            source = f.read()
        compiler.new_namespace(name[:-4])
        try:
            compiler.add_source(source)
            loaded += 1
        except Exception as e:  # noqa: BLE001 (a bad rule file is reported, the rest still run)
            errors.append(f"{name}: {e}")
    if loaded == 0:
        print(json.dumps({"matches": [], "errors": errors + ["no YARA rules compiled"]}))
        return 1
    rules = compiler.build()

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
        for fn in filenames:
            path = os.path.join(dirpath, fn)
            if os.path.islink(path) or not os.path.isfile(path):
                continue
            try:
                if os.path.getsize(path) > MAX_FILE_BYTES:
                    continue
                with open(path, "rb") as f:
                    data = f.read()
                result = rules.scan(data)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{os.path.relpath(path, root)}: {e}")
                continue
            for rule in result.matching_rules:
                meta = {str(k): v for k, v in rule.metadata}
                first = None
                for pattern in rule.patterns:
                    for m in pattern.matches:
                        if first is None or m.offset < first:
                            first = m.offset
                sev = str(meta.get("severity", "medium")).lower()
                matches.append({
                    "rule": rule.identifier,
                    "namespace": rule.namespace,
                    "path": path,
                    "line": line_of(data, first) if first is not None else None,
                    "tags": list(rule.tags),
                    "meta": {
                        "severity": sev if sev in ("high", "medium", "low") else "medium",
                        "description": str(meta.get("description", ""))[:300],
                    },
                })
                if len(matches) >= MAX_MATCHES:
                    errors.append(f"match cap {MAX_MATCHES} reached")
                    print(json.dumps({"matches": matches, "errors": errors}))
                    return 0
    print(json.dumps({"matches": matches, "errors": errors}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
