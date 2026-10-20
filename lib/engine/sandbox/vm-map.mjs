// Runs inside the detonation VM as root, after the repo tarball was fetched and the
// fence re-proven, before any repo code runs. It reads files only. Over the whole
// extracted repo it runs the engine's own reach graph and static heuristics (graph.ts,
// heuristics.ts and archive.ts are uploaded next to this file and run by Node 24's
// type stripping), and writes:
//   <out.json>  stats, the reach class of every path, the graph's install surface and
//               the heuristic findings and capabilities of the whole repo;
//   <list>      the small view the models read (NUL-separated): manifests, lockfiles,
//               READMEs, the install surface and the files with findings, within a
//               byte budget. Every scored fact comes from the whole repo; only the
//               slice Jev and Luna read is bounded.
//
//   node vm-map.mjs <extracted root> <list out> <json out>
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReachGraph } from "./graph.ts";
import { runHeuristics } from "./heuristics.ts";

const [root, listOut, jsonOut] = process.argv.slice(2);
const VIEW_BUDGET = 16 * 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;
const KEEP = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|uv\.lock|poetry\.lock|readme[^/]*|license[^/]*)$/i;

function isBinary(abs) {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

const files = new Map();
const binary = new Set();
const big = [];
let count = 0;
let bytes = 0;
let links = 0;
const walk = (dir, rel) => {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      links++;
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, r);
      continue;
    }
    if (!st.isFile()) continue;
    count++;
    bytes += st.size;
    if (isBinary(abs)) {
      binary.add(r);
      files.set(r, new Uint8Array(0));
    } else if (st.size > MAX_TEXT) {
      big.push(r);
      files.set(r, new Uint8Array(0));
    } else {
      files.set(r, readFileSync(abs));
    }
  }
};
walk(root, "");

const g = buildReachGraph(files);
const heur = runHeuristics(files);
const reach = { install: 0, import: 0, unreachable: 0 };
const classes = {};
for (const p of files.keys()) {
  const c = g.classify(p);
  reach[c]++;
  if (c !== "unreachable") classes[p] = c === "install" ? 1 : 2;
}
const isText = (p) => !binary.has(p) && (files.get(p)?.length ?? 0) > 0;
const wanted = [];
const seen = new Set();
const want = (p) => {
  if (!seen.has(p) && files.has(p) && isText(p)) {
    seen.add(p);
    wanted.push(p);
  }
};
for (const p of files.keys()) if (KEEP.test(p.split("/").pop() ?? "") && !p.includes("node_modules/")) want(p);
for (const p of g.install) want(p);
for (const e of g.entries) want(e.path);
const order = (p) => (g.classify(p) === "install" ? 0 : g.classify(p) === "import" ? 1 : 2);
const findingFiles = [...new Set(heur.findings.map((f) => f.file))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
const capFiles = [...new Set(heur.capabilities.map((c) => c.file))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
for (const p of findingFiles) want(p);
for (const p of capFiles) want(p);
const view = [];
let viewBytes = 0;
let overBudget = 0;
for (const p of wanted) {
  const n = files.get(p).length;
  if (viewBytes + n > VIEW_BUDGET && view.length > 0) {
    overBudget++;
    continue;
  }
  view.push(p);
  viewBytes += n;
}
writeFileSync(listOut, view.map((p) => `${p}\0`).join(""));
const bigReachable = big.filter((p) => g.classify(p) !== "unreachable");
writeFileSync(
  jsonOut,
  JSON.stringify({
    stats: {
      files: count,
      bytes,
      binary: binary.size,
      links,
      big_reachable: bigReachable.slice(0, 20),
      big_reachable_count: bigReachable.length,
      reach,
      unbounded: g.unbounded,
      ecosystems: g.ecosystems,
      view_files: view.length,
      view_bytes: viewBytes,
      view_over_budget: overBudget,
      heuristic_findings: heur.findings.length,
      capabilities: heur.capabilities.length,
    },
    graph: {
      install: [...g.install],
      import: [...g.import],
      entries: g.entries,
      inlineInstallCommands: g.inlineInstallCommands,
      unbounded: g.unbounded,
      unboundedFrom: g.unboundedFrom,
      ecosystems: g.ecosystems,
      classes,
    },
    heur,
  }),
);
