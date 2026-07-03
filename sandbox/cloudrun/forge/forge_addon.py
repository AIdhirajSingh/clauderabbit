#!/usr/bin/env python3
"""
forge_addon.py — the deceptive forging egress, Cloud Run NVA-gateway edition.

Ported from sandbox/microvm/forge/forge_addon.py (the single-host, per-run-netns
architecture). Cloud Run Gen2 containers get NO CAP_NET_ADMIN (confirmed against
current GCP docs: no netns, no veth, no iptables inside the container, on any
generation), so the per-run netns pair is gone. Containment now comes from a GCP
Direct-VPC-egress + custom-route "NVA" pattern instead: every Cloud Run detonation
execution's egress is routed (see cr-detonation-force-nva) to THIS VM regardless of
destination, and mitmproxy's transparent mode + a local iptables REDIRECT (see
provision-forge-gateway.sh) delivers it to this same Forge addon. The Forge/TLS/
registry-passthrough logic below is UNCHANGED from the host version — it never
depended on netns, only on SO_ORIGINAL_DST (which REDIRECT preserves identically on
a plain interface) and the machine's own DNS resolver (unchanged from a normal VM).

What IS new for the shared-gateway topology (this file's only real deltas from the
host version):
  1. Every emitted record is tagged with `source_ip` — the connecting Cloud Run
     execution's IP within the subnet — because this gateway now serves MANY
     concurrent detonations, not one isolated netns per run. Attribution by
     source_ip is what lets forensics_api.py hand each execution back only ITS
     OWN captured traffic (see cr-forge-gateway/README in provision-forge-gateway.sh).
  2. The harness's OWN telemetry channel (detonate.py POSTs its observation JSON to
     http://cr-harness.cr.internal/..., which Cloud DNS resolves straight to this
     gateway's own IP) is now tagged `kind: "harness_telemetry"` distinctly from a
     generic forged http_request, so assemble-forensics.py can find it precisely
     amid many concurrent scans' interleaved capture records.

HONEST LIMITS (unchanged, still true here): a forge cannot defeat certificate
pinning, mTLS, or custom-crypto C2. Those connections abort instead of revealing
plaintext; that abort is itself a reportable signal (see tls_failed_client), never
a false clean.

Env:
  CR_FORGE_CAPTURE   capture JSONL path (default /var/log/cr-forge/capture.jsonl)
  CR_FORGE_MAXBODY   max request/response body bytes captured (default 65536)
  CR_HARNESS_HOSTS   comma-separated hostnames treated as harness telemetry, not
                     forged-attacker traffic (default cr-harness.cr.internal)
"""
from __future__ import annotations

import base64
import ipaddress
import json
import os
import re
import socket
import time
from typing import Any

from mitmproxy import http, tls

CAPTURE_PATH = os.environ.get("CR_FORGE_CAPTURE", "/var/log/cr-forge/capture.jsonl")
MAX_BODY = int(os.environ.get("CR_FORGE_MAXBODY", "65536"))
HARNESS_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("CR_HARNESS_HOSTS", "cr-harness.cr.internal").split(",")
    if h.strip()
}

# Package registries: a GENUINE build needs these. We do NOT forge them — mitmproxy
# proxies to the real upstream (the guest trusts our CA, so its TLS completes) and we
# just LOG the flow. --ignore-hosts is unreliable in transparent mode (it matches the
# IP, not the SNI), so the addon makes the decision on the SNI/Host instead.
REGISTRY_RE = re.compile(
    r"(^|\.)(registry\.npmjs\.org|npmjs\.org|yarnpkg\.com|pypi\.org|pythonhosted\.org"
    r"|crates\.io|debian\.org|ubuntu\.com|nodejs\.org)$"
)

# The app's own Supabase project — the container's TRUSTED control-plane calls (result
# reporting to attach-forensics, deep-queue observability) also transit this same
# gateway (Direct VPC egress routes ALL of the container's traffic here, ours and the
# untrusted repo's alike). Verified-IP passthrough, same discipline as a registry.
CONTROL_PLANE_RE = re.compile(r"(^|\.)supabase\.co$")

