"""mitmproxy glue for the ClaudeRabbit forge (DESIGN.md section 3.3 step 3).

Started by cr-detonate.sh as root:
  mitmdump --mode transparent@8080 --mode dns@5353 --set confdir=/root/.cr/mitm \
    --set connection_strategy=lazy --set upstream_cert=false -s /opt/cr/forge/forge_addon.py

All decisions live in forge_core.py. This file only converts mitmproxy flows to
forge_core requests, applies the decision and appends one capture record per
request, DNS query, refused TLS handshake and raw TCP connection. With
connection_strategy=lazy and every HTTP response set in `request`, mitmproxy
never opens an upstream connection for repo traffic; registry bytes are fetched
by forge_core itself.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import sys
import time

from mitmproxy import dns, http, tcp, tls

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forge_core  # noqa: E402

POLICY_PATH = os.environ.get("CR_FORGE_POLICY", "/opt/cr/forge/policy.json")


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
        decision = await asyncio.to_thread(self.forge.handle, req)
        flow.response = http.Response.make(decision.status, decision.body, {**decision.headers, "Connection": "close"})
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
