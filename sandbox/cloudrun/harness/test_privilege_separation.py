#!/usr/bin/env python3
"""
test_privilege_separation.py — regression tests for the sandbox privilege-separation
fixes (security review criticals #1/#2/#3):

  #1  detonate._untrusted_env() must STRIP every harness secret (the Vertex SA
      credential, the attach-forensics runner key, the forge control key, this scan's
      id) from the environment handed to the untrusted build/run, while KEEPING what a
      normal build needs (PATH, HOME, the forged-TLS CA bundle, locale).

  #2/#3  forensics_api.key_authorized() must reject a caller with no / wrong control key
         once one is configured, and allow (rollout-safe) only when none is configured.

Run: python3 sandbox/cloudrun/harness/test_privilege_separation.py   (exit 0 = all pass)
"""
from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FORGE = os.path.abspath(os.path.join(HERE, "..", "forge"))

_fails: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        _fails.append(name)
        print(f"  FAIL  {name}  {detail}")


def _load(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


# ── #1: untrusted env scrub ──────────────────────────────────────────────────
# Seed the environment with the exact secrets the harness carries + benign build vars,
# THEN import detonate so its os.environ snapshot sees them.
os.environ.update({
    "GOOGLE_APPLICATION_CREDENTIALS": "/tmp/cr-sa-key.json",
    "GOOGLE_SERVICE_ACCOUNT_JSON": '{"private_key":"SECRET"}',
    "CR_DEEP_RUNNER_KEY": "runner-secret",
    "CR_FORGE_CONTROL_KEY": "forge-secret",
    "CR_SCAN_ID": "scan-123",
    "CR_SUPABASE_URL": "https://x.supabase.co",
    "AWS_SECRET_ACCESS_KEY": "aws-secret",
    "GH_TOKEN": "gh-secret",
    # benign build vars that MUST survive:
    "PATH": "/usr/bin:/bin",
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
    "REQUESTS_CA_BUNDLE": "/etc/ssl/certs/ca-certificates.crt",
    "NODE_EXTRA_CA_CERTS": "/etc/ssl/certs/ca-certificates.crt",
})
detonate = _load(os.path.join(HERE, "detonate.py"), "cr_detonate")
env = detonate._untrusted_env()

for secret in [
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SERVICE_ACCOUNT_JSON", "CR_DEEP_RUNNER_KEY",
    "CR_FORGE_CONTROL_KEY", "CR_SCAN_ID", "CR_SUPABASE_URL", "AWS_SECRET_ACCESS_KEY", "GH_TOKEN",
]:
    check(f"untrusted env STRIPS {secret}", secret not in env, f"leaked: {env.get(secret)!r}")

for keep in ["PATH", "HOME", "LANG", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]:
    check(f"untrusted env KEEPS benign {keep}", keep in env, "was stripped")

check("no secret value survives anywhere in the scrubbed env",
      not any(v in ("runner-secret", "forge-secret", "aws-secret", "gh-secret", "scan-123") for v in env.values()))

# _untrusted_user default is None (uid separation is opt-in, off by default).
os.environ.pop("CR_UNTRUSTED_USER", None)
check("uid separation is OFF by default (no live-detonation regression)", detonate._untrusted_user() is None)
os.environ["CR_UNTRUSTED_USER"] = "cruntrusted"
check("uid separation activates when CR_UNTRUSTED_USER is set", detonate._untrusted_user() == "cruntrusted")
os.environ.pop("CR_UNTRUSTED_USER", None)

# ── #2/#3: forge control-plane auth ──────────────────────────────────────────
forge = _load(os.path.join(FORGE, "forensics_api.py"), "cr_forensics_api")
ka = forge.key_authorized
check("configured key: correct header authorizes", ka("forge-secret", "forge-secret") is True)
check("configured key: wrong header is REJECTED", ka("wrong", "forge-secret") is False)
check("configured key: missing header is REJECTED", ka("", "forge-secret") is False)
check("unconfigured key: allowed (rollout-safe)", ka("", "") is True)
check("unconfigured key: allowed even with a header", ka("anything", "") is True)

if _fails:
    print(f"\n{len(_fails)} test(s) FAILED")
    sys.exit(1)
print("\nAll privilege-separation tests passed")
sys.exit(0)
