import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTarball } from "../../lib/engine/archive.ts";
import { makeCanaries } from "../../lib/engine/forensics/capture.ts";
import { runAnalysis } from "../../lib/engine/sandbox/analyze.ts";
import { detonate, EXIT_NOT_CONTAINED, SALVAGE_ARCHIVE } from "../../lib/engine/sandbox/detonate.ts";
import { e2bCreateOptions } from "../../lib/engine/sandbox/e2b.ts";
import { packFiles } from "../../lib/engine/sandbox/pack.ts";
import { SandboxCreateError, withSandbox, type CommandResult, type SandboxCreateOptions, type SandboxProvider, type SandboxSession } from "../../lib/engine/sandbox/provider.ts";
import { filesOf, makeTgz } from "../support/tar.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const enc = new TextEncoder();

class StubSession implements SandboxSession {
  readonly id = "stub-1";
  readonly files = new Map<string, Uint8Array>();
  killed = 0;
  commands: string[] = [];
  private onRun: (cmd: string, s: StubSession) => CommandResult | Promise<CommandResult>;
  constructor(onRun: (cmd: string, s: StubSession) => CommandResult | Promise<CommandResult>) {
    this.onRun = onRun;
  }
  async writeFile(p: string, d: Uint8Array | string) {
    this.files.set(p, typeof d === "string" ? enc.encode(d) : d);
  }
  async run(cmd: string): Promise<CommandResult> {
    this.commands.push(cmd);
    return this.onRun(cmd, this);
  }
  async readFile(p: string) {
    const v = this.files.get(p);
    if (!v) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async kill() {
    this.killed++;
  }
}

class StubProvider implements SandboxProvider {
  readonly template = "stub";
  created: SandboxCreateOptions[] = [];
  session: StubSession | Error;
  constructor(session: StubSession | Error) {
    this.session = session;
  }
  async create(opts: SandboxCreateOptions) {
    this.created.push(opts);
    if (this.session instanceof Error) throw this.session;
    return this.session;
  }
}

test("e2b create options: detonation is registry-only, analysis has no internet", () => {
  const d = e2bCreateOptions({ purpose: "detonate", runId: "r1", timeoutMs: 90_000, network: "registry-only" }, "k");
  assert.deepEqual(d, {
    apiKey: "k",
    timeoutMs: 90_000,
    metadata: { runId: "r1", purpose: "detonate" },
    allowInternetAccess: true,
    network: { denyOut: ["0.0.0.0/0"], allowOut: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"] },
  });
  const a = e2bCreateOptions({ purpose: "analyze", runId: "r1", timeoutMs: 90_000, network: "none" }, "k");
  assert.equal(a.allowInternetAccess, false);
  assert.equal("network" in a, false);
});

test("withSandbox kills in finally, also when the body throws; create failures are typed", async () => {
  const s = new StubSession(() => ({ exitCode: 0, stdout: "", stderr: "" }));
  const killed: Array<[boolean, string]> = [];
  await assert.rejects(
    withSandbox(new StubProvider(s), { purpose: "detonate", runId: "r", timeoutMs: 1, network: "registry-only" }, async () => {
      throw new Error("boom");
    }, (ok, d) => killed.push([ok, d])),
    /boom/,
  );
  assert.equal(s.killed, 1);
  assert.equal(killed[0]![0], true);
  await assert.rejects(
    withSandbox(new StubProvider(new Error("rate limited")), { purpose: "analyze", runId: "r", timeoutMs: 1, network: "none" }, async () => 1),
    (e: unknown) => e instanceof SandboxCreateError && e.purpose === "analyze",
  );
});

test("packFiles round-trips through the archive parser, long paths included", async () => {
  const long = "a/" + "b".repeat(120) + "/c.js";
  const files = filesOf({ "package.json": "{}", "lib/index.js": "x", [long]: "long" });
  const archive = await parseTarball(packFiles(files), { maxCompressedBytes: 1 << 20, maxExpandedBytes: 1 << 22, maxFiles: 100 });
  assert.deepEqual([...archive.files.keys()].sort(), [long, "lib/index.js", "package.json"].sort());
  assert.equal(new TextDecoder().decode(archive.files.get(long)), "long");
});

test("runAnalysis parses each tool's real output shape and reports coverage", async () => {
  const semgrep = { results: [{ check_id: "cr.js.eval-decoded-payload", path: "/work/src/lib/x.js", start: { line: 3 }, extra: { message: "eval", severity: "ERROR" } }], errors: [] };
  const s = new StubSession((cmd, self) => {
    assert.match(cmd, /cr-analyze\.sh/);
    self.files.set("/root/out/semgrep.json", enc.encode(JSON.stringify(semgrep)));
    self.files.set("/root/out/yara.json", enc.encode(JSON.stringify({ matches: [], errors: [] })));
    self.files.set("/root/out/guarddog-npm.json", enc.encode(JSON.stringify({ results: {}, errors: {} })));
    self.files.set("/root/out/status.json", enc.encode(JSON.stringify({ semgrep: { exit: 0, ms: 5 }, yara: { exit: 0, ms: 2 }, "guarddog-npm": { exit: 0, ms: 9 } })));
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const p = new StubProvider(s);
  const r = await runAnalysis(p, { runId: "r", files: filesOf({ "lib/x.js": "eval(atob(x))" }), ecosystems: ["npm"], sandboxTimeoutMs: 1000, commandTimeoutMs: 15_000 });
  assert.equal(p.created[0]!.network, "none");
  assert.equal(r.complete, true);
  assert.deepEqual(r.findings.map((f) => [f.source, f.file, f.line, f.severity]), [["semgrep", "lib/x.js", 3, "high"]]);
  assert.ok(s.files.has("/root/in/src.tgz"));
  assert.equal(s.killed, 1);

  const s2 = new StubSession((_c, self) => {
    self.files.set("/root/out/semgrep.json", enc.encode(JSON.stringify({ results: [], errors: [] })));
    self.files.set("/root/out/status.json", enc.encode(JSON.stringify({ semgrep: { exit: 0, ms: 1 }, yara: { exit: 124, ms: 12000 } })));
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const r2 = await runAnalysis(new StubProvider(s2), { runId: "r", files: filesOf({ "a.py": "x" }), ecosystems: ["python"], sandboxTimeoutMs: 1000, commandTimeoutMs: 15_000 });
  assert.equal(r2.complete, false);
  assert.ok(r2.errors.some((e) => e.startsWith("yara:")));
  assert.ok(r2.errors.some((e) => e.startsWith("guarddog-pypi:")));
});

test("detonate writes per-run inputs as root, parses the bundle, and kills the VM", async () => {
  const canaries = makeCanaries();
  const capture = [
    { t: 1, phase: "install", proto: "https", host: "c2.example", port: 443, method: "POST", path: "/c", sni: "c2.example", req_headers: {}, req_bytes: 40, req_body_b64: Buffer.from(`k=${canaries.AWS_SECRET_ACCESS_KEY}`).toString("base64"), forged_kind: "json", tls: "intercepted" },
    { t: 2, phase: "collect", proto: "https", host: "registry.npmjs.org", port: 443, method: "GET", path: "/x", sni: null, req_headers: {}, req_bytes: 0, req_body_b64: "", forged_kind: "registry", tls: "intercepted" },
  ];
  const result = { version: 1, mode: "npm-package", ecosystem: "npm", deps_kind: "npm-ls", install: { status: "completed", exit_code: 0, ms: 900, command: "npm install --no-audit --no-fund /work/pkg.tgz" }, entry: { status: "failed", exit_code: 1, ms: 40 }, clock: { real_ms: 40, fake_ms: 1000 }, total_ms: 2000 };
  const bundle = makeTgz([
    { name: "out/", type: "dir" },
    { name: "out/result.json", data: JSON.stringify(result) },
    { name: "out/checks.jsonl", data: '{"name":"egress_contained","ok":true,"detail":"x"}\n{"name":"clock_accelerated","ok":true}\n' },
    { name: "out/capture.jsonl", data: capture.map((c) => JSON.stringify(c)).join("\n") },
    { name: "out/trace.install", data: `9 1.0 execve("/bin/sh", ["sh", "-c", "node i.js"], 0x1 /* 1 vars */) = 0\n` },
    { name: "out/trace.entry", data: "" },
    { name: "out/deps.json", data: JSON.stringify({ name: "cr-run-app", dependencies: { evil: { version: "1.0.0", dependencies: { "left-pad": { version: "1.3.0" } } } } }) },
    { name: "out/canary_files.txt", data: "/home/cr/.cache/stolen.txt\n" },
    { name: "out/install.out", data: "added 2 packages" },
  ]);
  const s = new StubSession((cmd, self) => {
    assert.match(cmd, /chmod 0600 \/root\/\.cr\/canary\.env .*bash \/opt\/cr\/bin\/cr-detonate\.sh$/);
    self.files.set("/root/out.tgz", bundle);
    return { exitCode: 0, stdout: "cr: done", stderr: "" };
  });
  const p = new StubProvider(s);
  const d = await detonate(p, { runId: "r", mode: "npm-package", packageName: "evil", tarball: new Uint8Array([1, 2, 3]), canaries, installTimeoutMs: 20_000, entryTimeoutMs: 4_000, totalTimeoutMs: 30_000, sandboxTimeoutMs: 90_000, fakeRate: 30 });
  assert.equal(p.created[0]!.network, "registry-only");
  assert.equal(s.killed, 1);
  const run = JSON.parse(new TextDecoder().decode(s.files.get("/root/in/run.json")));
  assert.deepEqual(run, { mode: "npm-package", name: "evil", install_timeout_s: 20, entry_timeout_s: 4, fake_rate: 30 });
  assert.ok(new TextDecoder().decode(s.files.get("/root/.cr/canary.env")).includes(canaries.GITHUB_TOKEN));
  assert.equal(d.install, "completed");
  assert.equal(d.entry, "failed");
  assert.equal(d.forgedCalls.length, 1, "collect-phase records are harness traffic");
  assert.deepEqual(d.forgedCalls[0]!.canary_hits, ["AWS_SECRET_ACCESS_KEY"]);
  assert.deepEqual(d.processes.map((x) => x.argv.join(" ")), ["sh -c node i.js"]);
  assert.deepEqual(d.canaryInFiles, ["/home/cr/.cache/stolen.txt"]);
  assert.deepEqual(d.installedDeps?.map((x) => `${x.name}@${x.version}`).sort(), ["evil@1.0.0", "left-pad@1.3.0"]);
  assert.equal(d.checks.length, 2);
  assert.equal(d.timings["detonate.install"], 900);
});

test("detonate: failed containment probe means no repo code ran; a deadline means timeout", async () => {
  const blocked = new StubSession(() => ({ exitCode: EXIT_NOT_CONTAINED, stdout: "", stderr: "containment probe failed" }));
  const d = await detonate(new StubProvider(blocked), { runId: "r", mode: "repo", packageName: null, tarball: new Uint8Array(1), canaries: makeCanaries(), installTimeoutMs: 1000, entryTimeoutMs: 1000, totalTimeoutMs: 1000, sandboxTimeoutMs: 1000, fakeRate: 30 });
  assert.equal(d.install, "skipped");
  assert.ok(d.checks.some((c) => c.name === "egress_contained" && !c.ok));
  assert.equal(blocked.killed, 1);

  const slow = new StubSession(() => {
    throw new Error("deadline exceeded");
  });
  const t = await detonate(new StubProvider(slow), { runId: "r", mode: "repo", packageName: null, tarball: new Uint8Array(1), canaries: makeCanaries(), installTimeoutMs: 1000, entryTimeoutMs: 1000, totalTimeoutMs: 1000, sandboxTimeoutMs: 1000, fakeRate: 30 });
  assert.equal(t.install, "timeout");
  assert.ok(t.checks.some((c) => c.name === "forensics_collected" && !c.ok));
  assert.equal(slow.killed, 1);
});

test("guest harness keeps the safety invariants", () => {
  const sh = readFileSync(join(ROOT, "sandbox/e2b/guest/cr-detonate.sh"), "utf8");
  assert.match(sh, /meta skuid \$CR_UID ip daddr != 127\.0\.0\.0\/8 meta l4proto tcp redirect to :8080/);
  assert.match(sh, /meta skuid \$CR_UID tcp dport \{ 49983, 8081 \} reject with tcp reset/, "envd and 8081 refused for uid 1001 on every address family");
  assert.match(sh, /meta skuid \$CR_UID meta nfproto ipv6 reject/, "uid 1001 has no IPv6 path past the accepted loopback forge ports");
  assert.match(sh, /meta skuid \$CR_UID meta l4proto udp counter drop comment "cr_udp_drop"/, "dropped UDP is counted, not silent");
  assert.match(sh, /meta skuid \$CR_UID meta l4proto != tcp counter drop comment "cr_other_drop"/);
  assert.match(sh, /for ENVD_ADDR in 127\.0\.0\.1 ::1; do/, "the containment probe checks envd over IPv4 and IPv6");
  assert.match(sh, /TRACE_SET=.*sendto,sendmsg,sendmmsg/);
  assert.match(sh, /-print0 2>\/dev\/null >"\$RUN\/written\.0"/, "written files are NUL-separated");
  assert.match(sh, /timeout 3 xargs -0 -r grep -l -s -D skip -F -f/, "the root canary grep is bounded and skips FIFOs and devices");
  assert.match(sh, /check forensics_truncated false/, "any size cut is reported");
  assert.doesNotMatch(sh, /truncate -s "<8M" "\$OUT\/\$f"/, "no silent head-only cut of the capture or traces");
  assert.match(sh, /check egress_contained false .*\n.*\n\s+exit 4/, "repo code never runs when the probe fails");
  assert.match(sh, /-u "\$CR_USER" -- \\\n\s+env -i "\$\{BASE_ENV\[@\]\}" bash -c "\$INSTALL_CMD"/, "install runs as uid 1001 under strace");
  assert.match(sh, /npm_config_dangerously_allow_all_scripts=true/);
  assert.match(sh, /FAKETIME="\+0 x\$FAKE_RATE"/);
  const policy = JSON.parse(readFileSync(join(ROOT, "sandbox/e2b/guest/policy.json"), "utf8"));
  assert.deepEqual(policy.registries.npm, ["registry.npmjs.org"]);
});

test("detonate: an overrun salvages the live forensic files, keeps their evidence, and marks coverage lost", async () => {
  const canaries = makeCanaries();
  const capture = { t: 1, phase: "install", proto: "https", host: "c2.example", port: 443, method: "POST", path: "/c", sni: "c2.example", req_headers: {}, req_bytes: 40, req_body_b64: Buffer.from(canaries.NPM_TOKEN).toString("base64"), forged_kind: "json", tls: "intercepted" };
  const partial = makeTgz([
    { name: "out/", type: "dir" },
    { name: "out/checks.jsonl", data: '{"name":"egress_contained","ok":true}\n' },
    { name: "out/capture.jsonl", data: JSON.stringify(capture) },
    { name: "out/trace.install", data: `9 1.0 openat(AT_FDCWD, "/home/cr/.aws/credentials", O_RDONLY) = 3\n` },
  ]);
  const s = new StubSession((cmd, self) => {
    if (cmd.includes("cr-detonate.sh") && !cmd.includes("pkill")) throw new Error("command deadline exceeded");
    assert.match(cmd, /pkill -KILL -f 'cr-detonat\[e\]\.sh'; pkill -KILL -u 1001; .*tar -czf \/root\/out\.partial\.tgz -C \/root out/);
    self.files.set(SALVAGE_ARCHIVE, partial);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const d = await detonate(new StubProvider(s), { runId: "r", mode: "npm-package", packageName: "evil", tarball: new Uint8Array(1), canaries, installTimeoutMs: 20_000, entryTimeoutMs: 4_000, totalTimeoutMs: 70_000, sandboxTimeoutMs: 95_000, fakeRate: 30 });
  assert.equal(s.commands.length, 2, "harness, then salvage");
  assert.equal(d.install, "timeout");
  assert.equal(d.entry, "skipped");
  assert.equal(d.forensics.coverage, "lost");
  assert.deepEqual(d.forgedCalls[0]!.canary_hits, ["NPM_TOKEN"], "salvaged evidence still reaches the score");
  assert.deepEqual(d.files.map((f) => f.op), ["read_decoy"]);
  assert.ok(d.checks.some((c) => c.name === "forensics_collected" && !c.ok && /salvaged/.test(c.detail ?? "")));
  assert.equal(s.killed, 1);
});

test("detonate: harness truncation and mirror metadata mark coverage partial", async () => {
  const result = { version: 1, mode: "repo", ecosystem: "npm", deps_kind: "npm-ls", install: { status: "completed", exit_code: 0, ms: 9, command: "npm ci" }, entry: { status: "completed", exit_code: 0, ms: 1 }, clock: { real_ms: 40, fake_ms: 1000 }, total_ms: 99 };
  const bundle = makeTgz([
    { name: "out/", type: "dir" },
    { name: "out/result.json", data: JSON.stringify(result) },
    { name: "out/checks.jsonl", data: '{"name":"forensics_truncated","ok":false,"detail":"trace.install 9000000 bytes"}\n' },
    { name: "out/capture.jsonl", data: "" },
  ]);
  const d = await detonate(new StubProvider(new StubSession((_c, self) => (self.files.set("/root/out.tgz", bundle), { exitCode: 0, stdout: "", stderr: "" }))), { runId: "r", mode: "repo", packageName: null, tarball: new Uint8Array(1), canaries: makeCanaries(), installTimeoutMs: 20_000, entryTimeoutMs: 4_000, totalTimeoutMs: 70_000, sandboxTimeoutMs: 95_000, fakeRate: 30 });
  assert.equal(d.forensics.coverage, "partial");
  assert.match(d.forensics.gaps.join(" "), /cut at the size cap/);
});
