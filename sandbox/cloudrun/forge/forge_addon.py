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
# This VM's OWN IP — the harness-telemetry channel (below) and the clone-window
# file (below) are both keyed against real destinations/identities THIS process
# controls, never against attacker-suppliable strings alone. Fixed, known value
# (10.200.0.10), not resolved — it is this gateway's own static internal IP.
GATEWAY_SELF_IP = os.environ.get("CR_GATEWAY_SELF_IP", "10.200.0.10")
# Written by forensics_api.py's /register handler: {source_ip: expiry_epoch}.
# See SOURCE_HOST_RE's own comment for why this file exists.
CLONE_WINDOW_PATH = os.environ.get("CR_CLONE_WINDOW_PATH", "/var/log/cr-forge/clone-windows.json")

# Package registries: a GENUINE build needs these. We do NOT forge them — mitmproxy
# proxies to the real upstream (the guest trusts our CA, so its TLS completes) and we
# just LOG the flow. --ignore-hosts is unreliable in transparent mode (it matches the
# IP, not the SNI), so the addon makes the decision on the SNI/Host instead.
REGISTRY_RE = re.compile(
    r"(^|\.)(registry\.npmjs\.org|npmjs\.org|yarnpkg\.com|pypi\.org|pythonhosted\.org"
    r"|crates\.io|debian\.org|ubuntu\.com|nodejs\.org)$"
)

# The app's OWN Supabase PROJECT — anchored to the exact project ref, NOT the whole
# shared `supabase.co` zone (SECURITY REVIEW FINDING, CONFIRMED: supabase.co is a
# public multi-tenant SaaS domain — anyone, including an attacker, can register a
# free project and get a real, genuinely-resolving `<their-ref>.supabase.co`
# subdomain. Matching the whole zone would let a malicious repo's own code beacon
# or exfiltrate to an ATTACKER'S OWN Supabase project as a genuine verified-IP
# passthrough — invisible, real data leaving the sandbox. Anchoring to the exact
# hostname closes this; the app only ever needs to reach its own project).
CR_SUPABASE_PROJECT_REF = os.environ.get("CR_SUPABASE_PROJECT_REF", "mjvlczaytkhvsolnhhkz")
CONTROL_PLANE_RE = re.compile(r"^" + re.escape(CR_SUPABASE_PROJECT_REF) + r"\.supabase\.co$")

# The harness's OWN 3-agent exploration pass (parallel_agents.py) calls Vertex AI
# directly when OpenCode is unavailable (vertex_client.py fallback) — a REAL, honest
# analysis call ("Analyze this repository file for malicious behavior..."), not the
# scanned repo's own network behavior. CONFIRMED on a real deployed run (AmrDab/
# clawdcursor): without this, that call was forged like any other unallowlisted
# host and then MISATTRIBUTED in the final report as if the SCANNED REPO had
# "attempted to reach aiplatform.googleapis.com" — an honest-reporting bug (the
# product's core rule cuts both ways: never overclaim malice any more than safety).
# aiplatform.googleapis.com is Google's SHARED multi-tenant Vertex domain (same
# risk class as the supabase.co finding) — a malicious repo could have its OWN
# real Google Cloud project, so hostname-verified-IP alone is not enough scoping
# here. The request PATH embeds the calling project (`/projects/<id>/...`), so
# passthrough additionally requires that path to name OUR OWN project — a
# malicious repo's own Vertex calls (a different project id in the path) still
# get forged. Path inspection requires the TLS payload decrypted, so — unlike the
# other categories — this one is NOT checked in tls_clienthello (no ignore_connection
# shortcut); it's decided in request() below, after mitmproxy has already MITM'd
# and can read the path, exactly like the existing HTTP-layer passthrough loop.
CR_OWN_GCP_PROJECT_ID = os.environ.get("CR_OWN_GCP_PROJECT_ID", "redacted-gcp-project")
OWN_VERTEX_RE = re.compile(r"(^|\.)aiplatform\.googleapis\.com$")
_OWN_VERTEX_IP_CACHE: dict[str, set[str]] = {}