# Source hosting: the harness's OWN `git clone` of the scanned repo (entrypoint.sh,
# BEFORE any untrusted code ever runs) also transits this same forced-egress path —
# confirmed by a real deployed run: without this, the clone's info/refs + HEAD
# requests to github.com were forged like any other non-allowlisted host, and a
# forged git-smart-HTTP response cannot deliver real repository content. That
# defeats the product's actual point ("we run it for real") for every scan, not an
# edge case — so this MUST be a genuine, verified-IP passthrough, same discipline
# as a registry. codeload.github.com / api.github.com / raw+objects.githubusercontent.com
# all match by suffix. TRADE-OFF (accepted, documented): assemble-forensics.py's
# existing supply-chain-caution classification (SOFTWARE_DISTRIBUTION_HOSTS) only
# reads FORGED "http_request" records — a real passthrough here means a build
# script's OWN later fetch to github.com (e.g. a postinstall pulling a release
# tarball) is no longer visible as that caution signal either. Correctness of the
# harness's own clone (every scan) outweighs that secondary visibility signal
# (some scans); revisit if that signal turns out to matter in practice.
SOURCE_HOST_RE = re.compile(r"(^|\.)(github\.com|githubusercontent\.com)$")

# Forged bodies. The forge must answer in a shape the CONSUMER can use so the install
# COMPLETES — a JSON success piped into `bash` is a syntax error that kills the install
# (clawdcursor's case), so we pick by consumer. The real remote payload is NEVER fetched;
# we answer as if the server replied with a benign success, capture the attempt, and no
# real packet leaves. A no-op script lets `curl|bash` succeed without running unknown code.
SHELL_NOOP = (
    b"# Claude Rabbit forge: forged install response (no-op). The real remote payload was\n"
    b"# never fetched and no real packet left the gateway; this attempt is captured as evidence.\n"
    b"true\n"
)
PS_NOOP = (
    b"# Claude Rabbit forge: forged install response (no-op). No real packet left the gateway.\n"
)
JSON_OK = b'{"status":"ok","ok":true,"success":true}'

# Cache of registry-host -> set of real IPs we resolved (via this VM's own real
# resolver). Bounds the spoof check to one resolve per host. A legitimate guest build
# connects to one of THESE IPs (it resolved the same registry name); a spoofed SNI to
# an attacker IP will not be in the set, so it is refused.
_REGISTRY_IP_CACHE: dict[str, set[str]] = {}
_CONTROL_IP_CACHE: dict[str, set[str]] = {}
_SOURCE_IP_CACHE: dict[str, set[str]] = {}


