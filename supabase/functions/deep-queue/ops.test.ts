/**
 * Unit tests for the deep-queue request-shape validation (ops.ts).
 *
 * Run: `deno test supabase/functions/deep-queue/ops.test.ts`
 *
 * The function is a thin, runner-key-gated wrapper over service-role RPCs; the ONE
 * piece of logic worth testing in isolation is that the untrusted POST body is
 * strictly parsed into a discrete, charset-clean queue op — so a malformed or
 * hostile body is rejected BEFORE it reaches the DB layer.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { isSegment, isSha, isStage, isStageDetail, isStatus, isToken, parseQueueOp } from "./ops.ts";

Deno.test("isToken accepts the buildSlug charset, rejects slashes/metacharacters/empties", () => {
  assertEquals(isToken("psf-requests-abc123"), true);
  assertEquals(isToken("scan"), true);
  assertEquals(isToken(""), false);
  assertEquals(isToken("has/slash"), false);
  assertEquals(isToken("has space"), false);
  assertEquals(isToken("a".repeat(65)), false); // > 64
  assertEquals(isToken(42), false);
});

Deno.test("isSegment / isSha / isStatus guard their fields", () => {
  assertEquals(isSegment("AmrDab"), true);
  assertEquals(isSegment("clawd.cursor_v2"), true);
  assertEquals(isSegment("bad/seg"), false);
  assertEquals(isSha("e6585f17"), true);
  assertEquals(isSha("main"), true);
  assertEquals(isSha("bad sha"), false);
  assertEquals(isStatus("queued"), true);
  assertEquals(isStatus("timed_out"), true);
  assertEquals(isStatus("running"), false); // not an enum member
  assertEquals(isStatus(""), false);
});

Deno.test("parseQueueOp: a valid enqueue op round-trips its fields", () => {
  const r = parseQueueOp({
    op: "enqueue",
    token: "psf-requests-abc",
    owner: "psf",
    repo: "requests",
    sha: "abc123",
  });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.value.op, "enqueue");
    if (r.value.op === "enqueue") {
      assertEquals(r.value.owner, "psf");
      assertEquals(r.value.repo, "requests");
      assertEquals(r.value.sha, "abc123");
    }
  }
});

Deno.test("parseQueueOp: enqueue rejects a dirty owner/token/sha", () => {
  const bad = parseQueueOp({ op: "enqueue", token: "t", owner: "a/b", repo: "r", sha: "s" });
  assertEquals(bad.ok, false);
  const badTok = parseQueueOp({ op: "enqueue", token: "bad tok", owner: "a", repo: "r", sha: "s" });
  assertEquals(badTok.ok, false);
});

Deno.test("parseQueueOp: a valid position op needs only a clean token", () => {
  const r = parseQueueOp({ op: "position", token: "abc-123" });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value.op, "position");
  assertEquals(parseQueueOp({ op: "position", token: "" }).ok, false);
});

Deno.test("parseQueueOp: a valid status op requires a real enum status", () => {
  const r = parseQueueOp({ op: "status", token: "abc-123", status: "active" });
  assertEquals(r.ok, true);
  if (r.ok && r.value.op === "status") assertEquals(r.value.status, "active");
  assertEquals(parseQueueOp({ op: "status", token: "abc-123", status: "nope" }).ok, false);
});

Deno.test("isStage / isStageDetail guard the granular-progress fields", () => {
  assertEquals(isStage("cloning"), true);
  assertEquals(isStage("agents_exploring"), true);
  assertEquals(isStage("not_a_real_stage"), false);
  assertEquals(isStage(""), false);
  assertEquals(isStageDetail("npm — native"), true);
  assertEquals(isStageDetail(""), true); // empty detail is fine, just no extra text
  assertEquals(isStageDetail("x".repeat(201)), false); // bounded
});

Deno.test("parseQueueOp: a valid set_stage op requires a real stage + bounded detail", () => {
  const r = parseQueueOp({ op: "set_stage", token: "abc-123", stage: "cloning", detail: "shallow clone" });
  assertEquals(r.ok, true);
  if (r.ok && r.value.op === "set_stage") {
    assertEquals(r.value.stage, "cloning");
    assertEquals(r.value.detail, "shallow clone");
  }
  assertEquals(
    parseQueueOp({ op: "set_stage", token: "abc-123", stage: "not_real", detail: "" }).ok,
    false,
  );
});

Deno.test("parseQueueOp: a valid get_stage op needs only a clean token", () => {
  const r = parseQueueOp({ op: "get_stage", token: "abc-123" });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value.op, "get_stage");
  assertEquals(parseQueueOp({ op: "get_stage", token: "" }).ok, false);
});

Deno.test("parseQueueOp: claim/release ops carry the full (owner,repo,sha) lock identity + token", () => {
  for (const op of ["claim", "release"] as const) {
    const r = parseQueueOp({ op, token: "psf-requests-abc", owner: "psf", repo: "requests", sha: "abc123" });
    assertEquals(r.ok, true, `${op} with clean fields must parse`);
    if (r.ok && (r.value.op === "claim" || r.value.op === "release")) {
      assertEquals(r.value.op, op);
      assertEquals(r.value.owner, "psf");
      assertEquals(r.value.repo, "requests");
      assertEquals(r.value.sha, "abc123");
      assertEquals(r.value.token, "psf-requests-abc");
    }
    // The lock identity is charset-guarded exactly like enqueue — a dirty owner,
    // sha, or token is rejected before it can reach the dispatch-lock RPC.
    assertEquals(parseQueueOp({ op, token: "t", owner: "a/b", repo: "r", sha: "s" }).ok, false);
    assertEquals(parseQueueOp({ op, token: "bad tok", owner: "a", repo: "r", sha: "s" }).ok, false);
    assertEquals(parseQueueOp({ op, token: "t", owner: "a", repo: "r", sha: "bad sha" }).ok, false);
    assertEquals(parseQueueOp({ op, token: "t", owner: "a", repo: "r" }).ok, false); // sha missing
  }
});

Deno.test("parseQueueOp: unknown op and non-object bodies are rejected", () => {
  assertEquals(parseQueueOp({ op: "delete", token: "abc-123" }).ok, false);
  assertEquals(parseQueueOp(null).ok, false);
  assertEquals(parseQueueOp("nope").ok, false);
  assertEquals(parseQueueOp({}).ok, false);
});
