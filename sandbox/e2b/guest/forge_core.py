"""ClaudeRabbit forge policy (DESIGN.md section 3.3 step 4).

Pure standard library. `forge_addon.py` is the thin mitmproxy glue that calls
into this module; the unit tests in `test_forge_core.py` and the keyless e2e
test's forge server drive the same functions.

Rules:
  * Registry traffic (GET on a packument, tarball, simple index or file shape on
    a host listed in policy.json) is answered with the real bytes. Metadata is
    fetched fresh from upstream by the forge (root, outside the inner fence) and
    falls back to the mirror copy only when upstream fails. Tarballs and wheels
    are served from the content-addressed mirror only when the digest that the
    metadata publishes matches the mirror blob, re-hashed on every read. Every
    blob is verified against the published digest before it is served: a
    mismatch is answered with HTTP 502 and recorded. The mirror speeds things
    up; it is never trusted.
  * Everything else is forged: a body the consumer can use (shell no-op for
    curl/wget/.sh, PowerShell no-op, JSON {"ok":true} otherwise) and one capture
    record per request.
  * DNS: every name gets a unique address from the forge pool so a later raw TCP
    connection can be attributed to the name it looked up.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional

SHELL_NOOP = b"#!/bin/sh\nexit 0\n"
PS_NOOP = b"exit 0\r\n"
JSON_OK = b'{"ok":true}'

REGISTRY_KINDS = ("mirror", "registry")
# Phases the harness writes to the phase file. Only install and entry records are
# scored; probe and collect records belong to the harness itself.
PHASES = ("install", "entry", "probe", "collect")

NPM_TARBALL_RE = re.compile(r"^/((?:@[^/]+/)?[^/@][^/]*)/-/([^/]+\.tgz)$")
NPM_PACKUMENT_RE = re.compile(r"^/((?:@[^/%]+(?:/|%2[fF]))?[^/@%][^/]*)$")
PYPI_SIMPLE_RE = re.compile(r"^/simple/([A-Za-z0-9._-]+)/?$")
PYPI_JSON_RE = re.compile(r"^/pypi/([A-Za-z0-9._-]+)(?:/([^/]+))?/json/?$")
PYPI_FILE_RE = re.compile(r"^/packages/[^?#]+/([^/?#]+)$")
HTML_HASH_RE = re.compile(r'href="([^"#]+)#sha256=([0-9a-fA-F]{64})"')


def load_policy(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        policy = json.load(f)
    for key in ("registries", "forge_ip_pool", "max_body_capture", "capture_path", "phase_path", "mirror_root"):
        if key not in policy:
            raise ValueError(f"policy.json is missing {key}")
    return policy


@dataclass
class Request:
    method: str
    host: str
    port: int
    path: str
    headers: dict = field(default_factory=dict)
    body: bytes = b""
    scheme: str = "https"

    def header(self, name: str) -> str:
        return str(self.headers.get(name.lower(), ""))

    @property
    def bare_path(self) -> str:
        return self.path.split("?", 1)[0].split("#", 1)[0]

    @property
    def url(self) -> str:
        return f"https://{self.host}{self.bare_path}"


@dataclass
class Decision:
    status: int
    headers: dict
    body: bytes
    forged_kind: str
    integrity: Optional[str] = None
    note: Optional[str] = None


def normalize_headers(pairs) -> dict:
    out: dict = {}
    for k, v in pairs:
        out[str(k).lower()] = str(v)
    return out


# ---- registry shape matching ------------------------------------------------


def registry_kind(policy: dict, host: str, method: str, path: str) -> Optional[str]:
    """Return the registry request kind, or None when the request is forged."""
    if method.upper() != "GET":
        return None
    h = host.lower().rstrip(".")
    p = path.split("?", 1)[0].split("#", 1)[0]
    regs = policy["registries"]
    if h in regs.get("npm", []):
        if NPM_TARBALL_RE.match(p):
            return "npm-tarball"
        if NPM_PACKUMENT_RE.match(p) and not p.startswith("/-/"):
            return "npm-packument"
        return None
    if h in regs.get("pypi_index", []):
        if PYPI_SIMPLE_RE.match(p):
            return "pypi-simple"
        if PYPI_JSON_RE.match(p):
            return "pypi-json"
        return None
    if h in regs.get("pypi_files", []):
        if PYPI_FILE_RE.match(p):
            return "pypi-file"
        return None
    return None


def npm_name_from_path(path: str) -> Optional[str]:
    p = path.split("?", 1)[0]
    m = NPM_TARBALL_RE.match(p)
    if m:
        return urllib.parse.unquote(m.group(1))
    m = NPM_PACKUMENT_RE.match(p)
    if m:
        return urllib.parse.unquote(m.group(1))
    return None


def normalize_pypi_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def pypi_project_from_filename(filename: str) -> Optional[str]:
    """Project name from a wheel or sdist filename (PEP 427 / PEP 625)."""
    if filename.endswith(".whl"):
        return normalize_pypi_name(filename.split("-", 1)[0])
    for ext in (".tar.gz", ".zip", ".tar.bz2", ".tgz"):
        if filename.endswith(ext):
            stem = filename[: -len(ext)]
            if "-" not in stem:
                return None
            return normalize_pypi_name(stem.rsplit("-", 1)[0])
    return None


# ---- integrity ---------------------------------------------------------------


def sri_digest(data: bytes, algo: str) -> str:
    return algo + "-" + base64.b64encode(hashlib.new(algo, data).digest()).decode("ascii")


def sri_matches(data: bytes, sri: str) -> bool:
    """True when `data` matches the strongest hash listed in an SRI string."""
    entries = []
    for token in sri.split():
        algo, _, b64 = token.partition("-")
        algo = algo.lower()
        if algo in ("sha512", "sha384", "sha256", "sha1") and b64:
            entries.append((algo, b64.split("?", 1)[0]))
    if not entries:
        return False
    rank = {"sha512": 4, "sha384": 3, "sha256": 2, "sha1": 1}
    best = max(rank[a] for a, _ in entries)
    for algo, b64 in entries:
        if rank[algo] != best:
            continue
        if base64.b64encode(hashlib.new(algo, data).digest()).decode("ascii") == b64:
            return True
    return False


def hex_to_sri(algo: str, hexdigest: str) -> str:
    return algo + "-" + base64.b64encode(bytes.fromhex(hexdigest)).decode("ascii")


def npm_digests_from_packument(body: bytes) -> dict:
    """tarball URL -> SRI string from a full or abbreviated packument."""
    try:
        doc = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    out: dict = {}
    versions = doc.get("versions") if isinstance(doc, dict) else None
    if not isinstance(versions, dict):
        return out
    for v in versions.values():
        dist = v.get("dist") if isinstance(v, dict) else None
        if not isinstance(dist, dict):
            continue
        url = dist.get("tarball")
        if not isinstance(url, str):
            continue
        url = url.split("?", 1)[0]
        integrity = dist.get("integrity")
        shasum = dist.get("shasum")
        if isinstance(integrity, str) and integrity:
            out[url] = integrity
        elif isinstance(shasum, str) and re.fullmatch(r"[0-9a-fA-F]{40}", shasum):
            out[url] = hex_to_sri("sha1", shasum)
    return out


def pypi_digests_from_index(body: bytes, base_url: str, content_type: str) -> dict:
    """file URL -> SRI string from a PEP 691 JSON or PEP 503 HTML simple index, or the JSON API."""
    out: dict = {}
    text = body.decode("utf-8", errors="replace")
    if "json" in content_type.lower() or text.lstrip().startswith("{"):
        try:
            doc = json.loads(text)
        except json.JSONDecodeError:
            return out
        files = []
        if isinstance(doc.get("files"), list):
            files = doc["files"]
        elif isinstance(doc.get("urls"), list):
            files = doc["urls"]
        for f in files:
            if not isinstance(f, dict):
                continue
            url = f.get("url")
            hashes = f.get("hashes") or f.get("digests") or {}
            sha = hashes.get("sha256") if isinstance(hashes, dict) else None
            if isinstance(url, str) and isinstance(sha, str) and re.fullmatch(r"[0-9a-fA-F]{64}", sha):
                out[urllib.parse.urljoin(base_url, url).split("#", 1)[0]] = hex_to_sri("sha256", sha)
        return out
    for href, sha in HTML_HASH_RE.findall(text):
        out[urllib.parse.urljoin(base_url, href).split("#", 1)[0]] = hex_to_sri("sha256", sha.lower())
    return out


# ---- mirror ------------------------------------------------------------------


class Mirror:
    """Content-addressed cache. Blobs are only ever returned after re-hashing."""

    def __init__(self, root: str):
        self.root = root

    def _blob_path(self, sri: str) -> Optional[str]:
        algo, _, b64 = sri.split()[0].partition("-")
        try:
            hexd = base64.b64decode(b64, validate=True).hex()
        except (ValueError, TypeError):
            return None
        if algo not in ("sha512", "sha384", "sha256", "sha1"):
            return None
        return os.path.join(self.root, "blobs", algo, hexd)

    def get_blob(self, sri: str) -> Optional[bytes]:
        path = self._blob_path(_strongest(sri))
        if not path or not os.path.isfile(path):
            return None
        with open(path, "rb") as f:
            data = f.read()
        return data if sri_matches(data, sri) else None

    def put_blob(self, sri: str, data: bytes) -> None:
        if not sri_matches(data, sri):
            raise ValueError("refusing to store a blob that does not match its digest")
        path = self._blob_path(_strongest(sri))
        if not path:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)

    def _meta_key(self, url: str, accept: str) -> str:
        return hashlib.sha256((url + "\n" + accept).encode("utf-8")).hexdigest()

    def get_meta(self, url: str, accept: str) -> Optional[tuple]:
        base = os.path.join(self.root, "meta", self._meta_key(url, accept))
        if not os.path.isfile(base + ".json") or not os.path.isfile(base + ".body"):
            return None
        with open(base + ".json", "r", encoding="utf-8") as f:
            info = json.load(f)
        with open(base + ".body", "rb") as f:
            body = f.read()
        return info.get("content_type", "application/octet-stream"), body

    def put_meta(self, url: str, accept: str, content_type: str, body: bytes) -> None:
        base = os.path.join(self.root, "meta", self._meta_key(url, accept))
        os.makedirs(os.path.dirname(base), exist_ok=True)
        with open(base + ".body.tmp", "wb") as f:
            f.write(body)
        os.replace(base + ".body.tmp", base + ".body")
        with open(base + ".json.tmp", "w", encoding="utf-8") as f:
            json.dump({"url": url, "accept": accept, "content_type": content_type}, f)
        os.replace(base + ".json.tmp", base + ".json")


def _strongest(sri: str) -> str:
    rank = {"sha512": 4, "sha384": 3, "sha256": 2, "sha1": 1}
    tokens = [t for t in sri.split() if t.partition("-")[0].lower() in rank]
    if not tokens:
        return sri
    return max(tokens, key=lambda t: rank[t.partition("-")[0].lower()])


# ---- upstream ------------------------------------------------------------------

Fetcher = Callable[[str, dict], tuple]


def urllib_fetcher(timeout_s: float, max_bytes: int) -> Fetcher:
    """Upstream GET as root. Root traffic is not redirected by the inner fence; the
    E2B outer fence only lets it reach the registry hostnames."""

    def fetch(url: str, headers: dict) -> tuple:
        req = urllib.request.Request(url, headers={**headers, "User-Agent": "ClaudeRabbit-Forge/2.0"}, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as res:  # noqa: S310 (https registry URLs only)
                body = res.read(max_bytes + 1)
                if len(body) > max_bytes:
                    return 502, {}, b"upstream body over cap"
                return res.status, {k.lower(): v for k, v in res.headers.items()}, body
        except urllib.error.HTTPError as e:
            return e.code, {}, e.read(65536)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return 599, {}, str(e).encode("utf-8", errors="replace")

    return fetch


# ---- forged replies ----------------------------------------------------------


def forged_reply(req: Request) -> Decision:
    """A body the consumer can use so the install runs to completion."""
    ua = req.header("user-agent").lower()
    accept = req.header("accept").lower()
    path = req.bare_path.lower()
    if path.endswith((".sh", ".bash")) or "x-sh" in accept or "shellscript" in accept:
        return Decision(200, {"Content-Type": "text/x-shellscript"}, SHELL_NOOP, "shell")
    if path.endswith(".ps1") or "powershell" in ua:
        return Decision(200, {"Content-Type": "text/plain"}, PS_NOOP, "powershell")
    if "curl/" in ua or "wget" in ua or "libcurl" in ua:
        return Decision(200, {"Content-Type": "text/x-shellscript"}, SHELL_NOOP, "shell")
    return Decision(200, {"Content-Type": "application/json"}, JSON_OK, "json")


# ---- the forge -----------------------------------------------------------------


class Forge:
    def __init__(self, policy: dict, mirror: Mirror, fetch: Fetcher, clock: Callable[[], float] = time.time):
        self.policy = policy
        self.mirror = mirror
        self.fetch = fetch
        self.clock = clock
        self.digests: dict = {}
        # Blob URLs whose expected digest came from mirror metadata (upstream was
        # down). Those blobs are verified only against the seeded mirror, so the
        # capture marks them "mirror-metadata" and the score treats the run's
        # coverage as partial.
        self.mirror_digest_urls: set = set()
        self._lock = threading.Lock()
        self._ip_by_name: dict = {}
        self._name_by_ip: dict = {}
        pool = ipaddress.ip_network(policy["forge_ip_pool"], strict=False)
        self._pool = pool
        self._next = 10

    # DNS ---------------------------------------------------------------------

    def dns_answer(self, qname: str, qtype: str) -> Optional[str]:
        """IPv4 address for an A query (unique per name); None (empty NOERROR) otherwise."""
        name = qname.lower().rstrip(".")
        if qtype.upper() != "A" or not name:
            return None
        with self._lock:
            ip = self._ip_by_name.get(name)
            if ip is None:
                if self._next >= self._pool.num_addresses - 1:
                    self._next = 10
                ip = str(self._pool.network_address + self._next)
                self._next += 1
                old = self._name_by_ip.get(ip)
                if old is not None:
                    self._ip_by_name.pop(old, None)
                self._ip_by_name[name] = ip
                self._name_by_ip[ip] = name
            return ip

    def name_for_ip(self, ip: str) -> Optional[str]:
        with self._lock:
            return self._name_by_ip.get(ip)

    # HTTP --------------------------------------------------------------------

    def handle(self, req: Request) -> Decision:
        kind = registry_kind(self.policy, req.host, req.method, req.path)
        if kind is None:
            return forged_reply(req)
        if kind in ("npm-packument", "pypi-simple", "pypi-json"):
            return self._metadata(req, kind)
        return self._blob(req, kind)

    def _remember(self, kind: str, url: str, content_type: str, body: bytes, from_mirror: bool = False) -> None:
        found = npm_digests_from_packument(body) if kind == "npm-packument" else pypi_digests_from_index(body, url, content_type)
        with self._lock:
            self.digests.update(found)
            if from_mirror:
                self.mirror_digest_urls.update(found.keys())
            else:
                self.mirror_digest_urls.difference_update(found.keys())

    def _metadata(self, req: Request, kind: str) -> Decision:
        accept = req.header("accept") or "application/json"
        url = req.url + (("?" + req.path.split("?", 1)[1]) if "?" in req.path else "")
        status, headers, body = self.fetch(url, {"Accept": accept})
        if status == 200:
            ctype = headers.get("content-type", "application/json")
            try:
                self.mirror.put_meta(url, accept, ctype, body)
            except OSError:
                pass
            self._remember(kind, req.url, ctype, body)
            return Decision(200, {"Content-Type": ctype}, body, "registry")
        cached = self.mirror.get_meta(url, accept)
        if cached is not None:
            ctype, body = cached
            self._remember(kind, req.url, ctype, body, from_mirror=True)
            return Decision(200, {"Content-Type": ctype}, body, "mirror", note=f"upstream {status}", integrity="mirror-metadata")
        if status in (404, 410):
            return Decision(status, {"Content-Type": "application/json"}, b'{"error":"not found"}', "registry")
        return Decision(502, {"Content-Type": "text/plain"}, b"registry unavailable", "registry", note=f"upstream {status}")

    def _expected_digest(self, req: Request, kind: str) -> Optional[str]:
        with self._lock:
            sri = self.digests.get(req.url)
        if sri:
            return sri
        if kind == "npm-tarball":
            name = npm_name_from_path(req.bare_path)
            if not name:
                return None
            enc = name.replace("/", "%2f") if name.startswith("@") else name
            meta_url = f"https://{req.host}/{enc}"
            status, headers, body = self.fetch(meta_url, {"Accept": "application/json"})
            if status != 200:
                cached = self.mirror.get_meta(meta_url, "application/json")
                if cached is None:
                    return None
                headers, body = {"content-type": cached[0]}, cached[1]
                self._remember("npm-packument", meta_url, headers.get("content-type", "application/json"), body, from_mirror=True)
            else:
                self._remember("npm-packument", meta_url, headers.get("content-type", "application/json"), body)
        else:
            project = pypi_project_from_filename(req.bare_path.rsplit("/", 1)[-1])
            if not project:
                return None
            hosts = self.policy["registries"].get("pypi_index", [])
            if not hosts:
                return None
            idx_url = f"https://{hosts[0]}/simple/{project}/"
            accept = "application/vnd.pypi.simple.v1+json"
            status, headers, body = self.fetch(idx_url, {"Accept": accept})
            if status != 200:
                cached = self.mirror.get_meta(idx_url, accept)
                if cached is None:
                    return None
                headers, body = {"content-type": cached[0]}, cached[1]
                self._remember("pypi-simple", idx_url, headers.get("content-type", "application/json"), body, from_mirror=True)
            else:
                self._remember("pypi-simple", idx_url, headers.get("content-type", "application/json"), body)
        with self._lock:
            return self.digests.get(req.url)

    def _blob(self, req: Request, kind: str) -> Decision:
        sri = self._expected_digest(req, kind)
        if not sri:
            return Decision(502, {"Content-Type": "text/plain"}, b"no published digest", "registry", integrity="no_digest")
        with self._lock:
            ok = "mirror-metadata" if req.url in self.mirror_digest_urls else "verified"
        ctype = "application/octet-stream"
        cached = self.mirror.get_blob(sri)
        if cached is not None:
            return Decision(200, {"Content-Type": ctype}, cached, "mirror", integrity=ok)
        status, _headers, body = self.fetch(req.url, {"Accept": "*/*"})
        if status != 200:
            return Decision(502 if status >= 500 else status, {"Content-Type": "text/plain"}, b"registry unavailable", "registry", note=f"upstream {status}")
        if not sri_matches(body, sri):
            return Decision(502, {"Content-Type": "text/plain"}, b"integrity mismatch", "registry", integrity="mismatch")
        try:
            self.mirror.put_blob(sri, body)
        except (OSError, ValueError):
            pass
        return Decision(200, {"Content-Type": ctype}, body, "registry", integrity=ok)


# ---- capture -----------------------------------------------------------------


def read_phase(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            word = f.read(64).split()
    except OSError:
        return "install"
    return word[0] if word and word[0] in PHASES else "install"


def capture_record(
    policy: dict,
    *,
    t: float,
    phase: str,
    proto: str,
    host: str,
    port: int,
    method: Optional[str] = None,
    path: Optional[str] = None,
    sni: Optional[str] = None,
    req_headers: Optional[dict] = None,
    req_body: bytes = b"",
    forged_kind: str,
    tls: Optional[str] = None,
    status: Optional[int] = None,
    integrity: Optional[str] = None,
) -> dict:
    cap = int(policy.get("max_body_capture", 65536))
    hv = int(policy.get("max_header_value", 2048))
    rec = {
        "t": round(t, 3),
        "phase": phase,
        "proto": proto,
        "host": host.lower().rstrip("."),
        "port": int(port),
        "method": method,
        "path": path[:2048] if isinstance(path, str) else None,
        "sni": sni,
        "req_headers": {str(k).lower(): str(v)[:hv] for k, v in (req_headers or {}).items()},
        "req_bytes": len(req_body),
        "req_body_b64": base64.b64encode(req_body[:cap]).decode("ascii"),
        "forged_kind": forged_kind,
        "tls": tls,
    }
    if status is not None:
        rec["status"] = int(status)
    if integrity is not None:
        rec["integrity"] = integrity
    return rec


_capture_lock = threading.Lock()


def append_capture(path: str, record: dict) -> None:
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _capture_lock:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
