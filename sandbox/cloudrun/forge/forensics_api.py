#!/usr/bin/env python3
"""
forensics_api.py — the NVA gateway's control-plane API for the Cloud Run detonation
harness. Stdlib-only (no extra deps on the gateway beyond mitmproxy itself).

WHY THIS EXISTS: the forge gateway (cr-forge-gateway) is now a single shared, always-on
VM that many concurrent Cloud Run detonation executions route through — unlike the old
per-run netns, where forge-up.sh gave each run its OWN capture file. mitmproxy's addon
(forge_addon.py) tags every captured record with the connecting execution's source IP,
but the Cloud Run container itself has no way to read a file on this VM's local disk —
it needs an API. This process is that API, and it listens on a port EXCLUDED from the
iptables REDIRECT (see provision-forge-gateway.sh) so it is reachable directly, not
intercepted as if it were untrusted egress.

Contract (all requests must originate from the Cloud Run subnet — enforced by the
existing cr-sandbox-allow-trap-ingress firewall rule, source range 10.200.0.0/24 only):

  POST /register   {"scan_id": "<opaque>"}
      Registers the CALLING connection's source IP (read off the actual TCP socket,
      never trusted from the request body) against scan_id, stamped with the
      registration time. A source_ip can be re-registered under a new scan_id later
      (Cloud Run reassigns IPs across executions over time) — the newest registration
      for an IP always wins, and its `since` timestamp bounds which capture lines can
      ever be attributed to it.

  GET /forensics?scan_id=<opaque>
      Returns every captured record (from forge_addon.py's capture.jsonl) whose
      source_ip matches the IP last registered for scan_id AND whose timestamp is
      >= that registration's `since` — i.e., only what THIS scan could plausibly have
      generated. Unregistered/expired scan_id -> empty list (fails closed: no
      match means no records, never another scan's data). One-shot per scan_id: a
      successful GET also unregisters it, forcing the caller to keep its own copy.

  GET /ca-cert
      Returns mitmproxy's CA public certificate (PEM). The Cloud Run container's
      entrypoint installs this into its trust store BEFORE running any untrusted
      code, so non-pinning TLS clients complete the handshake against our forged
      leaf — exactly the guest-rootfs step the old detonation-base.Dockerfile did
      at BUILD time, just fetched at RUN time here since many ephemeral containers
      share one gateway/CA rather than each baking a copy.

Hermetic cleanup: a background thread purges registrations (and now-orphaned capture
lines) older than CR_FORENSICS_MAX_AGE_S, so a crashed/never-collected scan can't pin
capture.jsonl's growth forever and no scan's data lingers past its own reasonable
window — the same "empty room" principle as the old per-run capture file, just time-
bounded instead of process-lifetime-bounded.
"""
from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

CAPTURE_PATH = os.environ.get("CR_FORGE_CAPTURE", "/var/log/cr-forge/capture.jsonl")
CA_CERT_PATH = os.environ.get("CR_FORGE_CA_CERT", "/root/.mitmproxy/mitmproxy-ca-cert.pem")
REGISTRY_PATH = os.environ.get("CR_FORENSICS_REGISTRY", "/var/log/cr-forge/registry.json")
MAX_AGE_S = int(os.environ.get("CR_FORENSICS_MAX_AGE_S", "3600"))
PORT = int(os.environ.get("CR_FORENSICS_PORT", "8090"))

_lock = threading.Lock()


def _load_registry() -> dict[str, dict]:
    try:
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 — missing/corrupt registry starts fresh, never crashes
        return {}


def _save_registry(reg: dict[str, dict]) -> None:
    os.makedirs(os.path.dirname(REGISTRY_PATH), exist_ok=True)
    tmp = REGISTRY_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f)
    os.replace(tmp, REGISTRY_PATH)


def _read_capture_for(source_ip: str, since: float) -> list[dict]:
    out: list[dict] = []
    if not source_ip or not os.path.exists(CAPTURE_PATH):
        return out
    try:
        with open(CAPTURE_PATH, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("source_ip") == source_ip and float(rec.get("t", 0)) >= since:
                    out.append(rec)
    except OSError:
        pass
    return out


def _cleanup_loop() -> None:
    while True:
        time.sleep(300)
        cutoff = time.time() - MAX_AGE_S
        with _lock:
            reg = _load_registry()
            fresh = {sid: v for sid, v in reg.items() if v.get("since", 0) >= cutoff}
            if fresh != reg:
                _save_registry(fresh)
        # Rotate capture.jsonl if it has grown to hold only stale (already-expired)
        # records — bounds the shared file's lifetime growth. Keep any record newer
        # than cutoff so an in-flight scan's data is never truncated mid-run.
        try:
            if os.path.exists(CAPTURE_PATH):
                kept = []
                with open(CAPTURE_PATH, encoding="utf-8", errors="replace") as f:
                    for line in f:
                        s = line.strip()
                        if not s:
                            continue
                        try:
                            rec = json.loads(s)
                        except json.JSONDecodeError:
                            continue
                        if float(rec.get("t", 0)) >= cutoff:
                            kept.append(s)
                if kept:
                    tmp = CAPTURE_PATH + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.write("\n".join(kept) + "\n")
                    os.replace(tmp, CAPTURE_PATH)
                else:
                    open(CAPTURE_PATH, "w", encoding="utf-8").close()
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A002 — quiet; systemd journal has enough
        pass

    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's naming convention
        parsed = urlparse(self.path)
        if parsed.path != "/register":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}
        scan_id = str(body.get("scan_id") or "").strip()
        if not scan_id:
            self._json(400, {"error": "scan_id required"})
            return
        source_ip = self.client_address[0]  # from the socket, never trusted from the body
        with _lock:
            reg = _load_registry()
            reg[scan_id] = {"source_ip": source_ip, "since": time.time()}
            _save_registry(reg)
        self._json(200, {"ok": True, "scan_id": scan_id, "source_ip": source_ip})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/ca-cert":
            try:
                with open(CA_CERT_PATH, "rb") as f:
                    pem = f.read()
            except OSError:
                self._json(404, {"error": "ca cert not found"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/x-pem-file")
            self.send_header("Content-Length", str(len(pem)))
            self.end_headers()
            self.wfile.write(pem)
            return
        if parsed.path == "/forensics":
            qs = parse_qs(parsed.query)
            scan_id = (qs.get("scan_id") or [""])[0].strip()
            if not scan_id:
                self._json(400, {"error": "scan_id required"})
                return
            with _lock:
                reg = _load_registry()
                entry = reg.pop(scan_id, None)  # one-shot: consumed on read
                _save_registry(reg)
            if not entry:
                self._json(200, {"scan_id": scan_id, "records": [], "note": "no registration found (expired or never registered)"})
                return
            records = _read_capture_for(entry["source_ip"], entry["since"])
            self._json(200, {"scan_id": scan_id, "records": records})
            return
        if parsed.path == "/healthz":
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not found"})


def main() -> None:
    threading.Thread(target=_cleanup_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"CR_FORENSICS_API listening :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
