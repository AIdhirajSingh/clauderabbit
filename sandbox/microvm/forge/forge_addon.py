#!/usr/bin/env python3
"""
forge_addon.py — the deceptive forging egress (replaces the old sinkhole).

Loaded into mitmproxy running in transparent mode on the host, in front of the
detonation microVM's only network path. Where the old sinkhole merely TERMINATED a
connection and recorded the doomed first knock (so condition-gated malware went
dormant and scored falsely clean), this FORGES a successful answer as if the real
destination replied — so the sample's next condition unlocks and it runs its full
real behavior (drops payload, reads the planted decoy creds, attempts the real
action) on a stage we fully control and record. No real packet ever leaves the host.

mitmproxy itself handles the TLS forge: in transparent mode it mints a per-SNI leaf
on the fly under the local CA (pre-baked into the guest rootfs trust store), so a
NON-pinning TLS client completes the handshake and reveals its plaintext payload.
This addon supplies the forged application response + captures the whole conversation.

Registry traffic (npm/PyPI/...) is NOT handled here — mitmproxy's `--ignore-hosts`
passes those through untouched to the real upstream (their own cert checks intact),
logged separately. This addon only forges the rest.

HONEST LIMITS (surfaced, never overclaimed): a forge cannot defeat certificate
pinning, mTLS, or custom-crypto C2. Those connections abort instead of revealing
plaintext; that abort is itself a reportable signal (see the connection hook), never
a false clean.

Env:
  CR_FORGE_CAPTURE  capture JSONL path (default /var/log/cr-forge/capture.jsonl)
  CR_FORGE_MAXBODY  max request/response body bytes captured (default 65536)
"""
from __future__ import annotations

import base64
import json
import os
import time
from typing import Any

from mitmproxy import http, tls

CAPTURE_PATH = os.environ.get("CR_FORGE_CAPTURE", "/var/log/cr-forge/capture.jsonl")
MAX_BODY = int(os.environ.get("CR_FORGE_MAXBODY", "65536"))


def _b64(raw: bytes | None) -> str:
    if not raw:
        return ""
    return base64.b64encode(raw[:MAX_BODY]).decode("ascii")


def _emit(record: dict[str, Any]) -> None:
    """Append one forensic record. The capture is the evidence — every claim in the
    report traces back to a line here, never a template."""
    os.makedirs(os.path.dirname(CAPTURE_PATH), exist_ok=True)
    record["t"] = round(time.time(), 3)
    with open(CAPTURE_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


class Forge:
    """Forge a plausible success for every intercepted flow + capture it."""

    def request(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        # The INTENDED destination: prefer the TLS SNI / Host header (the real C2 name),
        # not the forge IP the client actually connected to. pretty_host is the Host
        # header when present; client_conn.sni is the TLS name for https flows.
        sni = getattr(flow.client_conn, "sni", None)
        intended = sni or req.pretty_host or req.host
        _emit(
            {
                "kind": "http_request",
                "scheme": req.scheme,
                "host": intended,          # the INTENDED destination (real C2 / exfil target)
                "sni": sni,
                "connected_ip": req.host,  # what it actually connected to (the forge)
                "port": req.port,
                "method": req.method,
                "path": req.path,
                "http_version": req.http_version,
                "headers": dict(req.headers),
                "body_b64": _b64(req.raw_content),
                "body_len": len(req.raw_content or b""),
            }
        )
        # Forge the answer the sample is waiting for. A generic 200 success unlocks
        # the common "if beacon succeeded, proceed" gate. The body is deliberately
        # innocuous + generic; specific per-host forging can be layered on later.
        flow.response = http.Response.make(
            200,
            b'{"status":"ok","ok":true}',
            {
                "Content-Type": "application/json",
                "Server": "nginx",
                "Connection": "close",
            },
        )

    def response(self, flow: http.HTTPFlow) -> None:
        # Record what we forged back (so the timeline shows the full conversation).
        if flow.response is not None:
            sni = getattr(flow.client_conn, "sni", None)
            _emit(
                {
                    "kind": "http_response_forged",
                    "host": sni or flow.request.pretty_host or flow.request.host,
                    "status": flow.response.status_code,
                    "forged": True,
                }
            )

    def tls_failed_client(self, data: tls.TlsData) -> None:
        """A client-side TLS failure after we presented our leaf almost always means
        the sample PINNED a cert it expected (and ours isn't it). That is a strong,
        honest signal — encrypted C2 was attempted and our interception was refused —
        NOT a clean result. Captured so the verdict can say exactly that."""
        try:
            sni = data.context.client.sni  # type: ignore[attr-defined]
        except Exception:
            sni = None
        _emit(
            {
                "kind": "tls_intercept_refused",
                "sni": sni,
                "note": "client refused our forged leaf (likely cert pinning / mTLS); "
                "encrypted C2 attempted, plaintext NOT revealed — reportable, never 'clean'",
            }
        )


addons = [Forge()]