def _is_own_vertex_ip(sni: str, dest_ip: str) -> bool:
    return _is_verified_ip(_OWN_VERTEX_IP_CACHE, sni, dest_ip)


def _is_own_vertex_path(path: str) -> bool:
    return f"/projects/{CR_OWN_GCP_PROJECT_ID}/" in (path or "")


# Source hosting: the harness's OWN `git clone` of the scanned repo (entrypoint.sh,
# BEFORE any untrusted code ever runs) also transits this same forced-egress path —
# confirmed by a real deployed run: without this, the clone's info/refs + HEAD
# requests to github.com were forged like any other non-allowlisted host, and a
# forged git-smart-HTTP response cannot deliver real repository content. That
# defeats the product's actual point ("we run it for real") for every scan, not an
# edge case — so this MUST be a genuine, verified-IP passthrough, same discipline
# as a registry. codeload.github.com / api.github.com / raw+objects.githubusercontent.com
# all match by suffix.
#
# SECURITY REVIEW FINDING, CONFIRMED AND FIXED: this passthrough must NOT stay open
# for the whole container lifetime. The repo being scanned is by definition
# attacker-controlled — if this stayed open during detonate.py's build/run phase, a
# malicious repo's OWN code could use the REAL github.com/api.github.com API
# (create a gist, push a commit, open an issue) as a genuine, unforged, working
# data-exfiltration channel, invisible to assemble-forensics.py (which never reads
# `source_host_passthrough_raw`) — real data leaving the sandbox, not merely a lost
# visibility signal. `_source_host_clone_window_open()` below scopes this
# passthrough to a short window after `/register`, matching the harness's own
# clone step — once it expires, github.com is forged like any other unallowlisted
# host for the remainder of the run, exactly where a malicious repo's OWN network
# activity would happen.
SOURCE_HOST_RE = re.compile(r"(^|\.)(github\.com|githubusercontent\.com)$")

_clone_window_cache: dict[str, Any] = {"loaded_at": 0.0, "windows": {}}


