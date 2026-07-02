/**
 * Unit tests for the pure /api/deep queue brain (lib/deep-queue.ts).
 *
 * The streaming route is coupled to child_process + gcloud, so the ORDERING,
 * POSITION, WAIT-ESTIMATE, and TIMEOUT logic is extracted here into a pure module
 * and unit-tested in isolation (the route is a thin driver over it). These lock the
 * three load-bearing guarantees of the queue:
 *   1. strict FIFO — a later arrival never acquires a freed slot ahead of an
 *      earlier waiter, even under interleaved/concurrent inserts;
 *   2. position is computed from real state (count of older waiters);
 *   3. the timeout predicate fires at the deadline (so the wait path can end
 *      honestly instead of hanging forever).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeepScanQueue,
  estimateWaitMs,
  formatWait,
  isExpired,
  queueLine,
} from "../lib/deep-queue.ts";

// ── FIFO ordering + head-of-line admission ──────────────────────────────────

test("enqueue preserves strict arrival order; head is always the oldest", () => {
  const q = new DeepScanQueue();
  q.enqueue("a");
  q.enqueue("b");
  q.enqueue("c");
  assert.equal(q.size(), 3);
  assert.equal(q.head(), "a");
});

test("enqueue is idempotent — re-enqueuing a present token does not duplicate it", () => {
  const q = new DeepScanQueue();
  q.enqueue("a");
  q.enqueue("a");
  q.enqueue("b");
  assert.equal(q.size(), 2);
  assert.equal(q.head(), "a");
});

test("canAcquire is TRUE only for the head AND only when a slot is free (2 slots)", () => {
  const q = new DeepScanQueue();
  q.enqueue("a");
  q.enqueue("b");
  // Both slots busy → even the head cannot acquire.
  assert.equal(q.canAcquire("a", 2, 2), false);
  // A slot freed → the head (a) may acquire; a non-head (b) may NOT (strict FIFO).
  assert.equal(q.canAcquire("a", 1, 2), true);
  assert.equal(q.canAcquire("b", 1, 2), false);
  // A token not in the queue never acquires.
  assert.equal(q.canAcquire("zzz", 0, 2), false);
});

test("strict FIFO across a full drain: later arrival never jumps an earlier waiter", () => {
  const q = new DeepScanQueue();
  // Interleaved/"concurrent" inserts: arrival order is a,b,c,d.
  for (const t of ["a", "b", "c", "d"]) q.enqueue(t);

  // Simulate a single-process poll: MAX=2. inFlight starts at 2 (both slots busy).
  let inFlight = 2;
  const admitted: string[] = [];
  // Each "round" a slot frees; only the head may take it, then it leaves the queue.
  while (q.size() > 0) {
    inFlight = 1; // a detonation finished → one slot free
    // Only the head can acquire; assert no other waiter can.
    const head = q.head() as string;
    for (const other of ["a", "b", "c", "d"]) {
      if (q.has(other) && other !== head) {
        assert.equal(q.canAcquire(other, inFlight, 2), false, `${other} must not jump ${head}`);
      }
    }
    assert.equal(q.canAcquire(head, inFlight, 2), true);
    q.remove(head);
    admitted.push(head);
    inFlight = 2; // the admitted run now occupies the freed slot
  }
  // Admission order is EXACTLY arrival order.
  assert.deepEqual(admitted, ["a", "b", "c", "d"]);
});

// ── position / standing ─────────────────────────────────────────────────────

test("standing: position is 1-based, ahead is the count of older waiters", () => {
  const q = new DeepScanQueue();
  q.enqueue("a");
  q.enqueue("b");
  q.enqueue("c");
  assert.deepEqual(q.standing("a"), { ahead: 0, waitingTotal: 3, position: 1 });
  assert.deepEqual(q.standing("b"), { ahead: 1, waitingTotal: 3, position: 2 });
  assert.deepEqual(q.standing("c"), { ahead: 2, waitingTotal: 3, position: 3 });
});

test("standing: position updates as earlier waiters leave (admitted or timed out)", () => {
  const q = new DeepScanQueue();
  q.enqueue("a");
  q.enqueue("b");
  q.enqueue("c");
  // 'a' is admitted (or gives up) → b becomes head, c moves up.
  q.remove("a");
  assert.deepEqual(q.standing("b"), { ahead: 0, waitingTotal: 2, position: 1 });
  assert.deepEqual(q.standing("c"), { ahead: 1, waitingTotal: 2, position: 2 });
});

test("standing: a token not in the queue reports ahead -1 / position 0 (not waiting)", () => {
  const q = new DeepScanQueue();
  q.enqueue("a");
  const s = q.standing("ghost");
  assert.equal(s.ahead, -1);
  assert.equal(s.position, 0);
  assert.equal(s.waitingTotal, 1);
});

// ── wait estimate + formatting ──────────────────────────────────────────────

test("estimateWaitMs: rounds up in detonation 'rounds' of `slots` parallel runs", () => {
  const per = 90_000; // 90s
  // Head (ahead 0), 2 slots → waits at most one round for a slot to free.
  assert.equal(estimateWaitMs(0, 2, per), 90_000);
  // ahead 1 → still one round (2 slots clear 2 at a time: positions 1&2 same round).
  assert.equal(estimateWaitMs(1, 2, per), 90_000);
  // ahead 2 → the 3rd waiter needs a second round.
  assert.equal(estimateWaitMs(2, 2, per), 180_000);
  // ahead 3 → still the second round (4th waiter).
  assert.equal(estimateWaitMs(3, 2, per), 180_000);
  // Not waiting → zero.
  assert.equal(estimateWaitMs(-1, 2, per), 0);
});

test("estimateWaitMs: a single slot serializes — one round per waiter ahead + self", () => {
  const per = 90_000;
  assert.equal(estimateWaitMs(0, 1, per), 90_000);
  assert.equal(estimateWaitMs(2, 1, per), 270_000);
});

test("formatWait: seconds under a minute, minutes above, and a clean zero", () => {
  assert.equal(formatWait(0), "under a minute");
  assert.equal(formatWait(40_000), "~40 sec");
  assert.equal(formatWait(90_000), "~2 min"); // 90s rounds to 2 min
  assert.equal(formatWait(180_000), "~3 min");
});

test("queueLine: the honest user-facing line reads position N of M with a real ~wait", () => {
  const q = new DeepScanQueue();
  q.enqueue("a");
  q.enqueue("b");
  q.enqueue("c");
  const line = queueLine(q.standing("c"), 2, 90_000);
  assert.match(line, /position 3 of 3/);
  assert.match(line, /~3 min estimated wait/);
});

// ── timeout predicate ───────────────────────────────────────────────────────

test("isExpired: false before the deadline, true at and after it", () => {
  const started = 1_000_000;
  const deadline = 8 * 60_000; // 8 min
  assert.equal(isExpired(started, started + deadline - 1, deadline), false);
  assert.equal(isExpired(started, started + deadline, deadline), true);
  assert.equal(isExpired(started, started + deadline + 5_000, deadline), true);
});

test("isExpired: a request that just arrived has not expired", () => {
  const now = 5_000_000;
  assert.equal(isExpired(now, now, 8 * 60_000), false);
});
