/**
 * Unit tests for run-timeline.ts — collapsing the deep sandbox's streamed run
 * milestones into the persisted log chapters of an escalated report.
 *
 * Run: `deno test supabase/functions/_shared/run-timeline.test.ts`
 *
 * These assert the invariants that make "view logs" the COMPLETE real record:
 *   - the active+done events of one step collapse to a single chapter (no dupes)
 *   - first-seen order is preserved (provision -> build -> run -> capture)
 *   - the worst kind wins (a step that warns then ends ok stays warn)
 *   - the "Persist" bookkeeping step is dropped (it writes THIS very log)
 *   - untrusted input is bounded (stage count, line count, line length)
 *   - a legacy runner that sends no timeline yields no chapters (back-compat)
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  isDeepRunChapter,
  MAX_CHAPTER_LINES,
  MAX_LINE_LEN,
  MAX_LINES_PER_STAGE,
  MAX_TIMELINE_STAGES,
  sanitizeTimeline,
  timelineToChapters,
} from "./run-timeline.ts";

// The real shape the /api/deep route streams: an active event then a done event
// per step, with the "Persist" bookkeeping step at the end.
const STREAMED = [
  { ch: "Escalate", status: "active", lines: ["Gate tripped — spawning a fresh sealed sandbox VM"] },
  { ch: "Provision detonation VM", status: "active", lines: ["Booting a fresh sealed VM"] },
  { ch: "Provision detonation VM", status: "done", kind: "ok", lines: ["Detonation VM up"] },
  { ch: "Build under containment", status: "active", lines: ["Installing deps via the trap proxy"] },
  { ch: "Build under containment", status: "done", kind: "ok", lines: ["Containment confirmed"] },
  { ch: "Run under the sinkhole", status: "active", lines: ["Running the code"] },
  { ch: "Capture + reset", status: "done", kind: "ok", lines: ["Scan complete — trap VM deleted"] },
  { ch: "Persist", status: "done", kind: "ok", lines: ["Forensics attached"] },
];

Deno.test("collapses active+done of one step into a single ordered chapter", () => {
  const chapters = timelineToChapters(sanitizeTimeline(STREAMED));
  // Persist dropped → 5 real steps, in first-seen order.
  assertEquals(
    chapters.map((c) => c.ch),
    ["Escalate", "Provision detonation VM", "Build under containment", "Run under the sinkhole", "Capture + reset"],
  );
  const vm = chapters.find((c) => c.ch === "Provision detonation VM");
  assert(vm);
  assertEquals(vm.lines, ["Booting a fresh sealed VM", "Detonation VM up"]); // unioned, no dupes
});

Deno.test("drops the Persist bookkeeping step (it writes THIS log)", () => {
  const chapters = timelineToChapters(sanitizeTimeline(STREAMED));
  assert(!chapters.some((c) => /persist/i.test(c.ch)));
});

Deno.test("the worst kind wins across a step's events", () => {
  const chapters = timelineToChapters(
    sanitizeTimeline([
      { ch: "Provision detonation VM", status: "active", kind: "warn", lines: ["No golden image — degraded build"] },
      { ch: "Provision detonation VM", status: "done", kind: "ok", lines: ["Detonation VM up"] },
    ]),
  );
  assertEquals(chapters.length, 1);
  assertEquals(chapters[0]?.kind, "warn"); // warn (the worse signal) is not overwritten by a later ok
});

Deno.test("de-duplicates identical lines repeated across events", () => {
  const chapters = timelineToChapters(
    sanitizeTimeline([
      { ch: "Run under the sinkhole", lines: ["Running the code"] },
      { ch: "Run under the sinkhole", lines: ["Running the code"] },
    ]),
  );
  assertEquals(chapters[0]?.lines, ["Running the code"]);
});

Deno.test("a legacy runner that sends no timeline yields no chapters", () => {
  assertEquals(timelineToChapters(sanitizeTimeline(undefined)), []);
  assertEquals(timelineToChapters(sanitizeTimeline(null)), []);
  assertEquals(timelineToChapters(sanitizeTimeline("not an array")), []);
  assertEquals(timelineToChapters(sanitizeTimeline([])), []);
});

Deno.test("bounds untrusted input: stage count, line count, line length", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    ch: `Step ${i}`,
    lines: Array.from({ length: 50 }, (_, j) => "x".repeat(1000) + j),
  }));
  const sanitized = sanitizeTimeline(many);
  assert(sanitized.length <= MAX_TIMELINE_STAGES, "stage count is capped");
  for (const s of sanitized) {
    assert(s.lines.length <= MAX_LINES_PER_STAGE, "per-stage line count is capped");
    for (const l of s.lines) assert(l.length <= MAX_LINE_LEN, "line length is capped");
  }
  // A single step repeated 100 times accumulates lines, but the chapter is capped.
  const oneStep = Array.from({ length: 100 }, (_, i) => ({ ch: "Build", lines: [`line ${i}`] }));
  const chapters = timelineToChapters(sanitizeTimeline(oneStep));
  assertEquals(chapters.length, 1);
  assert((chapters[0]?.lines.length ?? 0) <= MAX_CHAPTER_LINES, "chapter lines are capped");
});

Deno.test("isDeepRunChapter recognizes run chapters but not stage-1 chapters", () => {
  // Run chapters a re-attach must drop (else duplicates compound).
  for (const ch of ["Escalate", "Provision detonation VM", "Build under containment", "Sandbox run", " Sandbox run "]) {
    assert(isDeepRunChapter(ch), `${ch} is a deep-run chapter`);
  }
  // Stage-1 chapters a re-attach must KEEP (note "Clone" != the run's "Clone + pin").
  for (const ch of ["Clone", "Static scan", "Reputation", "Read", "Score"]) {
    assert(!isDeepRunChapter(ch), `${ch} is NOT a deep-run chapter`);
  }
});

Deno.test("skips items with no channel and drops non-string lines", () => {
  const chapters = timelineToChapters(
    sanitizeTimeline([
      { ch: "", lines: ["orphan"] },
      { lines: ["no ch field"] },
      { ch: "Build", lines: ["real", 42, null, "  ", "kept"] },
    ]),
  );
  assertEquals(chapters.length, 1);
  assertEquals(chapters[0]?.ch, "Build");
  assertEquals(chapters[0]?.lines, ["real", "kept"]);
});
