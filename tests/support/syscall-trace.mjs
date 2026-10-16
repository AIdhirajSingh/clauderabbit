/**
 * Test-only preload (node --import) that stands in for strace when the mock
 * sandbox runs OUR fixture locally (macOS has no strace). It wraps the fs entry
 * points the fixtures use and appends one line per call to CR_TEST_TRACE in the
 * exact `strace -f -ttt` format the harness produces, with local paths mapped to
 * the VM layout through CR_TEST_PATH_MAP ({"<local prefix>": "<vm prefix>"}).
 * lib/engine/forensics/strace.ts then parses it like a real trace.
 */

import fs from "node:fs";
import path from "node:path";

const tracePath = process.env.CR_TEST_TRACE;
const map = JSON.parse(process.env.CR_TEST_PATH_MAP || "{}");
if (!tracePath) throw new Error("syscall-trace: CR_TEST_TRACE is required");

// One append-mode fd opened before any wrapping; writeSync is never wrapped.
const traceFd = fs.openSync(tracePath, "a");
let depth = 0;

function vmPath(p) {
  const abs = path.resolve(String(p));
  for (const [local, vm] of Object.entries(map)) {
    if (abs === local) return vm;
    if (abs.startsWith(local + path.sep)) return vm + abs.slice(local.length).split(path.sep).join("/");
  }
  return abs;
}

function line(call, args, ret) {
  fs.writeSync(traceFd, `${process.pid} ${(Date.now() / 1000).toFixed(6)} ${call}(${args}) = ${ret}\n`);
}

function wrap(name, flags) {
  const original = fs[name];
  fs[name] = function traced(file, ...rest) {
    let ret = 3;
    depth += 1;
    try {
      return original.call(fs, file, ...rest);
    } catch (err) {
      ret = "-1 ENOENT (No such file or directory)";
      throw err;
    } finally {
      depth -= 1;
      // appendFileSync calls writeFileSync internally: record only the outermost call.
      if (depth === 0 && (typeof file === "string" || file instanceof URL || Buffer.isBuffer(file))) {
        line("openat", `AT_FDCWD, ${JSON.stringify(vmPath(file instanceof URL ? file.pathname : file))}, ${flags}`, ret);
      }
    }
  };
}

wrap("readFileSync", "O_RDONLY|O_CLOEXEC");
wrap("writeFileSync", "O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0666");
wrap("appendFileSync", "O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC, 0666");
