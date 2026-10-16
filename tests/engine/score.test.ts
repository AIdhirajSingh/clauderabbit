import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_NOT_VERIFIED,
  bandFor,
  computeScore,
  deriveBehaviour,
  isPersistencePath,
  isSuspiciousInstallExec,
  isTunnelingDnsName,
  NO_BEHAVIOUR,
  verdictFor,
  type BehaviourSignals,
  type ScoreInput,
} from "../../lib/engine/score.ts";
import type { ReputationSignals } from "../../lib/engine/reputation.ts";
import type { ForgedCallData, TaggedFinding, TaggedReaderFinding } from "../../lib/engine/types.ts";

const NO_REP: ReputationSignals = {
  ownerAgeDays: null,
  ownerEstablished: null,
  npmFirstPublishDays: null,
  maintainerChangedWithin30d: null,
  weeklyDownloads: null,
  repoStars: null,
  evidence: [],
  unavailable: [],
};
const STRONG_REP: ReputationSignals = { ...NO_REP, ownerAgeDays: 3000, ownerEstablished: true, weeklyDownloads: 5_000_000 };

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    behaviour: NO_BEHAVIOUR,
    install: "completed",
    entry: "completed",
    archiveTruncated: false,
    coverage: { scanners: true, osv: true, readers: true },
    malicious: [],
    staticFindings: [],
    readerFindings: [],
    docs: null,
    capabilities: [],
    reputation: NO_REP,
    failedStages: [],
    ...over,
  };
}
const beh = (b: Partial<BehaviourSignals>): BehaviourSignals => ({ ...NO_BEHAVIOUR, ...b });
const sf = (over: Partial<TaggedFinding>): TaggedFinding => ({
  source: "heuristic",
  rule: "r",
  severity: "high",
  file: "lib/a.js",
  line: 1,
  message: "m",
  reach: "import",
  ...over,
});
const rf = (over: Partial<TaggedReaderFinding>): TaggedReaderFinding => ({
  reader: "flagged",
  file: "lib/a.js",
  line: 9,
  severity: "high",
  verdict: "malicious",
  title: "t",
  rationale: "r",
  reach: "import",
  ...over,
});

