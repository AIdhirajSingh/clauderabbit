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

Registry traffic (npm/PyPI/...) is passed through to the REAL upstream by THIS addon
(`--ignore-hosts` is unreliable in transparent mode — it matches the IP, not the SNI —
so the decision is made here on the SNI/Host, and ONLY when the real destination IP is a
verified public registry IP). Everything else is forged.

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
import re
import time
from typing import Any

from mitmproxy import http, tls

CAPTURE_PATH = os.environ.get("CR_FORGE_CAPTURE", "/var/log/cr-forge/capture.jsonl")
MAX_BODY = int(os.environ.get("CR_FORGE_MAXBODY", "65536"))

# Package registries: a GENUINE build needs these. We do NOT forge them — mitmproxy
# proxies to the real upstream (the guest trusts our CA, so its TLS completes) and we
# just LOG the flow. --ignore-hosts is unreliable in transparent mode (it matches the
# IP, not the SNI), so the addon makes the decision on the SNI/Host instead.
REGISTRY_RE = re.compile(
    r"(^|\.)(registry\.npmjs\.org|npmjs\.org|yarnpkg\.com|pypi\.org|pythonhosted\.org"
    r"|crates\.io|debian\.org|ubuntu\.com|nodejs\.org)$"
)


# Forged bodies. The forge must answer in a shape the CONSUMER can use so the install
# COMPLETES — a JSON success piped into `bash` is a syntax error that kills the install
# (clawdcursor's case), so we pick by consumer. The real remote payload is NEVER fetched;
# we answer as if the server replied with a benign success, capture the attempt, and no
# real packet leaves. A no-op script lets `curl|bash` succeed without running unknown code.
SHELL_NOOP = (
    b"# Claude Rabbit forge: forged install response (no-op). The real remote payload was\n"
    b"# never fetched and no real packet left the host; this attempt is captured as evidence.\n"
    b"true\n"
)
PS_NOOP = (
    b"# Claude Rabbit forge: forged install response (no-op). No real packet left the host.\n"
)
JSON_OK = b'{"status":"ok","ok":true,"success":true}'


import ipaddress  # noqa: E402
import socket  # noqa: E402

# Cache of registry-host -> set of real IPs we resolved (via our own dnsmasq, which
# forwards registry names to the real resolver). Bounds the spoof check to one resolve
# per host. A legitimate guest build connects to one of THESE IPs (it resolved the same
# way); a spoofed SNI to an attacker IP will not be in the set, so it is refused.
_REGISTRY_IP_CACHE: dict[str, set[str]] = {}


