import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { codeloadUrl, fetchGithubTarball, parseGithubTarget, resolveGithub } from "../../lib/engine/resolve/github.ts";
import {
  assertRegistryTarball,
  encodeNpmName,
  fetchNpmTarball,
  npmCommitKey,
  parseNpmTarget,
  pickVersion,
  resolveNpm,
  summarizePackument,
} from "../../lib/engine/resolve/npm.ts";
import { fetchOperatorTarball, validateOperatorTarball } from "../../lib/engine/resolve/tarball.ts";
import { readCapped, sha512Sri, verifySha1Hex, verifySri } from "../../lib/engine/resolve/http.ts";
import { EngineError } from "../../lib/engine/types.ts";
import { bytes, fakeFetch, json } from "../support/fake-fetch.ts";

const isCode = (code: string) => (e: unknown) => e instanceof EngineError && e.code === code;
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("parseGithubTarget accepts owner/repo, github: prefix, refs and URLs", () => {
  assert.deepEqual(parseGithubTarget("vercel/next.js"), { owner: "vercel", repo: "next.js" });
  assert.deepEqual(parseGithubTarget("github:octo/cat#v1.2"), { owner: "octo", repo: "cat", ref: "v1.2" });
  assert.deepEqual(parseGithubTarget("https://github.com/octo/cat.git"), { owner: "octo", repo: "cat" });
  assert.deepEqual(parseGithubTarget("https://github.com/octo/cat/tree/feature/x"), { owner: "octo", repo: "cat", ref: "feature/x" });
  assert.deepEqual(parseGithubTarget(`github.com/octo/cat/commit/${SHA}`), { owner: "octo", repo: "cat", ref: SHA });
  assert.equal(parseGithubTarget("@scope/pkg"), null);
  assert.equal(parseGithubTarget("octo/.."), null);
  assert.equal(parseGithubTarget("-bad/repo"), null);
  assert.equal(parseGithubTarget("just-a-name"), null);
});

function githubRoutes(repoOverrides: Record<string, unknown> = {}, shaBody = SHA) {
  return fakeFetch([
    {
      match: "https://api.github.com/repos/octo/cat",
      respond: () =>
        json({
          name: "cat",
          owner: { login: "octo", type: "User" },
          default_branch: "main",
          description: "d",
          stargazers_count: 5,
          forks_count: 1,
          created_at: "2020-01-01T00:00:00Z",
          pushed_at: "2026-01-01T00:00:00Z",
          license: { spdx_id: "MIT" },
          language: "JavaScript",
          private: false,
          visibility: "public",
          ...repoOverrides,
        }),
    },
    { match: "https://api.github.com/repos/octo/cat/commits/main", respond: () => new Response(shaBody) },
  ]);
}

test("resolveGithub resolves the default branch to a SHA with the sha media type", async () => {
  const f = githubRoutes();
  const r = await resolveGithub({ owner: "octo", repo: "cat" }, { fetch: f.fetch, token: "t0k", timeoutMs: 1000 });
  assert.equal(r.sha, SHA);
  assert.equal(r.ref, "main");
  assert.equal(r.info.license, "MIT");
  const shaCall = f.calls[1]!;
  assert.equal((shaCall.init?.headers as Record<string, string>).Accept, "application/vnd.github.sha");
  assert.equal((shaCall.init?.headers as Record<string, string>).Authorization, "Bearer t0k");
});

test("resolveGithub refuses private repos and maps 404 and rate limits", async () => {
  await assert.rejects(resolveGithub({ owner: "octo", repo: "cat" }, { fetch: githubRoutes({ private: true }).fetch, token: null, timeoutMs: 1000 }), isCode("private_repo"));
  const missing = fakeFetch([{ match: () => true, respond: () => json({}, 404) }]);
  await assert.rejects(resolveGithub({ owner: "octo", repo: "cat" }, { fetch: missing.fetch, token: null, timeoutMs: 1000 }), isCode("not_found"));
  const limited = fakeFetch([{ match: () => true, respond: () => json({}, 403, { "x-ratelimit-remaining": "0" }) }]);
  await assert.rejects(resolveGithub({ owner: "octo", repo: "cat" }, { fetch: limited.fetch, token: null, timeoutMs: 1000 }), isCode("rate_limited"));
  await assert.rejects(resolveGithub({ owner: "octo", repo: "cat" }, { fetch: githubRoutes({}, "not-a-sha").fetch, token: null, timeoutMs: 1000 }), isCode("upstream"));
});

