import { test } from "node:test";
import assert from "node:assert/strict";
import { INTERNAL_WORDS, plainWords } from "../../lib/engine/model/writer.ts";

test("Luna's paragraphs: internal words become builder words, and none survive", () => {
  const raw =
    "The run did not produce a complete forensic record, so install-time behaviour was not observed. Static heuristics flagged 14 reachable finding location(s), though the model check judged them benign. Semgrep, YARA and GuardDog ran; the OSV lookup found nothing; a canary left via the fence.";
  const out = plainWords(raw);
  assert.equal(INTERNAL_WORDS.test(out), false, out);
  assert.match(out, /full record of the run/);
  assert.match(out, /pattern checks/);
  assert.match(out, /14 flagged places in code that can run/);
  assert.match(out, /our code review/);
  assert.match(out, /the malware database/);
});
