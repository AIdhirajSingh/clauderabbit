import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunEventBus } from "../../lib/engine/events.ts";
import { parseStrace } from "../../lib/engine/forensics/strace.ts";

test("sandbox events are stamped with the time they happened, clamped into the run", async () => {
  const startedAt = 1_800_000_000_000;
  const now = startedAt + 174_300; // collected at 174.3 s
  const bus = createRunEventBus({ runId: "r", startedAt, now: () => now });
  bus.emit({ type: "forged_call", data: { phase: "install", proto: "https", host: "c2.example", port: 443, req_bytes: 10, forged_kind: "http", canary_hits: [], at: startedAt + 101_250 } });
  bus.emit({ type: "file", data: { phase: "install", op: "read_decoy", path: "/home/cr/.aws/credentials", pid: 7, at: startedAt + 99_900 } });
  bus.emit({ type: "process", data: { phase: "install", pid: 7, ppid: 1, argv: ["node", "install.js"], at: startedAt - 5_000 } });
  bus.emit({ type: "process", data: { phase: "install", pid: 8, ppid: 1, argv: ["node", "x.js"], at: startedAt + 999_000 } });
  bus.emit({ type: "process", data: { phase: "install", pid: 9, ppid: 1, argv: ["node", "y.js"] } });
  const t = bus.events().map((e) => e.t_ms);
  assert.deepEqual(t, [101_250, 99_900, 0, 174_300, 174_300]);
  await bus.close();
});

test("strace -ttt times reach the file and process events", () => {
  const text = [
    '100 1800000101.250000 execve("/usr/bin/node", ["node", "install.js"], 0x7ffd /* 3 vars */) = 0',
    '100 1800000102.500000 openat(AT_FDCWD, "/home/cr/.aws/credentials", O_RDONLY) = 3',
  ].join("\n");
  const r = parseStrace(text, { phase: "install", initialCwd: "/work/src", decoyPaths: ["/home/cr/.aws/credentials"] } as Parameters<typeof parseStrace>[1]);
  const proc = r.processes.find((p) => p.argv[0] === "node");
  assert.equal(proc?.at, 1_800_000_101_250);
  const read = r.files.find((f) => f.op === "read_decoy");
  if (read) assert.equal(read.at, 1_800_000_102_500);
});