def _source_host_clone_window_open(source_ip: str) -> bool:
    """True iff `source_ip` is still within its post-/register clone window (see
    forensics_api.py's /register handler, which writes this file). Re-read at most
    once per second (cheap; this file is small and rarely changes) rather than on
    every single request. Fails CLOSED: any read/parse error, or no matching
    still-unexpired entry, means the window is NOT open (github.com forged, same
    as any other unallowlisted host) — never fails open."""
    now = time.time()
    if now - _clone_window_cache["loaded_at"] > 1.0:
        try:
            with open(CLONE_WINDOW_PATH, encoding="utf-8") as f:
                _clone_window_cache["windows"] = json.load(f)
        except Exception:  # noqa: BLE001 — missing/corrupt file -> no windows open
            _clone_window_cache["windows"] = {}
        _clone_window_cache["loaded_at"] = now
    expiry = _clone_window_cache["windows"].get(source_ip)
    return isinstance(expiry, (int, float)) and now < expiry

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
            if dest_ip and _is_source_host_ip(sni, dest_ip) and _source_host_clone_window_open(src):
                data.ignore_connection = True
                _emit({"kind": "source_host_passthrough_raw", "host": sni, "dest": dest_ip, "source_ip": src})
            elif dest_ip and _is_source_host_ip(sni, dest_ip):
                # Real registry-grade IP, but the clone window has expired — this is
                # detonate.py's build/run phase now, i.e. the UNTRUSTED repo's own
                # code reaching github.com, not the harness's own clone. Forge it
                # like any other unallowlisted host (fall through, do not passthrough).
                _emit({"kind": "source_host_window_expired", "host": sni, "dest": dest_ip, "source_ip": src,
                       "note": "verified source-host IP but outside the post-clone window — "
                               "treated as the scanned repo's own traffic, forged not passed through"})
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

        # The harness's OWN Vertex AI calls (agentic exploration fallback) — see
        # OWN_VERTEX_RE's comment. Requires BOTH a verified real Vertex IP AND the
        # request path naming OUR OWN project (a malicious repo's own Vertex
        # project, a different id in the path, still gets forged below).
        if OWN_VERTEX_RE.search(intended or ""):
            dest_ip = None
            try:
                if flow.server_conn and flow.server_conn.address:
                    dest_ip = str(flow.server_conn.address[0])
            except Exception:  # noqa: BLE001
                dest_ip = None
            if dest_ip and _is_own_vertex_ip(intended, dest_ip) and _is_own_vertex_path(req.path):
                _emit({"kind": "own_vertex_passthrough", "host": intended, "dest": dest_ip,
                       "method": req.method, "path": req.path, "source_ip": src})
                return
            _emit({"kind": "own_vertex_spoof_refused", "host": intended, "dest": dest_ip,
                   "proto": "http", "source_ip": src,
                   "note": "aiplatform.googleapis.com but destination/project-path is not verified as our "
                           "own — forging instead of proxying (may be the scanned repo's own Vertex project)"})
            # fall through: forge it below (do NOT proxy to an unverified project)

        # Registry / control-plane / source-host fast-path over plain HTTP (the TLS
        # path is handled in tls_clienthello above; this covers cleartext registry
        # mirrors and any HTTP control-plane/source-host call). Fail closed: an
        # unconfirmed miss is forged, not proxied. source_host additionally requires
        # the post-/register clone window to still be open (see SOURCE_HOST_RE's
        # comment) — outside that window it's the scanned repo's OWN traffic, not
        # the harness's clone, and must be forged like anything else.
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
                window_ok = label != "source_host" or _source_host_clone_window_open(src)
                if dest_ip and verifier(intended, dest_ip) and window_ok:
                    _emit({"kind": f"{label}_passthrough", "host": intended, "dest": dest_ip,
                           "method": req.method, "path": req.path, "source_ip": src})
                    return
                _emit({"kind": f"{label}_sni_spoof_refused", "host": intended, "dest": dest_ip,
                       "proto": "http", "source_ip": src,
                       "note": f"{label} Host/SNI but destination/window is not verified — forging instead of proxying"})
                # fall through: forge it below (do NOT proxy to the unverified destination)

        # harness telemetry (SECURITY REVIEW FINDING, CONFIRMED AND FIXED): `intended`
        # is derived from `req.pretty_host`, which mitmproxy takes from the attacker-
        # controllable Host header for a plain-HTTP flow — a string match alone here
        # would let ANY connection (to any real destination) claim to be harness
        # telemetry just by setting `Host: cr-harness.cr.internal`, making that
        # traffic invisible to assemble-forensics.py (which skips records whose host
        # matches the telemetry host, treating them as trusted self-observation, not
        # captured attacker intent). Require the connection's REAL destination IP to
        # actually be this gateway's own IP — the one thing an attacker cannot spoof,
        # since it's recovered via SO_ORIGINAL_DST from the actual routed connection,
        # not from anything the client sent.
        actual_dest_ip = None
        try:
            if flow.server_conn and flow.server_conn.address:
                actual_dest_ip = str(flow.server_conn.address[0])
        except Exception:  # noqa: BLE001
            actual_dest_ip = None
        is_harness = (intended or "").lower() in HARNESS_HOSTS and actual_dest_ip == GATEWAY_SELF_IP
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
        # Mark explicitly so `response()` below never has to RE-DERIVE "was this
        # forged" from the same host regex a second time — re-deriving it risked
        # drifting out of sync with the window/verification state actually used
        # here (e.g. a source_host whose clone window had expired IS forged, even
        # though its host still matches SOURCE_HOST_RE) and had silently mis-skipped
        # logging a genuinely forged response as if it were a real passthrough.
        flow.metadata["cr_forged"] = True
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
        # Skip genuinely-passed-through flows — those are REAL upstream responses.
        # Keyed off the explicit `cr_forged` marker `request()` sets (not a second,
        # independent host-regex check) — see the comment where that marker is set.
        if flow.response is not None:
            if not flow.metadata.get("cr_forged"):
                return
            sni = getattr(flow.client_conn, "sni", None)
            host = sni or flow.request.pretty_host or ""
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
