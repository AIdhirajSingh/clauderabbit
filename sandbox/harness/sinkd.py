#!/usr/bin/env python3
"""
sinkd.py — the catch-all SINKHOLE server. Runs ON the trap/control host (which
is OUTSIDE the detonation VM and which the running code cannot detect, kill, or
forge). It is the network half of "let the code do what it would do, watch ALL
of it, but never let a single real packet reach a real destination."

What it does:
  - Listens on a wide range of TCP ports (the common exfil/beacon ports plus a
    catch-all) bound to the trap's PRIVATE interface.
  - Accepts ANY TCP connection. It first peeks at the first bytes:
      * If it looks like a TLS ClientHello, it terminates TLS with a throwaway
        self-signed cert (extracting the SNI from the handshake first) and then
        reads the inner request — so an HTTPS POST exfil is captured in the clear.
      * Otherwise it treats it as plaintext (HTTP or raw) and reads it directly.
  - Speaks just enough HTTP to return "200 OK" so the client BELIEVES the
    exfil/beacon succeeded (maximizing what the malware reveals — it may send a
    second-stage payload if it thinks the first landed).
  - Records, per connection: timestamp, source IP, destination port, whether TLS,
    the SNI (TLS) or Host header (HTTP), the request line / path / method, all
    request headers, and the FULL body captured INERT (base64) — never delivered
    anywhere. Everything is appended as one JSON line to the capture log.

CONTAINMENT: this process NEVER opens an outbound socket. It is a pure terminator
— it absorbs and records, it does not forward. The intended real destination is
resolved later, OFF this host, in the separate disposable analysis env, for
intelligence only. (The trap host additionally runs with ip_forward=0 + FORWARD
DROP + no MASQUERADE, set by trap-host.sh, so the kernel cannot route onward
either — defense in depth.)

DNS is handled separately by dnsmasq (answers every query with the trap IP);
this server handles the resulting TCP/TLS/HTTP connections.

Usage:
  sinkd.py --capture /var/log/cr-sink/capture.jsonl --cert /etc/cr-sink/sink.pem \
           --bind 10.200.0.2 [--ports 80,443,8080,...]
  (--bind is REQUIRED — bind the trap's PRIVATE interface, never all interfaces.)
"""
import argparse
import base64
import json
import os
import select
import socket
import ssl
import sys
import threading
import time
from datetime import datetime, timezone

# Ports we explicitly listen on. The DNAT on the detonation VM redirects ALL
# outbound TCP to the trap, preserving the original destination PORT, so we must
# be listening on whatever port the malware chose. We bind a broad set of common
# exfil/beacon/protocol ports; anything outside this set is still DENIED from
# leaving (deny-1000) and additionally we run an optional wide sweep.
DEFAULT_PORTS = [
    80, 443, 8080, 8443, 8000, 8888, 53, 21, 22, 23, 25, 110, 143, 587, 993,
    995, 3306, 5432, 6379, 27017, 9000, 9001, 4444, 1337, 31337, 6667, 1234,
    50000, 5000, 3000, 8081, 9090, 9999, 7777, 2222,
]

CAPTURE_LOCK = threading.Lock()
RECV_LIMIT = 256 * 1024   # cap captured body per connection (inert, bounded)
CAPTURE_MAX_BYTES = 500 * 1024 * 1024  # cap total capture file (anti-disk-fill)
PEEK_LEN = 8
_capture_full = False     # set once the capture file hits the cap

# Bounded concurrency: every accepted connection used to spawn an UNBOUNDED
# thread, so a connection flood from detonated code (all DNAT'd here) could
# exhaust trap memory/threads, OOM the sink, and BLIND the recorder — defeating
# the whole point of the external monitor. We cap concurrent handlers with a
# semaphore: acquire (with a short timeout) BEFORE spawning; if we cannot, we
# record a `dropped_connection` entry and close the socket rather than blocking
# the accept loop or growing without limit.
MAX_INFLIGHT = 500
CONN_SEMAPHORE = threading.Semaphore(MAX_INFLIGHT)
SEMAPHORE_ACQUIRE_TIMEOUT = 0.25  # seconds; short so the accept loop never stalls


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def record(capture_path, entry):
    """Append one capture entry as a JSON line. The ONLY output side effect.
    Bounded by CAPTURE_MAX_BYTES so a flood of connections (all DNAT'd here)
    cannot fill the trap's disk and lose the whole forensic record."""
    global _capture_full
    entry["captured_at"] = now_iso()
    line = json.dumps(entry, separators=(",", ":"))
    with CAPTURE_LOCK:
        if _capture_full:
            return
        try:
            if os.path.exists(capture_path) and os.path.getsize(capture_path) >= CAPTURE_MAX_BYTES:
                _capture_full = True
                with open(capture_path, "a") as f:
                    f.write(json.dumps({"event": "capture_truncated",
                                        "reason": "size cap reached"}) + "\n")
                return
        except OSError:
            pass
        with open(capture_path, "a") as f:
            f.write(line + "\n")
            f.flush()


