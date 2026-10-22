import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUploadPackRefs, resolveViaGit } from "../../lib/engine/resolve/github.ts";

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const T = "d".repeat(40);
const ADV =
  pkt("# service=git-upload-pack\n") + "0000" +
  pkt(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/github\n`) +
  pkt(`${A} refs/heads/main\n`) + pkt(`${B} refs/heads/dev\n`) + pkt(`${C} refs/tags/v1.0.0\n`) + pkt(`${T} refs/tags/v1.0.0^{}\n`) + "0000";

test("info/refs: HEAD, its branch, branches and peeled tags", () => {
  const r = parseUploadPackRefs(ADV);
  assert.equal(r.head, A);
  assert.equal(r.headTarget, "refs/heads/main");
  assert.equal(r.byName.get("refs/heads/dev"), B);
  assert.equal(r.byName.get("refs/tags/v1.0.0^{}"), T);
});

test("resolving without the API: HEAD, a branch, a peeled tag, a SHA as given, and a missing repo", async () => {
  const ok = (async () => new Response(ADV, { status: 200 })) as unknown as typeof fetch;
  const ctx = { fetch: ok, token: null, timeoutMs: 1000 };
  assert.deepEqual([(await resolveViaGit({ owner: "o", repo: "r" }, ctx)).sha, (await resolveViaGit({ owner: "o", repo: "r" }, ctx)).ref], [A, "main"]);
  assert.equal((await resolveViaGit({ owner: "o", repo: "r", ref: "dev" }, ctx)).sha, B);
  assert.equal((await resolveViaGit({ owner: "o", repo: "r", ref: "v1.0.0" }, ctx)).sha, T);
  assert.equal((await resolveViaGit({ owner: "o", repo: "r", ref: "E".repeat(40) }, ctx)).sha, "e".repeat(40));
  assert.equal((await resolveViaGit({ owner: "o", repo: "r" }, ctx)).info.stars, null, "unknown, never a made-up 0");
  const gone = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(resolveViaGit({ owner: "o", repo: "r" }, { ...ctx, fetch: gone }), /not found on GitHub, or it is private/);
});
