/**
 * Test-only SandboxProvider. It plays the guest harness for OUR fixtures only
 * (tests/fixtures/*) so a full scan runs with no E2B key:
 *
 *  - detonation: the same per-run inputs the real harness gets (/root/in/*,
 *    /root/.cr/canary.env, canary-patterns.txt) drive a local run of the
 *    fixture's lifecycle scripts and entry point. Network goes through the test
 *    forge (production forge_core.py policy, real TLS interception with a
 *    throwaway CA, DNS answered by the forge), the phase file moves
 *    probe -> install -> entry -> collect, and the result is packed into the same
 *    /root/out.tgz bundle (result.json, checks.jsonl, capture.jsonl,
 *    trace.install, trace.entry in strace -f -ttt format, deps.json,
 *    written.txt, canary_files.txt), so the production parsers in
 *    lib/engine/sandbox/detonate.ts and lib/engine/forensics/* read it unchanged.
 *  - analysis: canned empty Semgrep, GuardDog and YARA output in each tool's
 *    real JSON shape (the in-process heuristics still run on the real files).
 *
 * Never imported by production code.
 */

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandResult, RunOptions, SandboxCreateOptions, SandboxProvider, SandboxSession } from "../../lib/engine/sandbox/provider.ts";
import { makeTgz } from "./tar.ts";
import { startTestForge, type TestForge } from "./test-forge.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const REDIRECT = join(import.meta.dirname, "forge-redirect.mjs");
const SYSCALLS = join(import.meta.dirname, "syscall-trace.mjs");

export interface MockRunRecord {
  purpose: SandboxCreateOptions["purpose"];
  network: SandboxCreateOptions["network"];
  workDir: string;
  packageDir: string | null;
}

export class MockSandboxProvider implements SandboxProvider {
  readonly template = "mock-clauderabbit-detonate";
  readonly sessions: MockSession[] = [];
  #root: string;

  constructor(tmpRoot: string) {
    this.#root = tmpRoot;
  }

  async create(opts: SandboxCreateOptions): Promise<SandboxSession> {
    const dir = join(this.#root, `${opts.purpose}-${this.sessions.length + 1}`);
    mkdirSync(dir, { recursive: true });
    const s = new MockSession(`mock-${opts.purpose}-${this.sessions.length + 1}`, opts, dir);
    this.sessions.push(s);
    return s;
  }
}

function q(s: string): string {
  return JSON.stringify(s);
}

function ts(): string {
  return (Date.now() / 1000).toFixed(6);
}

interface Proc {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  pid: number;
  timedOut: boolean;
}

function runProc(cmd: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<Proc> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, stdout, stderr, pid: child.pid ?? 0, timedOut });
    });
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

export class MockSession implements SandboxSession {
  readonly id: string;
  readonly opts: SandboxCreateOptions;
  readonly files = new Map<string, Uint8Array>();
  /** Every command run, in order. */
  readonly commands: string[] = [];
  readonly dir: string;
  killed = false;
  record: MockRunRecord;

  constructor(id: string, opts: SandboxCreateOptions, dir: string) {
    this.id = id;
    this.opts = opts;
    this.dir = dir;
    this.record = { purpose: opts.purpose, network: opts.network, workDir: join(dir, "work"), packageDir: null };
  }

  #alive() {
    if (this.killed) throw new Error(`sandbox ${this.id} was killed`);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.#alive();
    this.files.set(path, typeof data === "string" ? enc.encode(data) : data);
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.#alive();
    const v = this.files.get(path);
    if (!v) throw new Error(`ENOENT ${path}`);
    return v;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  async run(cmd: string, opts: RunOptions): Promise<CommandResult> {
    this.#alive();
    this.commands.push(cmd);
    if (this.opts.purpose === "detonate" && cmd.includes("/opt/cr/bin/cr-detonate.sh")) return this.#detonate(opts);
    if (this.opts.purpose === "analyze" && cmd.includes("/opt/cr/bin/cr-analyze.sh")) return this.#analyze();
    return { exitCode: 127, stdout: "", stderr: `mock sandbox: unsupported command ${cmd}` };
  }