def parse_sni(client_hello):
    """Best-effort SNI extraction from a raw TLS ClientHello (bytes).
    Returns the server name string or None. Pure parsing, no network."""
    try:
        # TLS record: type(1)=0x16 handshake, version(2), length(2)
        if len(client_hello) < 43 or client_hello[0] != 0x16:
            return None
        # Skip record header (5) + handshake header (4) + version (2) +
        # random (32) = 43; then session id, cipher suites, compression,
        # then extensions.
        idx = 43
        # session id
        sid_len = client_hello[idx]; idx += 1 + sid_len
        # cipher suites
        cs_len = int.from_bytes(client_hello[idx:idx + 2], "big"); idx += 2 + cs_len
        # compression methods
        comp_len = client_hello[idx]; idx += 1 + comp_len
        # extensions
        if idx + 2 > len(client_hello):
            return None
        ext_total = int.from_bytes(client_hello[idx:idx + 2], "big"); idx += 2
        end = idx + ext_total
        while idx + 4 <= end and idx + 4 <= len(client_hello):
            ext_type = int.from_bytes(client_hello[idx:idx + 2], "big")
            ext_len = int.from_bytes(client_hello[idx + 2:idx + 4], "big")
            idx += 4
            if ext_type == 0x0000:  # server_name
                # server_name_list len(2), name_type(1), name_len(2), name
                ni = idx + 2 + 1
                name_len = int.from_bytes(client_hello[ni:ni + 2], "big")
                ni += 2
                return client_hello[ni:ni + name_len].decode("idna", "replace")
            idx += ext_len
    except Exception:  # noqa: BLE001 — parsing hostile bytes, never trust them
        return None
    return None


def parse_http(blob):
    """Parse a raw HTTP request blob (bytes) into method/path/host/headers/body.
    Returns a dict; tolerant of garbage (records what it can)."""
    out = {"method": None, "path": None, "host": None, "headers": {}, "body_b64": None}
    try:
        head, _, body = blob.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        if lines:
            req = lines[0].decode("latin-1", "replace").split()
            if len(req) >= 2:
                out["method"] = req[0]
                out["path"] = req[1]
        for ln in lines[1:]:
            if b":" in ln:
                k, _, v = ln.partition(b":")
                key = k.decode("latin-1", "replace").strip()
                val = v.decode("latin-1", "replace").strip()
                out["headers"][key] = val
                if key.lower() == "host":
                    out["host"] = val
        if body:
            out["body_b64"] = base64.b64encode(body[:RECV_LIMIT]).decode("ascii")
    except Exception:  # noqa: BLE001
        pass
    return out


HTTP_OK = (
    b"HTTP/1.1 200 OK\r\n"
    b"Content-Type: application/json\r\n"
    b"Content-Length: 16\r\n"
    b"Connection: close\r\n\r\n"
    b'{"status":"ok"}\n'
)


def drain(sock, first=b""):
    """Read up to RECV_LIMIT bytes (inert capture), with a short idle timeout."""
    data = bytearray(first)
    sock.settimeout(2.5)
    try:
        while len(data) < RECV_LIMIT:
            chunk = sock.recv(8192)
            if not chunk:
                break
            data += chunk
    except (socket.timeout, OSError):
        pass
    return bytes(data)


def handle_plain(conn, addr, dest_port, peeked, capture_path):
    blob = drain(conn, peeked)
    http = parse_http(blob)
    entry = {
        "transport": "tcp",
        "tls": False,
        "src_ip": addr[0],
        "dest_port": dest_port,
        "sni": None,
        "intended_host": http.get("host"),
        "http_method": http.get("method"),
        "http_path": http.get("path"),
        "http_headers": http.get("headers"),
        "payload_b64": http.get("body_b64") or base64.b64encode(blob[:RECV_LIMIT]).decode("ascii"),
        "raw_len": len(blob),
    }
    record(capture_path, entry)
    # Make the client believe it succeeded so it reveals more.
    try:
        conn.sendall(HTTP_OK)
    except OSError:
        pass


def handle_tls(conn, addr, dest_port, sni, ctx, capture_path):
    try:
        tls = ctx.wrap_socket(conn, server_side=True)
    except (ssl.SSLError, OSError) as e:
        # Even a failed TLS handshake is a captured attempt: record the SNI.
        record(capture_path, {
            "transport": "tcp", "tls": True, "tls_handshake": "failed",
            "src_ip": addr[0], "dest_port": dest_port, "sni": sni,
            "intended_host": sni, "error": str(e),
        })
        return
    blob = drain(tls)
    http = parse_http(blob)
    entry = {
        "transport": "tcp",
        "tls": True,
        "tls_handshake": "completed",
        "src_ip": addr[0],
        "dest_port": dest_port,
        "sni": sni,
        # SNI is the most reliable intended-host signal for TLS; Host header
        # corroborates (and may differ — record both).
        "intended_host": sni or http.get("host"),
        "http_host_header": http.get("host"),
        "http_method": http.get("method"),
        "http_path": http.get("path"),
        "http_headers": http.get("headers"),
        "payload_b64": http.get("body_b64") or base64.b64encode(blob[:RECV_LIMIT]).decode("ascii"),
        "raw_len": len(blob),
    }
    record(capture_path, entry)
    try:
        tls.sendall(HTTP_OK)
    except OSError:
        pass
    try:
        tls.close()
    except OSError:
        pass