def _is_public_ip(ip: str) -> bool:
    """True iff `ip` is a routable PUBLIC address. A real package registry is ALWAYS public,
    so this is a hard precondition for any raw passthrough: it rejects loopback, link-local
    (incl. the forge's own 169.254.0.1), private, multicast, reserved and unspecified
    addresses. This also closes a degenerate match (review H2): if a registry domain is NOT
    in dnsmasq's forward list it resolves to the catch-all forge IP for BOTH the guest and
    the addon, so the IPs would 'match' — but the forge IP is link-local, so this guard
    refuses it and the flow is forged instead of relayed to a dead local port."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (a.is_private or a.is_loopback or a.is_link_local
                or a.is_multicast or a.is_reserved or a.is_unspecified)


def _resolve_registry(sni: str) -> set[str]:
    """Resolve a registry SNI to its current PUBLIC A-record IPs via the forge netns
    resolver (dnsmasq -> the real registry IP for registry hosts; see forge-up.sh netns
    resolv.conf). Non-public results are dropped (a real registry is never private/
    link-local). Returns the empty set on any failure (fail closed)."""
    out: set[str] = set()
    try:
        for a in socket.getaddrinfo(sni, 443, socket.AF_INET, socket.SOCK_STREAM):
            ip = a[4][0]
            if _is_public_ip(ip):
                out.add(ip)
    except Exception:  # noqa: BLE001 — a malformed SNI must not crash the addon coroutine
        pass
    return out


def _is_registry_ip(sni: str, dest_ip: str) -> bool:
    """True iff dest_ip is a real PUBLIC IP for this registry SNI. The known-good IP set per
    SNI is ACCUMULATED (unioned across resolves), never overwritten: a CDN registry rotates
    its A-records, so the guest may have connected to a member we hadn't seen yet — on a miss
    we re-resolve and union before deciding, giving a legit-but-newly-rotated IP a second
    chance. An attacker IP is in NEITHER resolve, so it stays refused. We resolve through the
    SAME dnsmasq the guest uses (shared cache), so the guest's IP is almost always already
    present. dest_ip must itself be public (a registry is never link-local/private). On a
    confirmed miss we return False (fail CLOSED — forge rather than pass through to an
    unverified destination)."""
    if not _is_public_ip(dest_ip):
        return False
    ips = _REGISTRY_IP_CACHE.setdefault(sni, set())
    if dest_ip in ips:
        return True
    fresh = _resolve_registry(sni)
    if fresh:
        ips |= fresh
    return dest_ip in ips


def _b64(raw: bytes | None) -> str:
    if not raw:
        return ""
    return base64.b64encode(raw[:MAX_BODY]).decode("ascii")


def _forged_body(req: http.Request) -> tuple[bytes, str, str]:
    """Pick a forged body that the CONSUMER can use, so the install runs to completion.
    Returns (body, content_type, forged_as). Heuristics, most specific first:
      - an explicit shell asset (.sh/.bash, or Accept: x-sh)        -> no-op shell script
      - an explicit PowerShell asset (.ps1) / a PowerShell client   -> no-op PowerShell
      - an explicit JSON expectation (Accept json, /api/, .json)    -> JSON success
      - a curl/wget client with a generic Accept (the `curl … | sh` -> no-op shell script
        install pattern, even when the URL has no .sh suffix)
      - anything else (node/python http clients, browsers)          -> JSON success
    Forging success is NEVER real egress — the real server is never contacted."""
    ua = (req.headers.get("User-Agent") or "").lower()
    accept = (req.headers.get("Accept") or "").lower()
    path = (req.path or "").lower().split("?", 1)[0]
    if path.endswith((".sh", ".bash")) or "x-sh" in accept or "shellscript" in accept:
        return SHELL_NOOP, "text/x-shellscript", "shell"
    if path.endswith(".ps1") or "powershell" in ua:
        return PS_NOOP, "text/plain", "powershell"
    # curl/wget client -> the `curl … | sh` install pattern. Decide on the CLIENT, not the
    # Accept header (which is attacker-controlled — a malicious `curl -H 'Accept: json' …
    # | bash` must still get a script, not JSON that breaks the install). This comes BEFORE
    # the JSON check for that reason.
    if "curl/" in ua or "wget" in ua or "libcurl" in ua:
        return SHELL_NOOP, "text/x-shellscript", "shell"
    if "application/json" in accept or "/api/" in path or path.endswith(".json"):
        return JSON_OK, "application/json", "json"
    return JSON_OK, "application/json", "json"


def _emit(record: dict[str, Any]) -> None:
    """Append one forensic record. The capture is the evidence — every claim in the
    report traces back to a line here, never a template."""
    os.makedirs(os.path.dirname(CAPTURE_PATH), exist_ok=True)
    record["t"] = round(time.time(), 3)
    with open(CAPTURE_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


class Forge:
    """Forge a plausible success for every intercepted flow + capture it."""

    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        """Registry fast-path, done right: peek the SNI in the ClientHello and pass
        registry connections through RAW (no MITM) straight to the real upstream. The
        guest gets the real registry cert (npm/pip trust real CAs), and we skip the
        decrypt/re-encrypt of every metadata request + tarball — the build runs at native
        speed. We log the connection; we don't need its bytes. Everything else is MITM'd
        and forged below. (--ignore-hosts is unreliable in transparent mode; this is not.)

        CONTAINMENT (security review CRITICAL #1): a raw passthrough sends bytes to the
        connection's ORIGINAL destination IP. The SNI is attacker-controlled, so malware
        could connect to an attacker IP while presenting SNI=registry.npmjs.org and smuggle
        a real passthrough to the attacker. So we ONLY pass through when the real
        destination IP actually belongs to that registry (the guest resolved it via our
        dnsmasq, which returns the real registry IP). A registry SNI whose destination is
        NOT a registry IP is a spoof: we DON'T ignore it — mitmproxy MITMs it and request()
        forges it, so no real packet reaches the attacker."""
        sni = data.client_hello.sni
        if not (sni and REGISTRY_RE.search(sni)):
            return
        dest_ip = self._dest_ip(data)
        if dest_ip and _is_registry_ip(sni, dest_ip):
            data.ignore_connection = True
            _emit({"kind": "registry_passthrough_raw", "host": sni, "dest": dest_ip})
        else:
            _emit({"kind": "registry_sni_spoof_refused", "host": sni, "dest": dest_ip,
                   "note": "registry SNI but destination is not a registry IP — forged, not "
                           "passed through (no real packet reached the claimed registry)"})

    @staticmethod
    def _dest_ip(data: tls.ClientHelloData) -> str | None:
        """The connection's ORIGINAL destination IP (recovered by mitmproxy's transparent
        mode from SO_ORIGINAL_DST). Returns None if it can't be determined — we deliberately
        do NOT fall back to client.sockname (review H1): that is the forge's OWN listen
        address, not the destination, and returning it would be a misleading 'dest'. None
        makes _is_registry_ip fail closed (forge the flow) rather than reason about a wrong
        IP — the safe default for an unknown destination."""
        try:
            addr = data.context.server.address  # type: ignore[attr-defined]
            if addr:
                return str(addr[0])
        except Exception:  # noqa: BLE001
            pass
        return None

    def request(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        # The INTENDED destination: prefer the TLS SNI / Host header (the real C2 name),
        # not the forge IP the client actually connected to. pretty_host is the Host
        # header when present; client_conn.sni is the TLS name for https flows.
        sni = getattr(flow.client_conn, "sni", None)
        intended = sni or req.pretty_host or req.host
        # Registry fast-path: log it, but DON'T set flow.response — mitmproxy then proxies
        # the request to the REAL upstream registry, so the build gets genuine packages.
        # CONTAINMENT (review CRITICAL #1): only pass through if the REAL destination IP
        # belongs to that registry — a registry Host/SNI pointed at an attacker IP is a
        # spoof and must be FORGED, not proxied (else mitmproxy relays the bytes to the
        # attacker). Fail closed: if we can't confirm a registry IP, forge it.
        if REGISTRY_RE.search(intended or ""):
            dest_ip = None
            try:
                if flow.server_conn and flow.server_conn.address:
                    dest_ip = str(flow.server_conn.address[0])
            except Exception:  # noqa: BLE001
                dest_ip = None
            if dest_ip and _is_registry_ip(intended, dest_ip):
                _emit({"kind": "registry_passthrough", "host": intended, "dest": dest_ip,
                       "method": req.method, "path": req.path})
                return
            _emit({"kind": "registry_sni_spoof_refused", "host": intended, "dest": dest_ip,
                   "proto": "http", "note": "registry Host/SNI but destination is not a "
                   "registry IP — forging instead of proxying to the attacker"})
            # fall through: forge it below (do NOT proxy to the unverified destination)
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
        # Forge the answer the sample is waiting for, in a shape its CONSUMER can use so
        # the install/build RUNS TO COMPLETION (a JSON success piped into `bash` would be
        # a syntax error that kills the install). A generic 200 success also unlocks the
        # common "if beacon succeeded, proceed" gate. The real server is never contacted.
        body, ctype, forged_as = _forged_body(req)
        _emit({"kind": "forge_response_kind", "host": intended, "path": req.path, "forged_as": forged_as})
        flow.response = http.Response.make(
            200,
            body,
            {
                "Content-Type": ctype,
                "Server": "nginx",
                "Connection": "close",
            },
        )

    def response(self, flow: http.HTTPFlow) -> None:
        # Record what we forged back (so the timeline shows the full conversation).
        # Skip registry flows — those are REAL upstream responses, not forged.
        if flow.response is not None:
            sni = getattr(flow.client_conn, "sni", None)
            if REGISTRY_RE.search(sni or flow.request.pretty_host or ""):
                return
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
