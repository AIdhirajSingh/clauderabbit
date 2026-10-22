"""Unit tests for forge_core.py (stdlib only): python3 -m unittest sandbox/e2b/guest/test_forge_core.py"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import forge_core as fc  # noqa: E402

POLICY = fc.load_policy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "policy.json"))

TARBALL = b"\x1f\x8b fake tarball bytes for the forge test"
TARBALL_SRI = "sha512-" + base64.b64encode(hashlib.sha512(TARBALL).digest()).decode()
TARBALL_URL = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"
PACKUMENT = json.dumps(
    {"name": "left-pad", "versions": {"1.3.0": {"dist": {"tarball": TARBALL_URL, "integrity": TARBALL_SRI}}}}
).encode()

WHEEL = b"PK fake wheel"
WHEEL_SHA = hashlib.sha256(WHEEL).hexdigest()
WHEEL_URL = "https://files.pythonhosted.org/packages/aa/bb/six-1.16.0-py2.py3-none-any.whl"


class FakeUpstream:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        r = self.routes.get(url)
        if r is None:
            return 404, {}, b"missing"
        return r


def req(method, host, path, headers=None, body=b""):
    return fc.Request(method=method, host=host, port=443, path=path, headers=headers or {}, body=body)


class RegistryShapeTests(unittest.TestCase):
    def test_npm_shapes(self):
        self.assertEqual(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/left-pad"), "npm-packument")
        self.assertEqual(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/@babel%2fcore"), "npm-packument")
        self.assertEqual(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/@babel/core"), "npm-packument")
        self.assertEqual(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/left-pad/-/left-pad-1.3.0.tgz"), "npm-tarball")
        self.assertEqual(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/@babel/core/-/core-7.0.0.tgz"), "npm-tarball")

    def test_off_shape_and_non_get_are_forged(self):
        self.assertIsNone(fc.registry_kind(POLICY, "registry.npmjs.org", "POST", "/-/npm/v1/security/advisories/bulk"))
        # corepack's version manifest for the pnpm a repo pins
        self.assertEqual(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/pnpm/12.11.1"), "npm-version")
        self.assertEqual(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/@scope%2fpkg/1.0.0"), "npm-version")
        self.assertIsNone(fc.registry_kind(POLICY, "evil.example", "GET", "/pnpm/12.11.1"), "only registry hosts")
        self.assertEqual(fc.npm_digests_from_packument(b'{"name":"pnpm","version":"12.11.1","dist":{"tarball":"https://registry.npmjs.org/pnpm/-/pnpm-12.11.1.tgz","integrity":"sha512-x"}}'), {"https://registry.npmjs.org/pnpm/-/pnpm-12.11.1.tgz": "sha512-x"})
        self.assertIsNone(fc.registry_kind(POLICY, "registry.npmjs.org", "GET", "/-/v1/search"))
        self.assertIsNone(fc.registry_kind(POLICY, "registry.npmjs.org", "PUT", "/left-pad"))
        self.assertIsNone(fc.registry_kind(POLICY, "evil.example", "GET", "/left-pad"))
        self.assertIsNone(fc.registry_kind(POLICY, "registry.npmjs.org.evil.example", "GET", "/left-pad"))

    def test_pypi_shapes(self):
        self.assertEqual(fc.registry_kind(POLICY, "pypi.org", "GET", "/simple/six/"), "pypi-simple")
        self.assertEqual(fc.registry_kind(POLICY, "pypi.org", "GET", "/pypi/six/json"), "pypi-json")
        self.assertEqual(fc.registry_kind(POLICY, "files.pythonhosted.org", "GET", "/packages/aa/bb/six-1.16.0-py2.py3-none-any.whl"), "pypi-file")
        self.assertIsNone(fc.registry_kind(POLICY, "pypi.org", "POST", "/legacy/"))

    def test_pypi_project_from_filename(self):
        self.assertEqual(fc.pypi_project_from_filename("Six-1.16.0-py2.py3-none-any.whl"), "six")
        self.assertEqual(fc.pypi_project_from_filename("zope.interface-6.0.tar.gz"), "zope-interface")
        self.assertIsNone(fc.pypi_project_from_filename("README"))


class IntegrityTests(unittest.TestCase):
    def test_sri_matches_strongest(self):
        self.assertTrue(fc.sri_matches(TARBALL, TARBALL_SRI))
        self.assertFalse(fc.sri_matches(TARBALL + b"x", TARBALL_SRI))
        weak = "sha1-" + base64.b64encode(hashlib.sha1(b"other").digest()).decode()
        self.assertTrue(fc.sri_matches(TARBALL, f"{weak} {TARBALL_SRI}"))
        self.assertFalse(fc.sri_matches(TARBALL, "md5-abc"))

    def test_npm_digests(self):
        self.assertEqual(fc.npm_digests_from_packument(PACKUMENT), {TARBALL_URL: TARBALL_SRI})
        old = json.dumps({"versions": {"0.1.0": {"dist": {"tarball": "https://registry.npmjs.org/x/-/x-0.1.0.tgz", "shasum": "a" * 40}}}}).encode()
        self.assertTrue(fc.npm_digests_from_packument(old)["https://registry.npmjs.org/x/-/x-0.1.0.tgz"].startswith("sha1-"))
        self.assertEqual(fc.npm_digests_from_packument(b"not json"), {})

    def test_pypi_digests_json_and_html(self):
        j = json.dumps({"files": [{"url": WHEEL_URL, "hashes": {"sha256": WHEEL_SHA}}]}).encode()
        self.assertEqual(fc.pypi_digests_from_index(j, "https://pypi.org/simple/six/", "application/vnd.pypi.simple.v1+json"), {WHEEL_URL: fc.hex_to_sri("sha256", WHEEL_SHA)})
        html = f'<a href="{WHEEL_URL}#sha256={WHEEL_SHA}">six</a>'.encode()
        self.assertEqual(fc.pypi_digests_from_index(html, "https://pypi.org/simple/six/", "text/html"), {WHEEL_URL: fc.hex_to_sri("sha256", WHEEL_SHA)})


class ForgeRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mirror = fc.Mirror(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_tarball_verified_then_served_from_mirror(self):
        up = FakeUpstream({
            "https://registry.npmjs.org/left-pad": (200, {"content-type": "application/json"}, PACKUMENT),
            TARBALL_URL: (200, {}, TARBALL),
        })
        forge = fc.Forge(POLICY, self.mirror, up)
        d = forge.handle(req("GET", "registry.npmjs.org", "/left-pad/-/left-pad-1.3.0.tgz"))
        self.assertEqual((d.status, d.forged_kind, d.integrity, d.body), (200, "registry", "verified", TARBALL))
        forge2 = fc.Forge(POLICY, self.mirror, up)
        forge2.handle(req("GET", "registry.npmjs.org", "/left-pad", {"accept": "application/json"}))
        calls_before = len(up.calls)
        d2 = forge2.handle(req("GET", "registry.npmjs.org", "/left-pad/-/left-pad-1.3.0.tgz"))
        self.assertEqual((d2.status, d2.forged_kind, d2.integrity), (200, "mirror", "verified"))
        self.assertEqual(len(up.calls), calls_before, "a verified mirror blob is served without an upstream fetch")

    def test_tampered_mirror_blob_is_not_served(self):
        forge = fc.Forge(POLICY, self.mirror, FakeUpstream({
            "https://registry.npmjs.org/left-pad": (200, {"content-type": "application/json"}, PACKUMENT),
            TARBALL_URL: (200, {}, TARBALL),
        }))
        forge.handle(req("GET", "registry.npmjs.org", "/left-pad/-/left-pad-1.3.0.tgz"))
        path = self.mirror._blob_path(TARBALL_SRI)
        with open(path, "wb") as f:
            f.write(b"tampered")
        self.assertIsNone(self.mirror.get_blob(TARBALL_SRI))

    def test_integrity_mismatch_is_502(self):
        up = FakeUpstream({
            "https://registry.npmjs.org/left-pad": (200, {"content-type": "application/json"}, PACKUMENT),
            TARBALL_URL: (200, {}, b"evil bytes"),
        })
        d = fc.Forge(POLICY, self.mirror, up).handle(req("GET", "registry.npmjs.org", "/left-pad/-/left-pad-1.3.0.tgz"))
        self.assertEqual((d.status, d.integrity), (502, "mismatch"))
        self.assertRaises(ValueError, self.mirror.put_blob, TARBALL_SRI, b"evil bytes")

    def test_no_digest_is_502(self):
        d = fc.Forge(POLICY, self.mirror, FakeUpstream({})).handle(req("GET", "registry.npmjs.org", "/ghost/-/ghost-1.0.0.tgz"))
        self.assertEqual((d.status, d.integrity), (502, "no_digest"))

    def test_metadata_falls_back_to_mirror(self):
        up = FakeUpstream({"https://registry.npmjs.org/left-pad": (200, {"content-type": "application/json"}, PACKUMENT)})
        fc.Forge(POLICY, self.mirror, up).handle(req("GET", "registry.npmjs.org", "/left-pad", {"accept": "application/json"}))
        down = FakeUpstream({})
        down.routes = {"https://registry.npmjs.org/left-pad": (503, {}, b"")}
        d = fc.Forge(POLICY, self.mirror, down).handle(req("GET", "registry.npmjs.org", "/left-pad", {"accept": "application/json"}))
        self.assertEqual((d.status, d.forged_kind, d.body), (200, "mirror", PACKUMENT))
        self.assertEqual(d.integrity, "mirror-metadata", "metadata served from the mirror is marked, never silently trusted")

    def test_blob_verified_only_against_mirror_metadata_is_marked(self):
        up = FakeUpstream({"https://registry.npmjs.org/left-pad": (200, {"content-type": "application/json"}, PACKUMENT)})
        fc.Forge(POLICY, self.mirror, up).handle(req("GET", "registry.npmjs.org", "/left-pad", {"accept": "application/json"}))
        down = FakeUpstream({TARBALL_URL: (200, {}, TARBALL)})
        down.routes["https://registry.npmjs.org/left-pad"] = (503, {}, b"")
        d = fc.Forge(POLICY, self.mirror, down).handle(req("GET", "registry.npmjs.org", "/left-pad/-/left-pad-1.3.0.tgz"))
        self.assertEqual((d.status, d.integrity), (200, "mirror-metadata"), "a digest from mirror metadata is recorded as such")

    def test_pypi_file_verified_via_index(self):
        idx = json.dumps({"files": [{"url": WHEEL_URL, "hashes": {"sha256": WHEEL_SHA}}]}).encode()
        up = FakeUpstream({
            "https://pypi.org/simple/six/": (200, {"content-type": "application/vnd.pypi.simple.v1+json"}, idx),
            WHEEL_URL: (200, {}, WHEEL),
        })
        d = fc.Forge(POLICY, self.mirror, up).handle(req("GET", "files.pythonhosted.org", "/packages/aa/bb/six-1.16.0-py2.py3-none-any.whl"))
        self.assertEqual((d.status, d.integrity, d.body), (200, "verified", WHEEL))


class NpmNameTests(unittest.TestCase):
    def test_name_from_version_path(self):
        self.assertEqual(fc.npm_name_from_path("/@rollup%2frollup-darwin-x64/4.0.0"), "@rollup/rollup-darwin-x64")
        self.assertEqual(fc.npm_name_from_path("/@rollup%2Frollup-darwin-x64"), "@rollup/rollup-darwin-x64")
        self.assertEqual(fc.npm_name_from_path("/left-pad/-/left-pad-1.3.0.tgz"), "left-pad")


class ForgedReplyTests(unittest.TestCase):
    def test_body_by_consumer(self):
        self.assertEqual(fc.forged_reply(req("GET", "evil.example", "/install.sh")).forged_kind, "shell")
        self.assertEqual(fc.forged_reply(req("GET", "evil.example", "/x", {"user-agent": "curl/8.5.0"})).body, fc.SHELL_NOOP)
        self.assertEqual(fc.forged_reply(req("GET", "evil.example", "/a.ps1")).forged_kind, "powershell")
        d = fc.forged_reply(req("POST", "c2.cr-fixture.invalid", "/collect", {"content-type": "application/json"}, b"{}"))
        self.assertEqual((d.status, d.body, d.forged_kind), (200, fc.JSON_OK, "json"))

    def test_non_registry_host_never_fetches_upstream(self):
        up = FakeUpstream({})
        forge = fc.Forge(POLICY, fc.Mirror(tempfile.mkdtemp()), up)
        forge.handle(req("GET", "attacker.example", "/payload"))
        forge.handle(req("POST", "registry.npmjs.org", "/-/npm/v1/security/advisories/bulk"))
        self.assertEqual(up.calls, [])


class DnsAndCaptureTests(unittest.TestCase):
    def test_unique_ip_per_name(self):
        forge = fc.Forge(POLICY, fc.Mirror(tempfile.mkdtemp()), FakeUpstream({}))
        a = forge.dns_answer("c2.cr-fixture.invalid.", "A")
        b = forge.dns_answer("other.example", "A")
        self.assertNotEqual(a, b)
        self.assertEqual(forge.dns_answer("C2.cr-fixture.invalid", "A"), a)
        self.assertEqual(forge.name_for_ip(a), "c2.cr-fixture.invalid")
        self.assertIsNone(forge.dns_answer("c2.cr-fixture.invalid", "AAAA"))
        self.assertTrue(a.startswith("198.18."))

    def test_capture_record_format(self):
        body = b"x" * (POLICY["max_body_capture"] + 10)
        rec = fc.capture_record(POLICY, t=1.23456, phase="install", proto="https", host="C2.Example.", port=443,
                                method="POST", path="/collect", sni="c2.example", req_headers={"User-Agent": "node"},
                                req_body=body, forged_kind="json", tls="intercepted", status=200)
        self.assertEqual(set(rec) - {"status"}, {"t", "phase", "proto", "host", "port", "method", "path", "sni", "req_headers", "req_bytes", "req_body_b64", "forged_kind", "tls"})
        self.assertEqual(rec["host"], "c2.example")
        self.assertEqual(rec["req_bytes"], len(body))
        self.assertEqual(len(base64.b64decode(rec["req_body_b64"])), POLICY["max_body_capture"])
        self.assertEqual(rec["req_headers"], {"user-agent": "node"})
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "out", "capture.jsonl")
            fc.append_capture(p, rec)
            fc.append_capture(p, rec)
            with open(p) as f:
                lines = f.read().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(json.loads(lines[0])["forged_kind"], "json")

    def test_read_phase(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "phase")
            self.assertEqual(fc.read_phase(p), "install")
            with open(p, "w") as f:
                f.write("entry 123.4\n")
            self.assertEqual(fc.read_phase(p), "entry")
            with open(p, "w") as f:
                f.write("collect 125.0\n")
            self.assertEqual(fc.read_phase(p), "collect")
            with open(p, "w") as f:
                f.write("bogus\n")
            self.assertEqual(fc.read_phase(p), "install")


if __name__ == "__main__":
    unittest.main()


class JsrRegistryTests(unittest.TestCase):
    def test_jsr_npm_registry_is_a_registry(self):
        self.assertEqual(fc.registry_kind(POLICY, "npm.jsr.io", "GET", "/~/11/@jsr/std__path/1.0.8.tgz"), "npm-tarball")
        self.assertEqual(fc.registry_kind(POLICY, "npm.jsr.io", "GET", "/@jsr/std__path"), "npm-packument")
        self.assertIsNone(fc.registry_kind(POLICY, "npm.jsr.io", "POST", "/@jsr/std__path"))
        self.assertIsNone(fc.registry_kind(POLICY, "jsr.io.evil.example", "GET", "/@jsr/std__path"))


CRATE = b"fake crate bytes"
CRATE_SHA = hashlib.sha256(CRATE).hexdigest()


class GoAndCratesRegistryTests(unittest.TestCase):
    def test_go_proxy_and_sumdb_shapes(self):
        k = lambda h, p, m="GET": fc.registry_kind(POLICY, h, m, p)  # noqa: E731
        self.assertEqual(k("proxy.golang.org", "/github.com/google/uuid/@v/list"), "go-meta")
        self.assertEqual(k("proxy.golang.org", "/github.com/google/uuid/@v/v1.6.0.info"), "go-meta")
        self.assertEqual(k("proxy.golang.org", "/github.com/google/uuid/@v/v1.6.0.mod"), "go-meta")
        self.assertEqual(k("proxy.golang.org", "/github.com/!burnt!sushi/toml/@latest"), "go-meta")
        self.assertEqual(k("proxy.golang.org", "/github.com/google/uuid/@v/v1.6.0.zip"), "go-zip")
        self.assertEqual(k("proxy.golang.org", "/github.com/docker/docker/@v/v28.0.0+incompatible.zip"), "go-zip")
        self.assertEqual(k("sum.golang.org", "/lookup/github.com/google/uuid@v1.6.0"), "go-sumdb")
        self.assertEqual(k("sum.golang.org", "/latest"), "go-sumdb")
        self.assertEqual(k("sum.golang.org", "/tile/8/0/x123/456.p/12"), "go-sumdb")
        self.assertEqual(k("sum.golang.org", "/tile/8/data/x001/234"), "go-sumdb")
        self.assertIsNone(k("proxy.golang.org", "/github.com/google/uuid/@v/v1.6.0.zip", "POST"))
        self.assertIsNone(k("proxy.golang.org", "/upload"))
        self.assertIsNone(k("sum.golang.org", "/exfil?d=x"))
        self.assertIsNone(k("proxy.golang.org.evil.example", "/github.com/google/uuid/@v/list"))

    def test_crates_shapes(self):
        k = lambda h, p: fc.registry_kind(POLICY, h, "GET", p)  # noqa: E731
        self.assertEqual(k("index.crates.io", "/config.json"), "crates-index")
        self.assertEqual(k("index.crates.io", "/se/rd/serde"), "crates-index")
        self.assertEqual(k("index.crates.io", "/1/a"), "crates-index")
        self.assertEqual(k("index.crates.io", "/3/s/syn"), "crates-index")
        self.assertEqual(k("static.crates.io", "/crates/serde/1.0.200/download"), "crate-file")
        self.assertEqual(k("static.crates.io", "/crates/serde/serde-1.0.200.crate"), "crate-file")
        self.assertIsNone(k("static.crates.io", "/crates/serde/other-1.0.0.crate"))
        self.assertIsNone(k("index.crates.io", "/api/v1/crates/new"))
        self.assertIsNone(k("crates.io", "/api/v1/crates"))
        self.assertEqual(fc.crate_index_path("serde"), "/se/rd/serde")
        self.assertEqual(fc.crate_index_path("syn"), "/3/s/syn")
        self.assertEqual(fc.crate_index_path("cc"), "/2/cc")

    def test_crate_file_verified_against_index_checksum(self):
        idx = json.dumps({"name": "demo", "vers": "1.0.0", "cksum": CRATE_SHA}).encode() + b"\n"
        url = "https://static.crates.io/crates/demo/1.0.0/download"
        up = FakeUpstream({"https://index.crates.io/de/mo/demo": (200, {"content-type": "text/plain"}, idx), url: (200, {}, CRATE)})
        with tempfile.TemporaryDirectory() as d:
            forge = fc.Forge(POLICY, fc.Mirror(d), up)
            ok = forge.handle(req("GET", "static.crates.io", "/crates/demo/1.0.0/download"))
            self.assertEqual((ok.status, ok.body, ok.integrity), (200, CRATE, "verified"))
            up.routes[url] = (200, {}, b"tampered")
            forge2 = fc.Forge(POLICY, fc.Mirror(os.path.join(d, "fresh")), up)
            bad = forge2.handle(req("GET", "static.crates.io", "/crates/demo/1.0.0/download"))
            self.assertEqual((bad.status, bad.integrity), (502, "mismatch"))

    def test_go_zip_is_fetched_and_marked_client_checked(self):
        url = "https://proxy.golang.org/example.com/m/@v/v1.0.0.zip"
        up = FakeUpstream({url: (200, {}, b"PK zip")})
        with tempfile.TemporaryDirectory() as d:
            dec = fc.Forge(POLICY, fc.Mirror(d), up).handle(req("GET", "proxy.golang.org", "/example.com/m/@v/v1.0.0.zip"))
            self.assertEqual((dec.status, dec.forged_kind, dec.integrity), (200, "registry", "client-checked"))