def _is_public_ip(ip: str) -> bool:
    """True iff `ip` is a routable PUBLIC address. A real registry/control-plane host is
    ALWAYS public, so this is a hard precondition for any raw passthrough: it rejects
    loopback, link-local, private, multicast, reserved and unspecified addresses."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (a.is_private or a.is_loopback or a.is_link_local
                or a.is_multicast or a.is_reserved or a.is_unspecified)


def _resolve(sni: str) -> set[str]:
    """Resolve `sni` to its current PUBLIC A-record IPs via this VM's own resolver.
    Non-public results are dropped. Returns the empty set on any failure (fail closed)."""
    out: set[str] = set()
    try:
        for a in socket.getaddrinfo(sni, 443, socket.AF_INET, socket.SOCK_STREAM):
            ip = a[4][0]
            if _is_public_ip(ip):
                out.add(ip)
    except Exception:  # noqa: BLE001 — a malformed SNI must not crash the addon coroutine
        pass
    return out


def _is_verified_ip(cache: dict[str, set[str]], sni: str, dest_ip: str) -> bool:
    """True iff dest_ip is a real PUBLIC IP for this SNI. The known-good IP set per SNI is
    ACCUMULATED (unioned across resolves), never overwritten — a CDN rotates its A-records,
    so on a miss we re-resolve and union before deciding. An attacker IP is in neither
    resolve and stays refused. Fail closed: an unconfirmed miss is forged, not passed
    through."""
    if not _is_public_ip(dest_ip):
        return False
    ips = cache.setdefault(sni, set())
    if dest_ip in ips:
        return True
    fresh = _resolve(sni)
    if fresh:
        ips |= fresh
    return dest_ip in ips


def _is_registry_ip(sni: str, dest_ip: str) -> bool:
    return _is_verified_ip(_REGISTRY_IP_CACHE, sni, dest_ip)


def _is_control_plane_ip(sni: str, dest_ip: str) -> bool:
    return _is_verified_ip(_CONTROL_IP_CACHE, sni, dest_ip)


def _is_source_host_ip(sni: str, dest_ip: str) -> bool:
    return _is_verified_ip(_SOURCE_IP_CACHE, sni, dest_ip)


def _b64(raw: bytes | None) -> str:
    if not raw:
        return ""
    return base64.b64encode(raw[:MAX_BODY]).decode("ascii")


def _forged_body(req: http.Request) -> tuple[bytes, str, str]:
    """Pick a forged body that the CONSUMER can use, so the install runs to completion."""
    ua = (req.headers.get("User-Agent") or "").lower()
    accept = (req.headers.get("Accept") or "").lower()
    path = (req.path or "").lower().split("?", 1)[0]
    if path.endswith((".sh", ".bash")) or "x-sh" in accept or "shellscript" in accept:
        return SHELL_NOOP, "text/x-shellscript", "shell"
    if path.endswith(".ps1") or "powershell" in ua:
        return PS_NOOP, "text/plain", "powershell"
    if "curl/" in ua or "wget" in ua or "libcurl" in ua:
        return SHELL_NOOP, "text/x-shellscript", "shell"
    if "application/json" in accept or "/api/" in path or path.endswith(".json"):
        return JSON_OK, "application/json", "json"
    return JSON_OK, "application/json", "json"


def _source_ip(flow_or_data: Any) -> str:
    """The connecting Cloud Run execution's IP within the subnet — the attribution key
    forensics_api.py uses to hand each execution back only its own captured records.
    None/'' means we couldn't determine it (fails closed at the retrieval side: no
    source_ip match means no records returned, never someone else's)."""
    try:
        client_conn = flow_or_data.client_conn if hasattr(flow_or_data, "client_conn") else flow_or_data.context.client
        peer = client_conn.peername
        if peer:
            return str(peer[0])
    except Exception:  # noqa: BLE001
        pass
    return ""