  async #analyze(): Promise<CommandResult> {
    const cfg = JSON.parse(dec.decode(this.files.get("/root/in/analyze.json")!)) as { ecosystems: string[] };
    if (!this.files.has("/root/in/src.tgz")) return { exitCode: 2, stdout: "", stderr: "no src.tgz" };
    const status: Record<string, { exit: number; ms: number }> = { semgrep: { exit: 0, ms: 1 }, yara: { exit: 0, ms: 1 } };
    this.files.set("/root/out/semgrep.json", enc.encode(JSON.stringify({ results: [], errors: [] })));
    this.files.set("/root/out/yara.json", enc.encode(JSON.stringify({ matches: [], errors: [] })));
    if (cfg.ecosystems.includes("npm")) {
      this.files.set("/root/out/guarddog-npm.json", enc.encode(JSON.stringify({ results: {}, errors: {} })));
      status["guarddog-npm"] = { exit: 0, ms: 1 };
    }
    if (cfg.ecosystems.includes("python")) {
      this.files.set("/root/out/guarddog-pypi.json", enc.encode(JSON.stringify({ results: {}, errors: {} })));
      status["guarddog-pypi"] = { exit: 0, ms: 1 };
    }
    this.files.set("/root/out/status.json", enc.encode(JSON.stringify(status)));
    return { exitCode: 0, stdout: `analysis complete: ${JSON.stringify(status)}`, stderr: "" };
  }

  async #detonate(opts: RunOptions): Promise<CommandResult> {
    const log = (s: string) => opts.onStdout?.(`cr: ${s}\n`);
    // Like cr-detonate.sh: started at boot, it waits for the go file, written after every input.
    const waitUntil = Date.now() + Math.min(opts.timeoutMs, 60_000);
    while (!this.files.has("/root/in/go")) {
      if (this.killed) return { exitCode: 137, stdout: "", stderr: "killed while waiting for inputs" };
      if (Date.now() > waitUntil) return { exitCode: 5, stdout: "", stderr: "inputs did not arrive" };
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const f of ["/root/in/target.tgz", "/root/in/run.json", "/root/.cr/canary.env", "/root/.cr/canary-patterns.txt"]) {
      if (!this.files.has(f)) return { exitCode: 2, stdout: "", stderr: `missing input ${f}` };
    }
    const run = JSON.parse(dec.decode(this.files.get("/root/in/run.json")!)) as {
      mode: "npm-package" | "repo";
      name: string | null;
      install_timeout_s: number;
      entry_timeout_s: number;
    };
    const canaryEnv: Record<string, string> = {};
    for (const line of dec.decode(this.files.get("/root/.cr/canary.env")!).split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) canaryEnv[line.slice(0, i)] = line.slice(i + 1);
    }
    const patterns = dec.decode(this.files.get("/root/.cr/canary-patterns.txt")!).split("\n").filter(Boolean);
    const work = this.record.workDir;
    const home = join(this.dir, "home");
    const src = join(this.dir, "pkgsrc");
    mkdirSync(work, { recursive: true });
    mkdirSync(src, { recursive: true });
    for (const d of [".ssh", ".aws", ".config/gh", ".docker"]) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, ".aws", "credentials"), `[default]\naws_access_key_id = ${canaryEnv.AWS_ACCESS_KEY_ID}\naws_secret_access_key = ${canaryEnv.AWS_SECRET_ACCESS_KEY}\n`);
    writeFileSync(join(home, ".npmrc"), `//registry.npmjs.org/:_authToken=${canaryEnv.NPM_TOKEN}\n`);
    writeFileSync(join(src, "target.tgz"), this.files.get("/root/in/target.tgz")!);
    execFileSync("tar", ["-xzf", join(src, "target.tgz"), "-C", src]);

    const checks: string[] = [];
    const check = (name: string, ok: boolean, detail: string) => checks.push(JSON.stringify({ name, ok, detail }));
    const forge: TestForge = await startTestForge(join(this.dir, "forge"));
    const out = join(this.dir, "forge", "out");
    const traces: Record<"install" | "entry", string[]> = { install: [], entry: [] };
    const pathMap = JSON.stringify({ [work]: "/work", [home]: "/home/cr" });
    const rawTrace = (phase: string) => join(this.dir, `trace.${phase}.raw`);
    const env = (phase: "probe" | "install" | "entry", extra: Record<string, string> = {}): Record<string, string> => ({
      HOME: home,
      USER: "cr",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      NODE_OPTIONS: `--import ${pathToFileURL(REDIRECT).href} --import ${pathToFileURL(SYSCALLS).href}`,
      CR_TEST_TRACE: rawTrace(phase),
      CR_TEST_PATH_MAP: pathMap,
      NODE_EXTRA_CA_CERTS: forge.caPath,
      CR_TEST_FORGE_PORT: String(forge.httpsPort),
      CR_TEST_DNS_PORT: String(forge.dnsPort),
      ...canaryEnv,
      ...extra,
    });

    try {
      log("phase forge-up");
      check("forge_up", true, `test forge on 127.0.0.1:${forge.httpsPort}`);
      // Containment probe, recorded in the probe phase and then rotated out like the harness does.
      forge.setPhase("probe");
      const probe = await runProc(
        process.execPath,
        ["-e", "require('https').get('https://probe.cr-fixture.invalid/cr-probe',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>process.stdout.write(b))}).on('error',e=>process.stdout.write('error '+e.message))"],
        work,
        env("probe", { AWS_SECRET_ACCESS_KEY: "", AWS_ACCESS_KEY_ID: "", NPM_TOKEN: "", GITHUB_TOKEN: "", OPENAI_API_KEY: "" }),
        8000,
      );
      await new Promise((r) => setTimeout(r, 50));
      renameSync(forge.capturePath, join(out, "capture.probe.jsonl"));
      writeFileSync(forge.capturePath, "");
      const probeSeen = readFileSync(join(out, "capture.probe.jsonl"), "utf8").includes("probe.cr-fixture.invalid");
      if (probe.stdout !== '{"ok":true}' || !probeSeen) {
        check("egress_contained", false, `https=${probe.stdout.slice(0, 80)} captured=${probeSeen}`);
        return { exitCode: 4, stdout: "", stderr: "containment probe failed" };
      }
      check("egress_contained", true, "https forged and captured by the test forge");

      let pkgDir: string;
      let cwd: string;
      if (run.mode === "npm-package") {
        if (!run.name) throw new Error("npm-package mode needs a name");
        cwd = join(work, "app");
        pkgDir = join(cwd, "node_modules", run.name);
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(cwd, "package.json"), '{"name":"cr-run-app","version":"1.0.0","private":true}\n');
        cpSync(join(src, "package"), pkgDir, { recursive: true });
      } else {
        cwd = join(work, "src");
        const top = readdirSync(src).find((n) => n !== "target.tgz")!;
        cpSync(join(src, top), cwd, { recursive: true });
        pkgDir = cwd;
      }
      this.record.packageDir = pkgDir;
      const vm = (p: string) => "/work/" + relative(work, p).split("\\").join("/");
      const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { scripts?: Record<string, string>; version?: string };
      const marker = Date.now();

      log("phase install (npm)");
      forge.setPhase("install");
      const t0 = Date.now();
      let installStatus: "completed" | "failed" | "timeout" = "completed";
      let installOut = "";
      let installErr = "";
      for (const hook of ["preinstall", "install", "postinstall"]) {
        const script = manifest.scripts?.[hook];
        if (!script) continue;
        const p = await runProc("/bin/sh", ["-c", script], pkgDir, env("install", { npm_lifecycle_event: hook }), run.install_timeout_s * 1000);
        traces.install.push(`${p.pid} ${ts()} chdir(${q(vm(pkgDir))}) = 0`);
        traces.install.push(`${p.pid} ${ts()} execve("/bin/sh", ["sh", "-c", ${q(script)}], 0x7ffc0000 /* 30 vars */) = 0`);
        const argv = script.trim().split(/\s+/);
        if (/^[\w./@-]+(\s+[\w./@=-]+)*$/.test(script.trim())) {
          traces.install.push(`${p.pid} ${ts()} execve(${q(argv[0] === "node" ? "/usr/local/bin/node" : argv[0]!)}, [${argv.map(q).join(", ")}], 0x7ffc0000 /* 30 vars */) = 0`);
        }
        traces.install.push(`${p.pid} ${ts()} +++ exited with ${p.code ?? 137} +++`);
        installOut += p.stdout;
        installErr += p.stderr;
        if (p.timedOut) {
          installStatus = "timeout";
          break;
        }
        if (p.code !== 0) {
          installStatus = "failed";
          break;
        }
      }
      const installMs = Date.now() - t0;
      log(`install ${installStatus} ms=${installMs}`);

      let entryStatus: "completed" | "failed" | "timeout" | "skipped" = "skipped";
      let entryOut = "";
      let entryErr = "";
      let entryMs = 0;
      if (installStatus === "completed") {
        log("phase entry");
        forge.setPhase("entry");
        check("clock_accelerated", false, "mock sandbox runs without libfaketime");
        const req = run.mode === "npm-package" ? run.name! : cwd;
        const e0 = Date.now();
        const p = await runProc(process.execPath, ["-e", `require(${q(req)})`], cwd, env("entry"), run.entry_timeout_s * 1000);
        entryMs = Date.now() - e0;
        traces.entry.push(`${p.pid} ${ts()} execve("/usr/local/bin/node", ["node", "-e", ${q(`require('${req}')`)}], 0x7ffc0000 /* 30 vars */) = 0`);
        traces.entry.push(`${p.pid} ${ts()} +++ exited with ${p.code ?? 137} +++`);
        entryOut = p.stdout;
        entryErr = p.stderr;
        entryStatus = p.timedOut ? "timeout" : p.code === 0 ? "completed" : "failed";
        log(`entry ${entryStatus} ms=${entryMs}`);
      }
      forge.setPhase("collect");
      await new Promise((r) => setTimeout(r, 50));
      for (const phase of ["install", "entry"] as const) {
        if (existsSync(rawTrace(phase))) traces[phase].push(...readFileSync(rawTrace(phase), "utf8").split("\n").filter(Boolean));
      }

      const written = walk(work).filter((f) => statSync(f).mtimeMs >= marker);
      const canaryFiles = written.filter((f) => {
        const text = readFileSync(f).subarray(0, 1024 * 1024).toString("latin1");
        return patterns.some((p) => text.includes(p));
      });
      const deps = run.mode === "npm-package" ? { name: "cr-run-app", version: "1.0.0", dependencies: { [run.name!]: { version: manifest.version ?? "0.0.0" } } } : { name: "repo", dependencies: {} };
      const result = {
        version: 1,
        mode: run.mode,
        ecosystem: "npm",
        deps_kind: "npm-ls",
        install: { status: installStatus, exit_code: installStatus === "completed" ? 0 : 1, ms: installMs, command: run.mode === "npm-package" ? "npm install --no-audit --no-fund /work/pkg.tgz" : "npm install --no-audit --no-fund" },
        entry: { status: entryStatus, exit_code: entryStatus === "completed" ? 0 : entryStatus === "skipped" ? null : 1, ms: entryMs },
        clock: { real_ms: 0, fake_ms: 0 },
        total_ms: Date.now() - t0,
      };
      await forge.stop();
      const bundle = makeTgz([
        { name: "out/", type: "dir" },
        { name: "out/result.json", data: JSON.stringify(result) },
        { name: "out/checks.jsonl", data: checks.join("\n") + "\n" },
        { name: "out/capture.jsonl", data: readFileSync(forge.capturePath) },
        { name: "out/capture.probe.jsonl", data: readFileSync(join(out, "capture.probe.jsonl")) },
        { name: "out/trace.install", data: traces.install.join("\n") + "\n" },
        { name: "out/trace.entry", data: traces.entry.join("\n") + "\n" },
        { name: "out/deps.json", data: JSON.stringify(deps) },
        { name: "out/written.txt", data: written.map(vm).join("\n") + "\n" },
        { name: "out/canary_files.txt", data: canaryFiles.map(vm).join("\n") },
        { name: "out/install.out", data: installOut },
        { name: "out/install.err", data: installErr },
        { name: "out/entry.out", data: entryOut },
        { name: "out/entry.err", data: entryErr },
      ]);
      this.files.set("/root/out.tgz", bundle);
      log(`done {"install":"${installStatus}","entry":"${entryStatus}"}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    } finally {
      await forge.stop();
    }
  }
}
