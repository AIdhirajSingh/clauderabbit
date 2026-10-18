/**
 * POST /api/ops/smoke (lib/server/ops-smoke.ts): the guard (404 everywhere but a
 * Preview deployment with the operator key), the two VMs started together and
 * both killed, and the assertions over the guest output. The operator key here is
 * a placeholder for this process only.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { DELETE, GET, POST, maxDuration, runtime } from "../../app/api/ops/smoke/route.ts";
import type { CommandResult, RunOptions, SandboxCreateOptions, SandboxProvider, SandboxSession } from "../../lib/engine/sandbox/provider.ts";
import { FACTS_CMD, SMOKE_SCRIPT, handleOpsSmoke, memoryMatches, parseResources } from "../../lib/server/ops-smoke.ts";
import { templateContentTag, templateInputFiles } from "../../sandbox/e2b/content-tag.ts";

const KEY = "k".repeat(64);
const PREVIEW = { VERCEL_ENV: "preview", CR_OPERATOR_KEY: KEY, E2B_API_KEY: "placeholder-not-a-key" };

function post(key: string | null): Request {
  const headers = new Headers();
  if (key !== null) headers.set("x-cr-operator-key", key);
  return new Request("https://preview.example/api/ops/smoke", { method: "POST", headers });
}

const SMOKE_OK = [
  "cr: phase forge-up",
  "cr-smoke: ---- containment proof (inside the VM, before any repo code) ----",
  "PASS forge (mitmdump + forge_addon.py) runs as uid 0",
  "cr-proof: PASS",
  "cr-smoke: ---- end of proof ----",
  'cr-smoke: PASS {"install":{"status":"completed"}}',
].join("\n");

const ANALYSIS_STATUS = JSON.stringify({ semgrep: { exit: 0, ms: 900 }, yara: { exit: 0, ms: 300 }, "guarddog-npm": { exit: 0, ms: 1200 } });
const enc = new TextEncoder();

/** Plays both guest harnesses with scripted output and records VM lifetimes. */
class ScriptedProvider implements SandboxProvider {
  readonly template = "clauderabbit-detonate";
  readonly created: SandboxCreateOptions[] = [];
  readonly live = new Set<string>();
  readonly overlaps: string[] = [];
  readonly killed: string[] = [];
  readonly commands: string[] = [];
  readonly opts: { facts: string; smoke: CommandResult; publicUrls?: boolean };
  constructor(opts: { facts: string; smoke: CommandResult; publicUrls?: boolean }) {
    this.opts = opts;
  }

  async create(o: SandboxCreateOptions): Promise<SandboxSession> {
    this.created.push(o);
    this.live.add(o.purpose);
    const { live, overlaps, killed, commands, opts } = this;
    const files = new Map<string, Uint8Array>();
    const session: SandboxSession & { publicUrl?: (port: number) => string } = {
      id: `vm-${o.purpose}`,
      async writeFile() {},
      async readFile(path: string) {
        const f = files.get(path);
        if (!f) throw new Error(`missing ${path}`);
        return f;
      },
      async run(cmd: string, r: RunOptions): Promise<CommandResult> {
        assert.ok(r.timeoutMs > 0);
        commands.push(cmd);
        await new Promise((r) => setTimeout(r, 40));
        for (const p of live) if (p !== o.purpose) overlaps.push(`${o.purpose} saw ${p}`);
        if (o.purpose === "analyze") {
          files.set("/root/out/status.json", enc.encode(ANALYSIS_STATUS));
          files.set("/root/out/semgrep.json", enc.encode(JSON.stringify({ results: [{ check_id: "cr.js.env-to-network", path: "/work/src/install.js", start: { line: 5 }, extra: { severity: "WARNING", message: "env", lines: "x" } }], errors: [] })));
          files.set("/root/out/yara.json", enc.encode(JSON.stringify({ matches: [] })));
          files.set("/root/out/guarddog-npm.json", enc.encode(JSON.stringify({ issues: 0, results: {} })));
          return { exitCode: 0, stdout: "analysis complete", stderr: "" };
        }
        if (cmd === FACTS_CMD) return { exitCode: 0, stdout: opts.facts, stderr: "" };
        return opts.smoke;
      },
      async kill() {
        live.delete(o.purpose);
        killed.push(o.purpose);
      },
    };
    if (opts.publicUrls) session.publicUrl = (port: number) => `https://${port}-vm-${o.purpose}.e2b.test`;
    return session;
  }
}

