"""mitmproxy glue for the ClaudeRabbit forge (DESIGN.md section 3.3 step 3).

Started by cr-detonate.sh as root:
  mitmdump --mode transparent@8080 --mode dns@127.0.0.1:5353 --set confdir=/root/.cr/mitm \
    --set connection_strategy=lazy --set upstream_cert=false -s /opt/cr/forge/forge_addon.py

All decisions live in forge_core.py. This file only converts mitmproxy flows to
forge_core requests, applies the decision and appends one capture record per
request, DNS query, refused TLS handshake and raw TCP connection. With
connection_strategy=lazy and every forged HTTP response set in `request`,
mitmproxy never opens an upstream connection for repo traffic.

Registry traffic (an https GET of a registry shape on a registry host, see
forge_core.registry_kind) passes straight through: mitmproxy connects to the real
registry and streams the response to the client as it arrives, with no fetch in
a worker thread, no whole-body buffer and no forge-side hashing. The package
manager checks every tarball against its lockfile or packument integrity itself.
Each such request is still logged as registry traffic, with its time to response
headers. Metadata for prebuilt binaries of another platform is answered 404
without any upstream fetch (forge_core.foreign_platform_package).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import ipaddress
import os
import sys
import time

from mitmproxy import dns, http, tcp, tls

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forge_core  # noqa: E402

POLICY_PATH = os.environ.get("CR_FORGE_POLICY", "/opt/cr/forge/policy.json")

# Registry pass-through blocks on an upstream fetch. asyncio's default pool is
# min(32, cpu + 4) threads, which is 5 on the 1 vCPU VM, so npm's parallel
# packument and tarball requests queued five at a time. Forged replies do no I/O
# and are unaffected by the pool size.
HANDLE_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=32, thread_name_prefix="cr-forge")
# Decisions that carry real registry bytes keep the client connection open so npm
# reuses its TLS session to the forge; every forged reply still closes.
KEEPALIVE_KINDS = ("registry", "mirror")


class CrForge:
    def __init__(self) -> None:
        self.policy = forge_core.load_policy(POLICY_PATH)
        self.mirror = forge_core.Mirror(self.policy["mirror_root"])
        self.forge = forge_core.Forge(
            self.policy,
            self.mirror,
            forge_core.urllib_fetcher(float(self.policy.get("upstream_timeout_s", 15)), int(self.policy.get("upstream_max_bytes", 104857600))),
        )
        self.capture_path = self.policy["capture_path"]
        self.phase_path = self.policy["phase_path"]

    def _phase(self) -> str:
        return forge_core.read_phase(self.phase_path)

    def _host_for(self, sni, host_header, ip) -> str:
        if sni:
            return sni
        if host_header:
            return host_header
        named = self.forge.name_for_ip(str(ip)) if ip else None
        return named or str(ip or "")

    def _record(self, **fields) -> None:
        rec = forge_core.capture_record(self.policy, t=time.time(), phase=self._phase(), **fields)
        forge_core.append_capture(self.capture_path, rec)

    async def request(self, flow: http.HTTPFlow) -> None:
        r = flow.request
        sni = getattr(flow.client_conn, "sni", None)
        host_header = r.host_header.split(":", 1)[0] if r.host_header else None
        dest_ip = flow.server_conn.address[0] if flow.server_conn and flow.server_conn.address else None
        host = self._host_for(sni, host_header, dest_ip)
        req = forge_core.Request(
            method=r.method,
            host=host,
            port=int(r.port),
            path=r.path,
            headers=forge_core.normalize_headers(r.headers.items(multi=True)),
            body=r.raw_content or b"",
            scheme=r.scheme,
        )
        kind = forge_core.registry_kind(self.policy, host, r.method, r.path)
        if kind in ("npm-packument", "npm-version") and forge_core.foreign_platform_package(forge_core.npm_name_from_path(req.bare_path)):
            flow.response = http.Response.make(404, b'{"error":"not found"}', {"Content-Type": "application/json", "Connection": "keep-alive"})
            self._registry_record(flow, host, sni, req, 404, 0.0, note="other platform", passed=False)
            return
        if kind is not None and r.scheme == "https" and int(r.port) == 443:
            # Pass through: connect to the registry by name and stream the reply.
            r.host = host
            flow.metadata["cr_registry"] = {"t0": time.monotonic(), "host": host, "sni": sni, "req": req}
            return
        decision = await asyncio.get_running_loop().run_in_executor(HANDLE_POOL, self.forge.handle, req)
        connection = "keep-alive" if decision.forged_kind in KEEPALIVE_KINDS else "close"
        flow.response = http.Response.make(decision.status, decision.body, {**decision.headers, "Connection": connection})
        https = r.scheme == "https"
        self._record(
            proto="https" if https else "http",
            host=host,
            port=int(r.port),
            method=r.method,
            path=r.path,
            sni=sni,
            req_headers=req.headers,
            req_body=req.body,
            forged_kind=decision.forged_kind,
            tls="intercepted" if https else None,
            status=decision.status,
            integrity=decision.integrity,
        )

    def _registry_record(self, flow, host, sni, req, status, ms, note=None, passed=True) -> None:
        rec = forge_core.capture_record(
            self.policy,
            t=time.time(),
            phase=self._phase(),
            proto="https",
            host=host,
            port=int(flow.request.port),
            method=req.method,
            path=req.path,
            sni=sni,
            req_headers=req.headers,
            req_body=req.body,
            forged_kind="registry",
            tls="intercepted",
            status=status,
        )
        rec["ms"] = round(ms, 1)
        rec["pass"] = passed
        if note:
            rec["note"] = note
        forge_core.append_capture(self.capture_path, rec)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        meta = flow.metadata.get("cr_registry")
        if not meta or flow.response is None:
            return
        flow.response.stream = True
        self._registry_record(flow, meta["host"], meta["sni"], meta["req"], flow.response.status_code, (time.monotonic() - meta["t0"]) * 1000)

    def error(self, flow: http.HTTPFlow) -> None:
        meta = flow.metadata.get("cr_registry")
        if not meta or flow.response is not None:
            return
        self._registry_record(flow, meta["host"], meta["sni"], meta["req"], 502, (time.monotonic() - meta["t0"]) * 1000, note=f"upstream error: {flow.error}"[:300])

    def tls_failed_client(self, data: tls.TlsData) -> None:
        sni = getattr(data.conn, "sni", None)
        addr = data.context.server.address if data.context and data.context.server else None
        ip = addr[0] if addr else None
        port = addr[1] if addr else 443
        self._record(
            proto="tcp",
            host=self._host_for(sni, None, ip),
            port=int(port),
            sni=sni,
            forged_kind="tls_refused",
            tls="refused",
        )

    def dns_request(self, flow: dns.DNSFlow) -> None:
        answers = []
        for q in flow.request.questions:
            qtype = dns.types.to_str(q.type)
            ip = self.forge.dns_answer(q.name, qtype)
            if ip is not None:
                answers.append(dns.ResourceRecord.A(q.name, ipaddress.IPv4Address(ip), ttl=30))
            self._record(proto="dns", host=q.name, port=53, method=qtype, forged_kind="dns")
        flow.response = flow.request.succeed(answers)

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        addr = flow.server_conn.address if flow.server_conn else None
        ip = addr[0] if addr else None
        sni = getattr(flow.client_conn, "sni", None)
        self._record(
            proto="tcp",
            host=self._host_for(sni, None, ip),
            port=int(addr[1]) if addr else 0,
            sni=sni,
            forged_kind="tcp_closed",
            tls="intercepted" if sni else None,
        )
        flow.kill()


addons = [CrForge()]