def _emit(record: dict[str, Any]) -> None:
    """Append one forensic record. The capture is the evidence — every claim in the
    report traces back to a line here, never a template."""
    os.makedirs(os.path.dirname(CAPTURE_PATH), exist_ok=True)
    record["t"] = round(time.time(), 3)
    with open(CAPTURE_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


class Forge:
    """Forge a plausible success for every intercepted flow + capture it, attributed
    to the Cloud Run execution (by source IP) that generated it."""

    def tls_clienthello(self, data: tls.ClientHelloData) -> None:
        """Registry/control-plane fast-path: peek the SNI in the ClientHello and pass
        those connections through RAW (no MITM) straight to the real upstream, ONLY when
        the real destination IP actually belongs to that host (the SNI is
        attacker-controlled; a spoofed SNI pointed at an attacker IP is MITM'd and
        forged, never relayed)."""
        sni = data.client_hello.sni
        src = _source_ip(data)
        if not sni:
            return
        dest_ip = self._dest_ip(data)
        if REGISTRY_RE.search(sni):
            if dest_ip and _is_registry_ip(sni, dest_ip):
                data.ignore_connection = True
                _emit({"kind": "registry_passthrough_raw", "host": sni, "dest": dest_ip, "source_ip": src})
            else:
                _emit({"kind": "registry_sni_spoof_refused", "host": sni, "dest": dest_ip, "source_ip": src,
                       "note": "registry SNI but destination is not a registry IP — forged, not "
                               "passed through (no real packet reached the claimed registry)"})
        elif CONTROL_PLANE_RE.search(sni):
            if dest_ip and _is_control_plane_ip(sni, dest_ip):
                data.ignore_connection = True
                _emit({"kind": "control_plane_passthrough_raw", "host": sni, "dest": dest_ip, "source_ip": src})
            else:
                _emit({"kind": "control_plane_sni_spoof_refused", "host": sni, "dest": dest_ip, "source_ip": src})
        elif SOURCE_HOST_RE.search(sni):
            if dest_ip and _is_source_host_ip(sni, dest_ip):
                data.ignore_connection = True
                _emit({"kind": "source_host_passthrough_raw", "host": sni, "dest": dest_ip, "source_ip": src})
            else:
                _emit({"kind": "source_host_sni_spoof_refused", "host": sni, "dest": dest_ip, "source_ip": src})

    @staticmethod
    def _dest_ip(data: tls.ClientHelloData) -> str | None:
        """The connection's ORIGINAL destination IP (recovered by mitmproxy's transparent
        mode from SO_ORIGINAL_DST). None makes the verified-IP check fail closed (forge
        the flow) rather than reason about a wrong IP."""
        try:
            addr = data.context.server.address  # type: ignore[attr-defined]
            if addr:
                return str(addr[0])
        except Exception:  # noqa: BLE001
            pass
        return None

    def request(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        src = _source_ip(flow)
        sni = getattr(flow.client_conn, "sni", None)
        intended = sni or req.pretty_host or req.host

        # Registry / control-plane fast-path over plain HTTP (the TLS path is handled in
        # tls_clienthello above; this covers cleartext registry mirrors and any HTTP
        # control-plane call). Fail closed: an unconfirmed miss is forged, not proxied.
        for label, rx, verifier in (
            ("registry", REGISTRY_RE, _is_registry_ip),
            ("control_plane", CONTROL_PLANE_RE, _is_control_plane_ip),
            ("source_host", SOURCE_HOST_RE, _is_source_host_ip),
        ):
            if rx.search(intended or ""):
                dest_ip = None
                try:
                    if flow.server_conn and flow.server_conn.address:
                        dest_ip = str(flow.server_conn.address[0])
                except Exception:  # noqa: BLE001
                    dest_ip = None
                if dest_ip and verifier(intended, dest_ip):
                    _emit({"kind": f"{label}_passthrough", "host": intended, "dest": dest_ip,
                           "method": req.method, "path": req.path, "source_ip": src})
                    return
                _emit({"kind": f"{label}_sni_spoof_refused", "host": intended, "dest": dest_ip,
                       "proto": "http", "source_ip": src,
                       "note": f"{label} Host/SNI but destination is not verified — forging instead of proxying"})
                # fall through: forge it below (do NOT proxy to the unverified destination)

        is_harness = (intended or "").lower() in HARNESS_HOSTS
        _emit(
            {
                "kind": "harness_telemetry" if is_harness else "http_request",
                "scheme": req.scheme,
                "host": intended,          # the INTENDED destination (real C2 / exfil target)
                "sni": sni,
                "connected_ip": req.host,  # what it actually connected to (the gateway)
                "port": req.port,
                "method": req.method,
                "path": req.path,
                "http_version": req.http_version,
                "headers": dict(req.headers),
                "body_b64": _b64(req.raw_content),
                "body_len": len(req.raw_content or b""),
                "source_ip": src,
            }
        )
        # Forge the answer the sample is waiting for (or a plain 200 for harness
        # telemetry, which only needs a non-error response). The real server is never
        # contacted.
        body, ctype, forged_as = _forged_body(req)
        if is_harness:
            body, ctype, forged_as = JSON_OK, "application/json", "harness_ack"
        _emit({"kind": "forge_response_kind", "host": intended, "path": req.path,
               "forged_as": forged_as, "source_ip": src})
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
        # Skip registry/control-plane flows — those are REAL upstream responses.
        if flow.response is not None:
            sni = getattr(flow.client_conn, "sni", None)
            host = sni or flow.request.pretty_host or ""
            if REGISTRY_RE.search(host) or CONTROL_PLANE_RE.search(host) or SOURCE_HOST_RE.search(host):
                return
            _emit(
                {
                    "kind": "http_response_forged",
                    "host": host or flow.request.host,
                    "status": flow.response.status_code,
                    "forged": True,
                    "source_ip": _source_ip(flow),
                }
            )

    def tls_failed_client(self, data: tls.TlsData) -> None:
        """A client-side TLS failure after we presented our leaf almost always means the
        sample PINNED a cert it expected. That is a strong, honest signal — encrypted C2
        was attempted and our interception was refused — NOT a clean result."""
        try:
            sni = data.context.client.sni  # type: ignore[attr-defined]
        except Exception:
            sni = None
        _emit(
            {
                "kind": "tls_intercept_refused",
                "sni": sni,
                "source_ip": _source_ip(data),
                "note": "client refused our forged leaf (likely cert pinning / mTLS); "
                "encrypted C2 attempted, plaintext NOT revealed — reportable, never 'clean'",
            }
        )


addons = [Forge()]
