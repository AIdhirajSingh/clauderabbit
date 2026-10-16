import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { ArchiveError, normalizeEntryPath, parsePaxRecords, parseTar, parseTarball, textOf } from "../../lib/engine/archive.ts";
import { verifyGithubArchive } from "../../lib/engine/resolve/github.ts";
import { EngineError } from "../../lib/engine/types.ts";
import { makeTar, makeTgz, paxBody } from "../support/tar.ts";

const LIMITS = { maxCompressedBytes: 1024 * 1024, maxExpandedBytes: 4 * 1024 * 1024, maxFiles: 100 };
const REPO = new URL("../..", import.meta.url).pathname;

test("parses a gzip tarball and strips the shared top-level directory", async () => {
  const tgz = makeTgz([
    { name: "package/", type: "dir" },
    { name: "package/package.json", data: '{"name":"x"}' },
    { name: "package/lib/index.js", data: "module.exports = 1;\n" },
  ]);
  const a = await parseTarball(tgz, LIMITS);
  assert.equal(a.root, "package");
  assert.deepEqual([...a.files.keys()].sort(), ["lib/index.js", "package.json"]);
  assert.equal(textOf(a.files.get("lib/index.js")), "module.exports = 1;\n");
  assert.equal(a.truncated, false);
  assert.equal(a.rejected.length, 0);
});

test("keeps paths as-is when entries do not share one root", async () => {
  const a = await parseTarball(makeTgz([{ name: "a.js", data: "1" }, { name: "lib/b.js", data: "2" }]), LIMITS);
  assert.equal(a.root, null);
  assert.ok(a.files.has("a.js") && a.files.has("lib/b.js"));
});

const traversalCases: Array<[string, string]> = [
  ["../evil.js", "path_traversal"],
  ["package/../../evil.js", "path_traversal"],
  ["/etc/passwd", "absolute_path"],
  ["C:/Windows/evil.dll", "absolute_path"],
  ["package\\..\\..\\evil.js", "path_traversal"],
];
for (const [name, reason] of traversalCases) {
  test(`rejects entry ${JSON.stringify(name)} as ${reason} and keeps parsing`, () => {
    const a = parseTar(makeTar([{ name, data: "x" }, { name: "ok.js", data: "fine" }]), LIMITS);
    assert.deepEqual(a.rejected, [{ path: name, reason }]);
    assert.ok(a.files.has("ok.js"));
    assert.equal([...a.files.keys()].some((k) => k.includes("..") || k.startsWith("/")), false);
  });
}

test("normalizeEntryPath collapses ./ and empty segments", () => {
  assert.deepEqual(normalizeEntryPath("./a//b/./c.js"), { path: "a/b/c.js" });
  assert.deepEqual(normalizeEntryPath("a/\u0000b"), { rejected: "nul_in_path" });
  assert.deepEqual(normalizeEntryPath("./"), { rejected: "empty_path" });
});

test("symlinks and hardlinks are recorded, never followed or read", () => {
  const a = parseTar(
    makeTar([
      { name: "pkg/real.js", data: "secret-free" },
      { name: "pkg/inside", type: "symlink", linkname: "real.js" },
      { name: "pkg/escape", type: "symlink", linkname: "../../etc/passwd" },
      { name: "pkg/abs", type: "symlink", linkname: "/root/.ssh/id_rsa" },
      { name: "pkg/hard", type: "hardlink", linkname: "pkg/real.js" },
      { name: "pkg/hardbad", type: "hardlink", linkname: "../outside" },
    ]),
    LIMITS,
  );
  assert.deepEqual([...a.files.keys()], ["real.js"]);
  const byPath = Object.fromEntries(a.links.map((l) => [l.path, l]));
  assert.equal(byPath["inside"]!.escapes, false);
  assert.equal(byPath["escape"]!.escapes, true);
  assert.equal(byPath["abs"]!.escapes, true);
  assert.equal(byPath["hard"]!.kind, "hardlink");
  assert.equal(byPath["hard"]!.escapes, false);
  assert.equal(byPath["hardbad"]!.escapes, true);
  assert.deepEqual(
    a.rejected.map((r) => r.path + ":" + r.reason).sort(),
    ["abs:link_escapes_root", "escape:link_escapes_root", "hardbad:link_escapes_root"],
  );
});

test("devices and FIFOs are skipped and recorded", () => {
  const a = parseTar(makeTar([{ name: "fifo", type: "fifo" }, { name: "f.js", data: "1" }]), LIMITS);
  assert.deepEqual(a.rejected, [{ path: "fifo", reason: "special_file" }]);
});