const FACTS = "nproc=1\nMemTotal:        2014240 kB\nkernel=6.1.102\nsemgrep=1.181.0\nguarddog=3.2.0\nyara_x=1.21.0\n";

test("route: Node runtime, 300 s budget, every other method is 404", async () => {
  assert.equal(runtime, "nodejs");
  assert.equal(maxDuration, 300);
  assert.equal((await GET()).status, 404);
  assert.equal((await DELETE()).status, 404);
});

test("guard: production, local, missing key and wrong key all answer 404 without starting a VM", async () => {
  const cases: Array<[Record<string, string | undefined>, string | null]> = [
    [{ ...PREVIEW, VERCEL_ENV: "production" }, KEY],
    [{ ...PREVIEW, VERCEL_ENV: undefined }, KEY],
    [{ ...PREVIEW, VERCEL_ENV: "development" }, KEY],
    [PREVIEW, null],
    [PREVIEW, "k".repeat(63) + "j"],
    [PREVIEW, "short"],
    [{ ...PREVIEW, CR_OPERATOR_KEY: "too-short-to-count" }, "too-short-to-count"],
  ];
  for (const [env, key] of cases) {
    const p = new ScriptedProvider({ facts: FACTS, smoke: { exitCode: 0, stdout: SMOKE_OK, stderr: "" } });
    const res = await handleOpsSmoke(post(key), env, { provider: () => p });
    assert.equal(res.status, 404, JSON.stringify({ env: env.VERCEL_ENV, key: key?.length }));
    assert.equal(await res.text(), "Not Found");
    assert.equal(p.created.length, 0);
  }
  // The real route reads process.env, which in this test process has no VERCEL_ENV.
  assert.equal((await POST(post(KEY))).status, 404);
});

test("preview + key: detonation and analysis VMs start together, run the real scripts, and are both killed", async () => {
  const p = new ScriptedProvider({ facts: FACTS, smoke: { exitCode: 0, stdout: SMOKE_OK, stderr: "" } });
  const res = await handleOpsSmoke(post(KEY), PREVIEW, { provider: () => p, randomId: () => "t1" });
  const body = (await res.json()) as {
    ok: boolean;
    run_id: string;
    assertions: Array<{ name: string; ok: boolean; detail: string }>;
    resources: { nproc: number; mem_total_kb: number };
    timings: { overlap_ms: number };
    analysis: { complete: boolean; findings: Array<{ rule: string }> };
    detonation: { smoke: { stdout: string } };
  };
  assert.equal(res.status, 200, JSON.stringify(body.assertions));
  assert.equal(body.ok, true);
  assert.equal(body.run_id, "ops-smoke-t1");
  assert.deepEqual(p.created.map((c) => [c.purpose, c.network]).sort(), [["analyze", "none"], ["detonate", "registry-only"]]);
  assert.ok(p.commands.includes(`bash ${SMOKE_SCRIPT}`));
  assert.ok(p.commands.includes("bash /opt/cr/bin/cr-analyze.sh"));
  assert.ok(p.overlaps.includes("analyze saw detonate") && p.overlaps.includes("detonate saw analyze"), p.overlaps.join(","));
  assert.deepEqual(p.killed.sort(), ["analyze", "detonate"]);
  assert.equal(p.live.size, 0);
  assert.deepEqual(body.resources, { nproc: 1, mem_total_kb: 2014240 });
  assert.ok(body.timings.overlap_ms > 0);
  assert.equal(body.analysis.complete, true);
  assert.deepEqual(body.analysis.findings.map((f) => f.rule), ["cr.js.env-to-network"]);
  assert.ok(body.assertions.filter((a) => a.name === "sandbox_killed").length === 2);
});