test("fetchGithubTarball reads codeload for the exact SHA and enforces the cap", async () => {
  const body = new Uint8Array(100).fill(7);
  const f = fakeFetch([{ match: codeloadUrl("octo", "cat", SHA), respond: () => bytes(body) }]);
  const got = await fetchGithubTarball("octo", "cat", SHA, { fetch: f.fetch, token: null, timeoutMs: 1000 }, 1000);
  assert.equal(got.length, 100);
  assert.equal(f.calls[0]!.url, `https://codeload.github.com/octo/cat/tar.gz/${SHA}`);
  await assert.rejects(fetchGithubTarball("octo", "cat", SHA, { fetch: f.fetch, token: null, timeoutMs: 1000 }, 50), isCode("too_large"));
  await assert.rejects(fetchGithubTarball("octo", "cat", "main", { fetch: f.fetch, token: null, timeoutMs: 1000 }, 1000), isCode("invalid_target"));
});

test("a hung request is cut at the deadline as a timeout", async () => {
  const hang = fakeFetch([
    {
      match: () => true,
      respond: (_u, init) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    },
  ]);
  await assert.rejects(resolveGithub({ owner: "octo", repo: "cat" }, { fetch: hang.fetch, token: null, timeoutMs: 20 }), isCode("timeout"));
});

test("parseNpmTarget handles scopes, versions, npm: and npmjs URLs", () => {
  assert.deepEqual(parseNpmTarget("npm:left-pad@1.3.0"), { name: "left-pad", version: "1.3.0" });
  assert.deepEqual(parseNpmTarget("@scope/pkg@2.0.0"), { name: "@scope/pkg", version: "2.0.0" });
  assert.deepEqual(parseNpmTarget("@scope/pkg"), { name: "@scope/pkg" });
  assert.deepEqual(parseNpmTarget("https://www.npmjs.com/package/@a/b/v/1.0.0"), { name: "@a/b", version: "1.0.0" });
  assert.equal(parseNpmTarget("owner/repo"), null);
  assert.equal(encodeNpmName("@scope/pkg"), "@scope%2Fpkg");
});

const TGZ = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SRI = sha512Sri(TGZ);
function packument(overrides: Record<string, unknown> = {}) {
  return {
    name: "demo",
    "dist-tags": { latest: "1.1.0", next: "2.0.0-beta.1" },
    maintainers: [{ name: "alice" }, { name: "bob" }],
    time: { created: "2020-01-01T00:00:00Z", "1.0.0": "2020-01-01T00:00:00Z", "1.1.0": "2026-10-10T00:00:00Z", "2.0.0-beta.1": "2026-10-11T00:00:00Z" },
    versions: {
      "1.0.0": { version: "1.0.0", maintainers: [{ name: "alice" }], dist: { tarball: "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz", integrity: SRI } },
      "1.1.0": {
        version: "1.1.0",
        description: "demo lib",
        license: "MIT",
        scripts: { postinstall: "node setup.js", test: "node t.js" },
        repository: { url: "git+https://github.com/octo/demo.git" },
        maintainers: [{ name: "alice" }, { name: "bob" }],
        _npmUser: { name: "bob" },
        dist: { tarball: "https://registry.npmjs.org/demo/-/demo-1.1.0.tgz", integrity: SRI, shasum: createHash("sha1").update(TGZ).digest("hex") },
      },
      "2.0.0-beta.1": { version: "2.0.0-beta.1", dist: { tarball: "https://evil.example/demo.tgz", integrity: SRI } },
    },
    ...overrides,
  };
}

test("pickVersion chooses exact versions and dist-tags and refuses unknown ones", () => {
  const p = packument();
  assert.equal(pickVersion(p, undefined), "1.1.0");
  assert.equal(pickVersion(p, "next"), "2.0.0-beta.1");
  assert.equal(pickVersion(p, "1.0.0"), "1.0.0");
  assert.throws(() => pickVersion(p, "^1.0.0"), isCode("not_found"));
});

test("summarizePackument extracts scripts, reputation facts and a sorted history", () => {
  const s = summarizePackument(packument(), "demo", undefined);
  assert.equal(s.version, "1.1.0");
  assert.equal(s.integrity, SRI);
  assert.deepEqual(s.scripts, { postinstall: "node setup.js", test: "node t.js" });
  assert.equal(s.publisher, "bob");
  assert.deepEqual(s.maintainers, ["alice", "bob"]);
  assert.equal(s.firstPublishedAt, "2020-01-01T00:00:00Z");
  assert.equal(s.versionCount, 3);
  assert.deepEqual(s.history.map((h) => h.version), ["1.0.0", "1.1.0", "2.0.0-beta.1"]);
});

