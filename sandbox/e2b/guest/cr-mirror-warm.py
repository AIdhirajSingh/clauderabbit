#!/usr/bin/env python3
"""Warm the package mirror at template build time (DESIGN.md section 3.1).

Usage: cr-mirror-warm.py <mirror-seed.json>

Every seed entry goes through the same forge_core code path the detonation
forge uses: fetch the metadata, require that the registry publishes exactly the
pinned digest, fetch the blob, verify it, store it content-addressed. Any
mismatch or fetch failure fails the template build.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, "/opt/cr/forge")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forge_core as fc  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: cr-mirror-warm.py <mirror-seed.json>", file=sys.stderr)
        return 2
    policy = fc.load_policy(os.environ.get("CR_FORGE_POLICY", "/opt/cr/forge/policy.json"))
    with open(argv[1], "r", encoding="utf-8") as f:
        seed = json.load(f)
    forge = fc.Forge(policy, fc.Mirror(policy["mirror_root"]), fc.urllib_fetcher(60.0, int(policy.get("upstream_max_bytes", 104857600))))
    failures: list[str] = []
    stored = 0

    for e in seed.get("npm", []):
        name, version, pinned, tarball = e["name"], e["version"], e["integrity"], e["tarball"]
        meta = forge.handle(fc.Request("GET", "registry.npmjs.org", 443, "/" + name.replace("/", "%2f"), {"accept": "application/json"}))
        if meta.status != 200:
            failures.append(f"npm {name}: packument HTTP {meta.status}")
            continue
        published = forge.digests.get(tarball)
        if published != pinned:
            failures.append(f"npm {name}@{version}: registry publishes {published}, seed pins {pinned}")
            continue
        path = tarball.split("registry.npmjs.org", 1)[1]
        blob = forge.handle(fc.Request("GET", "registry.npmjs.org", 443, path, {}))
        if blob.status != 200 or blob.integrity != "verified" or not fc.sri_matches(blob.body, pinned):
            failures.append(f"npm {name}@{version}: tarball HTTP {blob.status} integrity {blob.integrity}")
            continue
        stored += 1

    for e in seed.get("pypi", []):
        name, version, url, sha = e["name"], e["version"], e["url"], e["sha256"]
        idx = forge.handle(fc.Request("GET", "pypi.org", 443, f"/simple/{fc.normalize_pypi_name(name)}/", {"accept": "application/vnd.pypi.simple.v1+json"}))
        if idx.status != 200:
            failures.append(f"pypi {name}: index HTTP {idx.status}")
            continue
        pinned = fc.hex_to_sri("sha256", sha)
        if forge.digests.get(url) != pinned:
            failures.append(f"pypi {name}=={version}: index publishes {forge.digests.get(url)}, seed pins {pinned}")
            continue
        blob = forge.handle(fc.Request("GET", "files.pythonhosted.org", 443, url.split("files.pythonhosted.org", 1)[1], {}))
        if blob.status != 200 or blob.integrity != "verified" or not fc.sri_matches(blob.body, pinned):
            failures.append(f"pypi {name}=={version}: file HTTP {blob.status} integrity {blob.integrity}")
            continue
        stored += 1

    print(json.dumps({"stored": stored, "failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