const CASES: Array<{ name: string; in: Partial<ScoreInput>; score: number; verdict: string }> = [
  { name: "clean run, no reputation signals", in: {}, score: 85, verdict: "Low risk" },
  { name: "clean run with established owner and downloads", in: { reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "clean established GitHub repo with 1000+ stars reaches 90", in: { reputation: { ...NO_REP, ownerAgeDays: 3000, ownerEstablished: true, repoStars: 1000 } }, score: 90, verdict: "No threats observed" },
  { name: "999 stars earn no popularity point", in: { reputation: { ...NO_REP, ownerAgeDays: 3000, ownerEstablished: true, repoStars: 999 } }, score: 88, verdict: "Low risk" },
  { name: "stars plus downloads stay within the reputation bound", in: { reputation: { ...STRONG_REP, repoStars: 50_000 } }, score: 90, verdict: "No threats observed" },
  { name: "one canary hit alone lands under 30", in: { behaviour: beh({ canaryHits: ["AWS_SECRET_ACCESS_KEY sent to c2.example"] }) }, score: 15, verdict: "Malicious" },
  { name: "canary with strong reputation is still capped at 15", in: { behaviour: beh({ canaryHits: ["x"] }), reputation: STRONG_REP }, score: 15, verdict: "Malicious" },
  { name: "decoy credential read", in: { behaviour: beh({ decoyReads: ["/home/cr/.ssh/id_rsa"] }) }, score: 50, verdict: "High risk" },
  { name: "persistence write is capped at 15", in: { behaviour: beh({ persistenceWrites: ["/home/cr/.bashrc"] }) }, score: 15, verdict: "Malicious" },
  { name: "DNS tunneling shape", in: { behaviour: beh({ tunnelingDns: ["x.evil.example"] }) }, score: 55, verdict: "High risk" },
  { name: "one non-distribution host", in: { behaviour: beh({ nonDistributionHosts: ["c2.example"] }) }, score: 60, verdict: "Caution" },
  { name: "two non-distribution hosts hit the -45 cap", in: { behaviour: beh({ nonDistributionHosts: ["a.example", "b.example"] }) }, score: 40, verdict: "High risk" },
  { name: "three non-distribution hosts stay at -45", in: { behaviour: beh({ nonDistributionHosts: ["a", "b", "c"] }) }, score: 40, verdict: "High risk" },
  { name: "TLS interception refused", in: { behaviour: beh({ tlsRefused: ["pinned.example"] }) }, score: 65, verdict: "Caution" },
  { name: "one install-hook exec", in: { behaviour: beh({ suspiciousInstallExecs: ["curl -s x"] }) }, score: 70, verdict: "Caution" },
  { name: "three install-hook execs cap at -30", in: { behaviour: beh({ suspiciousInstallExecs: ["curl", "wget", "nc"] }) }, score: 55, verdict: "High risk" },
  { name: "one distribution fetch", in: { behaviour: beh({ distributionFetches: ["github.com"] }) }, score: 82, verdict: "Low risk" },
  { name: "four distribution fetches cap at -9", in: { behaviour: beh({ distributionFetches: ["a", "b", "c", "d"] }) }, score: 76, verdict: "Caution" },
  { name: "behaviour group floors at -85", in: { behaviour: beh({ decoyReads: ["a"], tunnelingDns: ["b"], tlsRefused: ["c"], nonDistributionHosts: ["d", "e"] }) }, score: 0, verdict: "Malicious" },
  { name: "malicious dependency caps at 25", in: { malicious: [{ ecosystem: "npm", name: "evil", version: "1.0.0", ids: ["MAL-2025-1"] }], reputation: STRONG_REP }, score: 25, verdict: "Malicious" },
  { name: "one reachable high static finding", in: { staticFindings: [sf({})] }, score: 73, verdict: "Caution" },
  { name: "one reachable medium static finding", in: { staticFindings: [sf({ severity: "medium" })] }, score: 80, verdict: "Low risk" },
  { name: "low static finding is worth 0", in: { staticFindings: [sf({ severity: "low" })] }, score: 85, verdict: "Low risk" },
  { name: "unreachable high finding changes nothing", in: { staticFindings: [sf({ reach: "unreachable", file: "test/a.js" })], reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "same file:line from two scanners counts once at the worst weight", in: { staticFindings: [sf({ source: "semgrep" }), sf({ source: "yara", severity: "medium" })] }, score: 73, verdict: "Caution" },
  { name: "static floor at -40", in: { staticFindings: [1, 2, 3, 4, 5].map((line) => sf({ line })) }, score: 45, verdict: "High risk" },
  { name: "reader malicious high", in: { readerFindings: [rf({})] }, score: 77, verdict: "Caution" },
  { name: "reader suspicious medium", in: { readerFindings: [rf({ severity: "medium", verdict: "suspicious" })] }, score: 81, verdict: "Low risk" },
  { name: "reader benign finding is worth 0", in: { readerFindings: [rf({ verdict: "benign" })] }, score: 85, verdict: "Low risk" },
  { name: "reader finding in unreachable file is worth 0", in: { readerFindings: [rf({ reach: "unreachable" })] }, score: 85, verdict: "Low risk" },
  { name: "reader and static on the same line dedup to the worst", in: { staticFindings: [sf({ line: 9 })], readerFindings: [rf({})] }, score: 73, verdict: "Caution" },
  {
    name: "docs no-network contradicted by behaviour",
    in: { docs: { declaresNoNetwork: true, declaresPure: false, quote: "makes no network requests" }, behaviour: beh({ nonDistributionHosts: ["c2.example"] }) },
    score: 45,
    verdict: "High risk",
  },
  {
    name: "docs no-network contradicted by reachable static capability only",
    in: { docs: { declaresNoNetwork: true, declaresPure: false, quote: "offline" }, capabilities: [{ file: "lib/a.js", capability: "network", reach: "import" }] },
    score: 79,
    verdict: "Caution",
  },
  {
    name: "docs no-network with only unreachable network capability",
    in: { docs: { declaresNoNetwork: true, declaresPure: false, quote: "offline" }, capabilities: [{ file: "test/a.js", capability: "network", reach: "unreachable" }] },
    score: 85,
    verdict: "Low risk",
  },
  {
    name: "docs pure contradicted by reachable process capability",
    in: { docs: { declaresNoNetwork: false, declaresPure: true, quote: "pure functions" }, capabilities: [{ file: "a.js", capability: "process", reach: "install" }] },
    score: 79,
    verdict: "Caution",
  },
  { name: "new GitHub owner", in: { reputation: { ...NO_REP, ownerAgeDays: 10 } }, score: 80, verdict: "Low risk" },
  {
    name: "reputation lower bound -8",
    in: { reputation: { ...NO_REP, ownerAgeDays: 5, npmFirstPublishDays: 3, maintainerChangedWithin30d: true } },
    score: 77,
    verdict: "Caution",
  },
  { name: "install failed caps at 74", in: { install: "failed" }, score: 74, verdict: "Caution" },
  { name: "install timeout caps at 74 even with strong reputation", in: { install: "timeout", reputation: STRONG_REP }, score: 74, verdict: "Caution" },
  { name: "install skipped caps at 74", in: { install: "skipped", entry: "skipped" }, score: 74, verdict: "Caution" },
  { name: "archive truncated caps at 74", in: { archiveTruncated: true }, score: 74, verdict: "Caution" },
  { name: "entry skipped caps at 89", in: { entry: "skipped", reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "entry failed caps at 89", in: { entry: "failed", reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "scanner coverage missing blocks 90", in: { coverage: { scanners: false, osv: true, readers: true }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "OSV coverage missing blocks 90", in: { coverage: { scanners: true, osv: false, readers: true }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "reader coverage missing blocks 90", in: { coverage: { scanners: true, osv: true, readers: false }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "negative reputation blocks 90", in: { reputation: { ...STRONG_REP, maintainerChangedWithin30d: true, npmFirstPublishDays: 2, ownerAgeDays: 10, ownerEstablished: false, weeklyDownloads: 0 } }, score: 77, verdict: "Caution" },
];

for (const c of CASES) {
  test(`score: ${c.name}`, () => {
    const r = computeScore(input(c.in));
    assert.equal(r.score, c.score);
    assert.equal(r.verdict, c.verdict);
    assert.notEqual(r.verdict as string, "Safe");
    assert.ok(r.notVerified.length >= BASE_NOT_VERIFIED.length);
    for (const b of BASE_NOT_VERIFIED) assert.ok(r.notVerified.includes(b));
    const sum = 85 + r.breakdown.filter((d) => d.group !== "cap").reduce((s, d) => s + d.points, 0);
    assert.equal(Math.min(100, Math.max(0, sum)), r.raw, "breakdown sums to the raw score");
    const capped = r.raw + r.breakdown.filter((d) => d.group === "cap").reduce((s, d) => s + d.points, 0);
    assert.equal(capped, r.score, "caps in the breakdown explain the final score");
  });
}

test("score: behaviour outweighs static (max static loss is smaller than one canary)", () => {
  const worstStatic = computeScore(input({ staticFindings: Array.from({ length: 20 }, (_, i) => sf({ line: i + 1 })) }));
  const oneCanary = computeScore(input({ behaviour: beh({ canaryHits: ["x"] }) }));
  assert.ok(worstStatic.score > oneCanary.score);
  assert.equal(worstStatic.groups.static, -40);
});

test("score: failed phases and coverage gaps are listed in not_verified", () => {
  const r = computeScore(input({ install: "timeout", coverage: { scanners: false, osv: false, readers: false }, failedStages: ["Stage osv passed its deadline."], reputation: { ...NO_REP, unavailable: ["npm download counts"] } }));
  const text = r.notVerified.join("\n");
  assert.match(text, /Install phase did not complete \(timeout\)/);
  assert.match(text, /Static scanners/);
  assert.match(text, /OSV malicious-package lookup/);
  assert.match(text, /Model readers/);
  assert.match(text, /npm download counts/);
  assert.match(text, /Stage osv passed its deadline/);
});

test("verdict words and bands at every boundary; never Safe", () => {
  const table: Array<[number, string, string]> = [
    [100, "No threats observed", "green"],
    [90, "No threats observed", "green"],
    [89, "Low risk", "blue"],
    [80, "Low risk", "blue"],
    [79, "Caution", "yellow"],
    [60, "Caution", "yellow"],
    [59, "High risk", "red"],
    [30, "High risk", "red"],
    [29, "Malicious", "red"],
    [0, "Malicious", "red"],
  ];
  for (const [s, v, b] of table) {
    assert.equal(verdictFor(s), v);
    assert.equal(bandFor(s), b);
    assert.doesNotMatch(verdictFor(s), /\bsafe\b/i);
  }
});

test("behaviour classifiers", () => {
  assert.equal(isTunnelingDnsName("a9f3k2l1m8n7b6v5c4x3z2q1w0e9r8t7y6u5i4o3p2.evil.example"), true);
  assert.equal(isTunnelingDnsName("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.evil.example"), false);
  assert.equal(isTunnelingDnsName("www.example.com"), false);
  assert.equal(isPersistencePath("/home/cr/.bashrc"), true);
  assert.equal(isPersistencePath("/home/cr/.config/systemd/user/x.service"), true);
  assert.equal(isPersistencePath("/home/cr/.ssh/authorized_keys"), true);
  assert.equal(isPersistencePath("/etc/hosts"), true);
  assert.equal(isPersistencePath("/work/app/node_modules/x/.profile.js"), false);
  assert.equal(isSuspiciousInstallExec(["/usr/bin/curl", "-s", "x"]), true);
  assert.equal(isSuspiciousInstallExec(["bash", "-c", "x"]), true);
  assert.equal(isSuspiciousInstallExec(["sh", "-c", "node beacon.js"]), false);
  assert.equal(isSuspiciousInstallExec(["base64", "-d"]), true);
  assert.equal(isSuspiciousInstallExec(["node", "x.js"]), false);
});

test("deriveBehaviour maps forensics onto behaviour signals", () => {
  const call = (over: Partial<ForgedCallData>): ForgedCallData => ({
    phase: "install",
    proto: "https",
    host: "x",
    port: 443,
    req_bytes: 10,
    forged_kind: "json",
    canary_hits: [],
    ...over,
  });
  const b = deriveBehaviour({
    forgedCalls: [
      call({ host: "registry.npmjs.org", forged_kind: "mirror" }),
      call({ host: "c2.cr-fixture.invalid", proto: "http", port: 80, canary_hits: ["AWS_SECRET_ACCESS_KEY"] }),
      call({ host: "C2.cr-fixture.invalid", phase: "entry" }),
      call({ host: "github.com" }),
      call({ host: "pinned.example", tls: "refused" }),
      call({ host: "a9f3k2l1m8n7b6v5c4x3z2q1w0e9r8t7y6u5i4o3p2.evil.example", proto: "dns", port: 53 }),
      call({ host: "registry.npmjs.org", forged_kind: "json" }),
    ],
    files: [
      { phase: "install", op: "read_decoy", path: "/home/cr/.aws/credentials", pid: 5 },
      { phase: "install", op: "write", path: "/home/cr/.bashrc", pid: 5 },
      { phase: "install", op: "unlink", path: "/home/cr/.profile", pid: 5 },
      { phase: "entry", op: "write", path: "/work/app/out.txt", pid: 6 },
    ],
    processes: [
      { phase: "install", pid: 7, ppid: 1, argv: ["sh", "-c", "node beacon.js"] },
      { phase: "install", pid: 8, ppid: 7, argv: ["/usr/bin/curl", "-s", "http://c2/x"] },
      { phase: "entry", pid: 9, ppid: 1, argv: ["wget", "x"] },
      { phase: "entry", pid: 10, ppid: 1, argv: ["crontab", "/tmp/c"] },
    ],
    canaryInFiles: ["/tmp/stash.txt"],
  });
  assert.deepEqual(b.canaryHits, ["AWS_SECRET_ACCESS_KEY sent to c2.cr-fixture.invalid (http, install)", "canary copied into written file /tmp/stash.txt"]);
  assert.deepEqual(b.nonDistributionHosts, ["c2.cr-fixture.invalid", "pinned.example", "registry.npmjs.org"]);
  assert.deepEqual(b.distributionFetches, ["github.com"]);
  assert.deepEqual(b.tlsRefused, ["pinned.example"]);
  assert.equal(b.tunnelingDns.length, 1);
  assert.deepEqual(b.decoyReads, ["/home/cr/.aws/credentials"]);
  assert.deepEqual(b.persistenceWrites, ["/home/cr/.bashrc", "crontab /tmp/c"]);
  assert.deepEqual(b.suspiciousInstallExecs, ["/usr/bin/curl -s http://c2/x"]);
  const r = computeScore(input({ behaviour: b }));
  assert.equal(r.score, 0);
  assert.equal(r.verdict, "Malicious");
  assert.equal(r.groups.behaviour, -85);
});