test("resolveNpm reads the packument; fetchNpmTarball verifies sha512 and the registry host", async () => {
  const f = fakeFetch([
    { match: "https://registry.npmjs.org/demo", respond: () => json(packument()) },
    { match: "https://registry.npmjs.org/demo/-/demo-1.1.0.tgz", respond: () => bytes(TGZ) },
  ]);
  const ctx = { fetch: f.fetch, timeoutMs: 1000, maxPackumentBytes: 1 << 20 };
  const r = await resolveNpm({ name: "demo" }, ctx);
  const t = await fetchNpmTarball(r, ctx, 1000);
  assert.equal(t.algo, "sha512");
  assert.equal(t.sha512, SRI);
  assert.equal(npmCommitKey(r.version, t.sha512), `1.1.0+${SRI}`);

  const tampered = fakeFetch([
    { match: "https://registry.npmjs.org/demo", respond: () => json(packument()) },
    { match: "https://registry.npmjs.org/demo/-/demo-1.1.0.tgz", respond: () => bytes(new Uint8Array([9, 9, 9])) },
  ]);
  const ctx2 = { ...ctx, fetch: tampered.fetch };
  await assert.rejects(fetchNpmTarball(await resolveNpm({ name: "demo" }, ctx2), ctx2, 1000), isCode("integrity"));

  const off = await resolveNpm({ name: "demo", version: "next" }, ctx);
  await assert.rejects(fetchNpmTarball(off, ctx, 1000), isCode("integrity"));
});

test("resolveNpm maps a missing package to not_found and caps the packument", async () => {
  const f = fakeFetch([{ match: () => true, respond: () => json({ error: "Not found" }, 404) }]);
  await assert.rejects(resolveNpm({ name: "nope" }, { fetch: f.fetch, timeoutMs: 1000, maxPackumentBytes: 1000 }), isCode("not_found"));
  const big = fakeFetch([{ match: () => true, respond: () => json(packument()) }]);
  await assert.rejects(resolveNpm({ name: "demo" }, { fetch: big.fetch, timeoutMs: 1000, maxPackumentBytes: 100 }), isCode("too_large"));
});

test("SRI verification picks the strongest hash and rejects mismatches; sha1 fallback", () => {
  const sha256 = "sha256-" + createHash("sha256").update(TGZ).digest("base64");
  assert.equal(verifySri(TGZ, `${sha256} ${SRI}`), "sha512");
  assert.equal(verifySri(TGZ, sha256), "sha256");
  assert.throws(() => verifySri(TGZ, "sha512-" + "A".repeat(86) + "=="), isCode("integrity"));
  assert.throws(() => verifySri(TGZ, "md5-abc"), isCode("integrity"));
  assert.equal(verifySha1Hex(TGZ, createHash("sha1").update(TGZ).digest("hex")), "sha1");
  assert.throws(() => verifySha1Hex(TGZ, "0".repeat(40)), isCode("integrity"));
});

test("assertRegistryTarball refuses non-https and off-registry hosts", () => {
  assertRegistryTarball("https://registry.npmjs.org/a/-/a-1.0.0.tgz");
  assert.throws(() => assertRegistryTarball("http://registry.npmjs.org/a.tgz"), isCode("integrity"));
  assert.throws(() => assertRegistryTarball("https://registry.npmjs.org.evil.example/a.tgz"), isCode("integrity"));
});

test("readCapped refuses a declared content-length over the cap without reading", async () => {
  const res = new Response("x".repeat(10), { headers: { "content-length": "999999" } });
  await assert.rejects(readCapped(res, 100), isCode("too_large"));
});

test("operator tarball: https only, sha512 or sha256 SRI required, bytes verified", async () => {
  const spec = { url: "https://drop.example/pkg.tgz", integrity: SRI, label: "drop/pkg@1" };
  validateOperatorTarball(spec);
  assert.throws(() => validateOperatorTarball({ ...spec, url: "http://drop.example/pkg.tgz" }), isCode("invalid_target"));
  assert.throws(() => validateOperatorTarball({ ...spec, url: "https://u:p@drop.example/pkg.tgz" }), isCode("invalid_target"));
  assert.throws(() => validateOperatorTarball({ ...spec, integrity: "sha256-abc" }), isCode("invalid_target"));
  assert.throws(() => validateOperatorTarball({ ...spec, integrity: "sha1-" + "A".repeat(27) + "=" }), isCode("invalid_target"));
  const sha256Spec = { ...spec, integrity: "sha256-" + createHash("sha256").update(TGZ).digest("base64") };
  validateOperatorTarball(sha256Spec);
  const ok256 = fakeFetch([{ match: spec.url, respond: () => bytes(TGZ) }]);
  assert.equal((await fetchOperatorTarball(sha256Spec, { fetch: ok256.fetch, timeoutMs: 1000 }, 1000)).sha512, SRI);
  assert.throws(() => validateOperatorTarball({ ...spec, label: "bad label;" }), isCode("invalid_target"));
  const ok = fakeFetch([{ match: spec.url, respond: () => bytes(TGZ) }]);
  const got = await fetchOperatorTarball(spec, { fetch: ok.fetch, timeoutMs: 1000 }, 1000);
  assert.equal(got.sha512, SRI);
  const bad = fakeFetch([{ match: spec.url, respond: () => bytes(new Uint8Array([0])) }]);
  await assert.rejects(fetchOperatorTarball(spec, { fetch: bad.fetch, timeoutMs: 1000 }, 1000), isCode("integrity"));
});