test("a failed proof, a wrong VM size or a failed smoke turns the response into 500 with the evidence", async () => {
  const failing = [
    { facts: FACTS, smoke: { exitCode: 1, stdout: SMOKE_OK.replace("cr-proof: PASS", "cr-proof: FAIL"), stderr: "cr-smoke: FAIL containment proof failed" } },
    { facts: FACTS.replace("nproc=1", "nproc=2"), smoke: { exitCode: 0, stdout: SMOKE_OK, stderr: "" } },
    { facts: FACTS.replace("2014240", "4030000"), smoke: { exitCode: 0, stdout: SMOKE_OK, stderr: "" } },
  ];
  const expectFailed: string[] = ["containment_proof", "vcpu", "memory"];
  for (const [i, f] of failing.entries()) {
    const p = new ScriptedProvider(f);
    const res = await handleOpsSmoke(post(KEY), PREVIEW, { provider: () => p });
    const body = (await res.json()) as { ok: boolean; assertions: Array<{ name: string; ok: boolean }> };
    assert.equal(res.status, 500);
    assert.equal(body.ok, false);
    assert.ok(body.assertions.some((a) => a.name === expectFailed[i] && !a.ok), `want ${expectFailed[i]} failed`);
    assert.deepEqual(p.killed.sort(), ["analyze", "detonate"], "VMs are killed on failure too");
  }
});

test("resource parsing and the 2048 MB MemTotal window", () => {
  assert.deepEqual(parseResources(FACTS), { nproc: 1, mem_total_kb: 2014240 });
  assert.deepEqual(parseResources("garbage"), { nproc: null, mem_total_kb: null });
  assert.equal(memoryMatches(2014240), true);
  assert.equal(memoryMatches(2097152), true);
  assert.equal(memoryMatches(1700000), false);
  assert.equal(memoryMatches(4030000), false);
  assert.equal(memoryMatches(null), false);
});

test("template content tag: stable, covers guest scripts, rules and the VM size", () => {
  const a = templateContentTag();
  assert.match(a, /^c-[0-9a-f]{16}$/);
  assert.equal(templateContentTag(), a);
  const files = templateInputFiles().map((f) => f.split("/sandbox/e2b/").pop() ?? f);
  for (const want of ["guest/cr-detonate.sh", "guest/cr-proof.sh", "guest/cr-smoke.sh", "guest/forge_core.py", "rules/semgrep/js-install-malware.yaml", "rules/yara/credential-theft.yar", "template.ts", "mirror-seed.json"]) {
    assert.ok(files.includes(want), `missing ${want}`);
  }
  assert.ok(templateInputFiles().some((f) => f.endsWith("lib/engine/sandbox/resources.ts")));
  assert.ok(!templateInputFiles().some((f) => f.includes("__pycache__")));
});

test("vercel-build hook never builds outside Preview and never needs the key there", () => {
  const run = (env: Record<string, string>) =>
    execFileSync(process.execPath, ["sandbox/e2b/build.ts", "--vercel-hook"], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  assert.match(run({ VERCEL_ENV: "production", E2B_API_KEY: "placeholder-not-a-key" }), /skip: VERCEL_ENV=production/);
  assert.match(run({}), /skip: VERCEL_ENV=unset/);
  assert.match(run({ VERCEL_ENV: "preview" }), /skip: E2B_API_KEY is not set/);
});

test("public port probe: a proxy refusal passes, an open port or no answer fails", async () => {
  const cases: Array<[() => Promise<Response>, boolean]> = [
    [async () => new Response("forbidden", { status: 403 }), true],
    [async () => new Response('{"ok":true}', { status: 200 }), false],
    [async () => { throw new Error("getaddrinfo ENOTFOUND"); }, false],
  ];
  for (const [respond, closed] of cases) {
    const seen: string[] = [];
    const p = new ScriptedProvider({ facts: FACTS, smoke: { exitCode: 0, stdout: SMOKE_OK, stderr: "" }, publicUrls: true });
    const fakeFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return respond();
    }) as typeof fetch;
    const res = await handleOpsSmoke(post(KEY), PREVIEW, { provider: () => p, fetch: fakeFetch });
    const body = (await res.json()) as { ok: boolean; assertions: Array<{ name: string; ok: boolean }> };
    assert.deepEqual(seen, ["https://8080-vm-detonate.e2b.test/cr-ops-public-probe"]);
    assert.equal(body.assertions.find((a) => a.name === "public_port_closed")?.ok, closed);
    assert.equal(body.ok, closed);
  }
});