test("pax path, linkpath and size records override the ustar header", () => {
  const longName = "pkg/" + "d/".repeat(80) + "deep.js";
  const a = parseTar(makeTar([{ name: "short", data: "deep file", pax: { path: longName } }]), LIMITS);
  assert.ok(a.files.has(longName.slice(4)));
  assert.equal(a.root, "pkg");
});

test("GNU long names are honored", () => {
  const longName = "x/" + "y".repeat(150) + ".js";
  const a = parseTar(makeTar([{ name: "././@LongLink", type: "gnu-longname", data: longName + "\0" }, { name: "trunc", data: "z" }]), LIMITS);
  assert.ok(a.files.has("y".repeat(150) + ".js"));
});

test("ustar prefix field is joined to the name", () => {
  const a = parseTar(makeTar([{ name: "file.js", prefix: "root/dir", data: "1" }, { name: "root/other.js", data: "2" }]), LIMITS);
  assert.deepEqual([...a.files.keys()].sort(), ["dir/file.js", "other.js"]);
});

test("pax global comment is exposed (git archive commit id)", () => {
  const sha = "a".repeat(40);
  const a = parseTar(makeTar([{ name: "pax_global_header", type: "pax-global", data: paxBody({ comment: sha }) }, { name: "r/x.js", data: "1" }]), LIMITS);
  assert.equal(a.paxComment, sha);
  assert.deepEqual(parsePaxRecords(paxBody({ comment: sha, path: "p" })), { comment: sha, path: "p" });
});

test("a corrupt header checksum fails the parse", () => {
  assert.throws(() => parseTar(makeTar([{ name: "a.js", data: "1", corruptChecksum: true }]), LIMITS), (e: unknown) => e instanceof ArchiveError && e.reason === "corrupt");
});

test("compressed input over the cap is refused before gunzip", async () => {
  const big = new Uint8Array(LIMITS.maxCompressedBytes + 1);
  big[0] = 0x1f;
  big[1] = 0x8b;
  await assert.rejects(parseTarball(big, LIMITS), (e: unknown) => e instanceof ArchiveError && e.reason === "too_large");
});

test("a gzip bomb stops at the expanded cap and is marked truncated", async () => {
  const zeros = new Uint8Array(3 * 1024 * 1024);
  const tar = makeTar([{ name: "r/a.js", data: "first" }, { name: "r/bomb.bin", data: zeros }, { name: "r/after.js", data: "after" }]);
  const tgz = new Uint8Array(gzipSync(tar));
  assert.ok(tgz.length < 64 * 1024, "bomb compresses small");
  const a = await parseTarball(tgz, { ...LIMITS, maxExpandedBytes: 1024 * 1024 });
  assert.equal(a.truncated, true);
  assert.equal(a.truncatedReason, "expanded_bytes");
  assert.ok(a.files.has("a.js"));
  assert.equal(a.files.has("after.js"), false);
});

test("file count over the cap marks the archive truncated", () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ name: `r/f${i}.js`, data: String(i) }));
  const a = parseTar(makeTar(entries), { maxFiles: 10 });
  assert.equal(a.truncated, true);
  assert.equal(a.truncatedReason, "file_count");
  assert.equal(a.files.size, 10);
});

test("a corrupt gzip stream is rejected", async () => {
  const tgz = makeTgz([{ name: "a.js", data: "x".repeat(5000) }]);
  const cut = tgz.slice(0, Math.floor(tgz.length / 2));
  await assert.rejects(parseTarball(cut, LIMITS), (e: unknown) => e instanceof ArchiveError && e.reason === "corrupt");
});

test("textOf returns null for binary content", () => {
  assert.equal(textOf(new Uint8Array([0x41, 0x00, 0x42])), null);
  assert.equal(textOf(new TextEncoder().encode("hi")), "hi");
});

test("git archive of this repo carries the commit SHA as the pax comment and passes verifyGithubArchive", async () => {
  const sha = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tgz = new Uint8Array(execFileSync("git", ["-C", REPO, "archive", "--format=tar.gz", "--prefix=repo-sha/", "HEAD", "lib/score.ts"]));
  const a = await parseTarball(tgz, LIMITS);
  assert.equal(a.paxComment, sha);
  assert.equal(a.root, "repo-sha");
  assert.ok(a.files.has("lib/score.ts"));
  verifyGithubArchive(a, sha);
  assert.throws(() => verifyGithubArchive(a, "0".repeat(40)), (e: unknown) => e instanceof EngineError && e.code === "integrity");
  assert.throws(() => verifyGithubArchive({ ...a, paxComment: null }, sha), (e: unknown) => e instanceof EngineError && e.code === "integrity");
});
