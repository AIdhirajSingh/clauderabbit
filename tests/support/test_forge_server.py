"""Test-only forge server for the keyless e2e test (never shipped in the template).

It drives the production forge policy, sandbox/e2b/guest/forge_core.py, the same
way forge_addon.py does inside the VM: every HTTPS request becomes a
forge_core.Request, forge_core.Forge.handle decides the reply, and
forge_core.capture_record / append_capture write the capture line. DNS queries
go through forge_core.Forge.dns_answer. The upstream fetcher refuses every
request, so nothing here ever reaches the network.

Usage: python3 test_forge_server.py <policy.json> <cert.pem> <key.pem>
Prints {"https": <port>, "dns": <port>} on the first stdout line, then serves
until stdin closes.
"""

from __future__ import annotations

import json
import os
import socket
import ssl
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "sandbox", "e2b", "guest"))

import forge_core as fc  # noqa: E402


def refuse_upstream(url, headers):
    return 599, {}, b"test forge has no upstream"


def parse_dns_query(packet: bytes):
    if len(packet) < 12:
        return None
    qid, flags, qd, _an, _ns, _ar = struct.unpack("!HHHHHH", packet[:12])
    if qd < 1:
        return None
    i = 12
    labels = []
    while i < len(packet):
        n = packet[i]
        i += 1
        if n == 0:
            break
        labels.append(packet[i:i + n].decode("ascii", errors="replace"))
        i += n
    if i + 4 > len(packet):
        return None
    qtype, qclass = struct.unpack("!HH", packet[i:i + 4])
    question = packet[12:i + 4]
    return qid, flags, ".".join(labels), qtype, qclass, question


QTYPES = {1: "A", 28: "AAAA", 5: "CNAME", 15: "MX", 16: "TXT", 33: "SRV", 65: "HTTPS"}


def build_dns_response(qid: int, flags: int, question: bytes, ip):
    rflags = 0x8000 | (flags & 0x0100) | 0x0080  # QR, copy RD, RA
    answers = b""
    an = 0
    if ip is not None:
        answers = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 30, 4) + socket.inet_aton(ip)
        an = 1
    return struct.pack("!HHHHHH", qid, rflags, 1, an, 0, 0) + question + answers


def main() -> int:
    policy_path, cert, key = sys.argv[1], sys.argv[2], sys.argv[3]
    policy = fc.load_policy(policy_path)
    forge = fc.Forge(policy, fc.Mirror(policy["mirror_root"]), refuse_upstream)

    def record(**fields):
        rec = fc.capture_record(policy, t=time.time(), phase=fc.read_phase(policy["phase_path"]), **fields)
        fc.append_capture(policy["capture_path"], rec)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            return

        def _handle(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length > 0 else b""
            sni = getattr(self.connection, "cr_sni", None)
            host = sni or (self.headers.get("Host") or "").split(":", 1)[0]
            req = fc.Request(
                method=self.command,
                host=host,
                port=443,
                path=self.path,
                headers=fc.normalize_headers(self.headers.items()),
                body=body,
            )
            d = forge.handle(req)
            # Record before replying, as forge_addon.py does: a client that exits on the
            # reply must never be able to outrun its own capture line (the cause of the
            # ops-smoke and keyless e2e flakes under full-suite load).
            record(proto="https", host=host, port=443, method=self.command, path=self.path, sni=sni,
                   req_headers=req.headers, req_body=body, forged_kind=d.forged_kind, tls="intercepted",
                   status=d.status, integrity=d.integrity)
            self.send_response(d.status)
            for k, v in d.headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(d.body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(d.body)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _handle

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)

    def sni_cb(sslsock, server_name, _ctx):
        sslsock.cr_sni = server_name

    ctx.sni_callback = sni_cb
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    httpd.daemon_threads = True
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.1", 0))

    def dns_loop():
        while True:
            try:
                packet, addr = udp.recvfrom(4096)
            except OSError:
                return
            q = parse_dns_query(packet)
            if q is None:
                continue
            qid, flags, name, qtype, _qclass, question = q
            tname = QTYPES.get(qtype, str(qtype))
            ip = forge.dns_answer(name, tname)
            record(proto="dns", host=name, port=53, method=tname, forged_kind="dns")
            udp.sendto(build_dns_response(qid, flags, question, ip), addr)

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=dns_loop, daemon=True).start()
    print(json.dumps({"https": httpd.server_address[1], "dns": udp.getsockname()[1]}), flush=True)
    sys.stdin.read()
    httpd.shutdown()
    udp.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