def handle_conn(conn, addr, dest_port, ctx, capture_path):
    try:
        conn.settimeout(3.0)
        # Peek the first bytes to detect TLS without consuming them.
        try:
            peeked = conn.recv(PEEK_LEN, socket.MSG_PEEK)
        except (socket.timeout, OSError):
            peeked = b""
        is_tls = len(peeked) >= 3 and peeked[0] == 0x16 and peeked[1] == 0x03
        if is_tls:
            # Pull the full ClientHello for SNI (peek a larger window).
            try:
                hello = conn.recv(2048, socket.MSG_PEEK)
            except (socket.timeout, OSError):
                hello = peeked
            sni = parse_sni(hello)
            handle_tls(conn, addr, dest_port, sni, ctx, capture_path)
        else:
            # Consume the peeked bytes for real now (MSG_PEEK left them queued).
            try:
                real = conn.recv(PEEK_LEN)
            except (socket.timeout, OSError):
                real = b""
            handle_plain(conn, addr, dest_port, real, capture_path)
    except Exception as e:  # noqa: BLE001 — never let a hostile client crash the sink
        try:
            record(capture_path, {
                "transport": "tcp", "src_ip": addr[0],
                "dest_port": dest_port, "error": f"handler: {e}",
            })
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except OSError:
            pass
        # Release the in-flight slot acquired by serve_port before this thread
        # was spawned. ALWAYS released, even on hostile-input exceptions above,
        # so the concurrency budget cannot leak.
        CONN_SEMAPHORE.release()


def serve_port(port, ctx, bind, capture_path):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((bind, port))
        s.listen(64)
    except OSError as e:
        print(f"[sinkd] could not bind port {port}: {e}", file=sys.stderr)
        return
    print(f"[sinkd] listening on {bind}:{port}", file=sys.stderr)
    while True:
        try:
            conn, addr = s.accept()
        except OSError:
            continue
        # Bounded concurrency guard: only spawn a handler if we can claim an
        # in-flight slot quickly. Under a connection flood this fails fast,
        # records the drop (so the forensic record still SHOWS the flood), and
        # closes the socket — the accept loop and the recorder stay alive.
        if not CONN_SEMAPHORE.acquire(timeout=SEMAPHORE_ACQUIRE_TIMEOUT):
            record(capture_path, {
                "event": "dropped_connection",
                "transport": "tcp",
                "src_ip": addr[0],
                "dest_port": port,
                "reason": "max_inflight_exceeded",
                "max_inflight": MAX_INFLIGHT,
            })
            try:
                conn.close()
            except OSError:
                pass
            continue
        # Slot acquired; handle_conn releases it in its finally block.
        try:
            threading.Thread(
                target=handle_conn, args=(conn, addr, port, ctx, capture_path),
                daemon=True,
            ).start()
        except RuntimeError:
            # Thread creation itself failed (e.g. resource exhaustion): release
            # the slot we just took, record, and drop — do not leak the budget.
            CONN_SEMAPHORE.release()
            record(capture_path, {
                "event": "dropped_connection",
                "transport": "tcp",
                "src_ip": addr[0],
                "dest_port": port,
                "reason": "thread_spawn_failed",
            })
            try:
                conn.close()
            except OSError:
                pass


def make_ssl_ctx(cert_path):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_path)
    # Accept the broadest set of client behaviors so we terminate as many
    # exfil clients as possible. (This is a sink, not a secure server.)
    try:
        ctx.set_ciphers("ALL:@SECLEVEL=0")
    except ssl.SSLError:
        pass
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", required=True, help="path to capture JSONL log")
    ap.add_argument("--cert", required=True, help="combined PEM (cert+key) for TLS termination")
    # --bind is REQUIRED (no default): a direct/manual invocation must not be
    # able to silently bind ALL interfaces (0.0.0.0). The trap always passes the
    # private 10.200.x IP explicitly (see trap-host.sh).
    ap.add_argument("--bind", required=True,
                    help="interface IP to bind (the trap's private 10.200.x IP); required")
    ap.add_argument("--ports", default="", help="comma-separated ports (default: built-in common set)")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.capture), exist_ok=True)
    # touch the capture file so collectors always find it
    open(args.capture, "a").close()

    ports = DEFAULT_PORTS
    if args.ports.strip():
        ports = sorted({int(p) for p in args.ports.split(",") if p.strip()})

    ctx = make_ssl_ctx(args.cert)

    record(args.capture, {"event": "sinkd_start", "ports": ports, "bind": args.bind})
    print(f"[sinkd] starting catch-all sink on {len(ports)} ports", file=sys.stderr)

    threads = []
    for p in ports:
        t = threading.Thread(target=serve_port, args=(p, ctx, args.bind, args.capture), daemon=True)
        t.start()
        threads.append(t)

    # Keep the main thread alive.
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
