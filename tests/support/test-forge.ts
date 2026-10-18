/**
 * Test-only forge: starts tests/support/test_forge_server.py, which serves
 * HTTPS and DNS through the production forge policy (sandbox/e2b/guest/
 * forge_core.py honoring policy.json) and writes the same capture.jsonl
 * format. A throwaway CA and a leaf for *.cr-fixture.invalid are minted with
 * the local openssl for each forge instance.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ROOT = join(import.meta.dirname, "..", "..");
export const POLICY_PATH = join(ROOT, "sandbox", "e2b", "guest", "policy.json");
const SERVER = join(import.meta.dirname, "test_forge_server.py");

export interface TestForge {
  httpsPort: number;
  dnsPort: number;
  caPath: string;
  capturePath: string;
  phasePath: string;
  setPhase(phase: "probe" | "install" | "entry" | "collect"): void;
  stop(): Promise<void>;
}

function mintCerts(dir: string): { ca: string; cert: string; key: string } {
  const ca = join(dir, "ca.pem");
  const caKey = join(dir, "ca.key");
  const key = join(dir, "leaf.key");
  const csr = join(dir, "leaf.csr");
  const cert = join(dir, "leaf.pem");
  const ext = join(dir, "leaf.ext");
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  execFileSync("openssl", ["req", "-x509", ...ec, "-days", "2", "-subj", "/CN=ClaudeRabbit Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", caKey, "-out", ca], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", ...ec, "-subj", "/CN=c2.cr-fixture.invalid", "-keyout", key, "-out", csr], { stdio: "ignore" });
  writeFileSync(ext, "subjectAltName=DNS:*.cr-fixture.invalid,DNS:cr-fixture.invalid\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "2", "-out", cert, "-extfile", ext], { stdio: "ignore" });
  return { ca, cert, key };
}

export async function startTestForge(dir: string): Promise<TestForge> {
  mkdirSync(join(dir, "mirror"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });
  const capturePath = join(dir, "out", "capture.jsonl");
  const phasePath = join(dir, "out", "phase");
  writeFileSync(capturePath, "");
  writeFileSync(phasePath, "probe 0\n");
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Record<string, unknown>;
  const testPolicy = { ...policy, capture_path: capturePath, phase_path: phasePath, mirror_root: join(dir, "mirror") };
  const policyPath = join(dir, "policy.json");
  writeFileSync(policyPath, JSON.stringify(testPolicy));
  const { ca, cert, key } = mintCerts(dir);
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-I", SERVER, policyPath, cert, key], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const first = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error(`test forge did not start: ${stderr}`)), 10_000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      rl.close();
      resolve(line);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`test forge exited ${code}: ${stderr}`));
    });
  });
  const ports = JSON.parse(first) as { https: number; dns: number };
  let stopped: Promise<void> | null = null;
  return {
    httpsPort: ports.https,
    dnsPort: ports.dns,
    caPath: ca,
    capturePath,
    phasePath,
    setPhase(phase) {
      writeFileSync(phasePath, `${phase} ${Date.now() / 1000}\n`);
    },
    stop() {
      // Idempotent: a second stop() must not wait for an "exit" that already fired. A child
      // killed by SIGKILL has exitCode null and signalCode set, so checking exitCode alone
      // left the mock harness's second stop() (in its finally) waiting forever under load.
      if (!stopped) {
        stopped = child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((r) => {
              child.once("exit", () => r());
              child.stdin.end();
              const t = setTimeout(() => child.kill("SIGKILL"), 2000);
              child.once("exit", () => clearTimeout(t));
            });
      }
      return stopped;
    },
  };
}
