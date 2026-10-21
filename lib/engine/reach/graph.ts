/**
 * Reachability graph of the code that runs at install or at import
 * (DESIGN.md section 5.2).
 *
 * Entries
 *   install: npm `preinstall`/`install`/`postinstall`/`preprepare`/`prepare`/
 *     `postprepare` scripts (the files they name via node/sh/bash/python),
 *     `binding.gyp` (node-gyp runs on install) and its listed sources; Python
 *     `setup.py`, an in-tree build backend (`backend-path`), every `*.pth` file.
 *   import: npm `main`, `module`, every `exports` target, `bin`, the default
 *     `index.js`; Python top-level package `__init__.py`, declared `py_modules`
 *     and console-script modules.
 * Edges: string-literal `require`, `import`, `import()`, `export ... from`;
 * Python `import x`, `from x import y`, relative imports. Resolution happens
 * inside the archive only (plus a bundled root `node_modules/`).
 *
 * A non-literal `require(...)`/`import(...)`/`importlib.import_module(...)`/
 * `__import__(...)` in a reachable file makes the set `unbounded`: then every
 * file except test/docs/example/infra paths counts as reachable.
 */

import { textOf } from "../archive";

export type Reach = "install" | "import" | "unreachable";

export interface ReachEntry {
  path: string;
  kind: "install" | "import";
  why: string;
}

export interface ReachGraph {
  install: Set<string>;
  import: Set<string>;
  entries: ReachEntry[];
  /** Install-surface commands that name no file in the archive (e.g. `curl ... | sh`). */
  inlineInstallCommands: Array<{ hook: string; command: string }>;
  unbounded: boolean;
  /** Files whose non-literal require/import made the set unbounded. */
  unboundedFrom: string[];
  ecosystems: Array<"npm" | "python">;
  /** The install plan for a JS workspace (null when the repo is not a workspace). */
  workspace?: WorkspacePlan | null;
  classify(path: string): Reach;
}

/**
 * Install only what runs. A JS workspace (package.json `workspaces` or
 * pnpm-workspace.yaml) installs the root package, the workspace packages the root's
 * dependencies and install scripts name, every workspace package with its own install
 * hook, and the workspace packages those depend on. Never the whole workspace.
 */
export interface WorkspacePlan {
  /** The root package's name, or null when it has none. */
  root: string | null;
  /** Names of the workspace packages to install with the root, sorted. */
  selected: string[];
  /** Directories of the selected packages. */
  selectedDirs: string[];
  /** Directories of every workspace package. */
  allDirs: string[];
  /** Workspace packages in the repo. */
  total: number;
}

const INSTALL_HOOK_NAMES = ["preinstall", "install", "postinstall"];

function globToRe(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const re = g
    .split("/")
    .map((seg) => (seg === "**" ? "(?:[^/]+/)*?[^/]*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/");
  return new RegExp(`^${re}$`);
}

/** The workspace install plan from the manifests alone; null when the repo is not a JS workspace. */
export function planWorkspace(files: Map<string, Uint8Array>, read: (p: string) => string | null): WorkspacePlan | null {
  let root: { name?: string; workspaces?: string[] | { packages?: string[] }; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; scripts?: Record<string, string> } | null = null;
  try {
    root = JSON.parse(read("package.json") ?? "");
  } catch {
    return null;
  }
  if (!root || typeof root !== "object") return null;
  let patterns: string[] = Array.isArray(root.workspaces) ? root.workspaces : Array.isArray(root.workspaces?.packages) ? root.workspaces!.packages! : [];
  const pnpmWs = read("pnpm-workspace.yaml");
  if (pnpmWs) {
    const block = pnpmWs.split(/\n(?=\S)/).find((b) => /^packages\s*:/.test(b)) ?? "";
    for (const line of block.split("\n").slice(1)) {
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
      if (m?.[1] && !m[1].startsWith("!")) patterns.push(m[1]);
    }
  }
  patterns = patterns.filter((x) => typeof x === "string" && !x.startsWith("!"));
  if (patterns.length === 0) return null;
  const res = patterns.map(globToRe);
  type Pkg = { name: string; dir: string; deps: string[]; hasHook: boolean };
  const pkgs = new Map<string, Pkg>();
  for (const path of files.keys()) {
    if (!path.endsWith("/package.json") || path.includes("node_modules/")) continue;
    const dir = path.slice(0, -"/package.json".length);
    if (!res.some((r) => r.test(dir))) continue;
    try {
      const pj = JSON.parse(read(path) ?? "") as { name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; scripts?: Record<string, string> };
      if (typeof pj.name !== "string" || !pj.name) continue;
      const deps = Object.keys({ ...pj.dependencies, ...pj.optionalDependencies, ...pj.peerDependencies });
      const hasHook = INSTALL_HOOK_NAMES.some((h) => typeof pj.scripts?.[h] === "string" && pj.scripts[h]!.trim() !== "");
      pkgs.set(pj.name, { name: pj.name, dir, deps, hasHook });
    } catch {
      continue;
    }
  }
  if (pkgs.size === 0) return null;
  const rootDeps = Object.keys({ ...root.dependencies, ...root.optionalDependencies });
  const rootScripts = INSTALL_HOOK_NAMES.concat(["prepare"]).map((h) => root!.scripts?.[h] ?? "").join("\n");
  const want = new Set<string>();
  for (const d of rootDeps) if (pkgs.has(d)) want.add(d);
  for (const p of pkgs.values()) {
    if (p.hasHook) want.add(p.name);
    // Whole names and paths only: a short package name ("ui", "docs") must not match
    // inside other words of the script.
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/@-]/g, "\\$&");
    const named = (x: string) => new RegExp(`(^|[\\s'"=:,(])(?:\\./)?${esc(x)}(?=$|[\\s'"/,;:)\\]&|.]|\\.\\.\\.)`).test(rootScripts);
    if (rootScripts && (named(p.name) || named(p.dir))) want.add(p.name);
  }
  const queue = [...want];
  while (queue.length) {
    const p = pkgs.get(queue.pop()!);
    for (const d of p?.deps ?? []) if (pkgs.has(d) && !want.has(d)) {
      want.add(d);
      queue.push(d);
    }
  }
  const selected = [...want].sort();
  return {
    root: typeof root.name === "string" && root.name ? root.name : null,
    selected,
    selectedDirs: selected.map((n) => pkgs.get(n)!.dir).sort(),
    allDirs: [...pkgs.values()].map((p) => p.dir).sort(),
    total: pkgs.size,
  };
}

const JS_EXT = [".js", ".mjs", ".cjs", ".json", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".node"];
const JS_CODE_RE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const NPM_INSTALL_HOOKS = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
const PY_ROOTS = ["", "src"];
/** Root manifests the package manager itself processes during install. */
const INSTALL_MANIFESTS = new Set(["package.json", "setup.py", "setup.cfg", "pyproject.toml", "binding.gyp"]);

/** Files an installer or entry point in the scan VM can execute. */
const RUNNABLE_RE = /\.(?:[cm]?[jt]s|[jt]sx|json|node|sh|bash|py|pyw|pth)$/i;
const NATIVE_SRC_RE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|gyp|gypi)$/i;

const UNREACHABLE_DIR_RE =
  /(^|\/)(tests?|__tests__|__mocks__|mocks?|specs?|e2e|docs?|examples?|benchmarks?|fixtures?|\.github|terraform|k8s)\//i;

/** Test code: test, spec, fixture, mock and example trees and *.test.* / *.spec.* files. */
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|__mocks__|mocks?|specs?|e2e|examples?|fixtures?)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/i;

/**
 * Test code is never reachable from install or the entry point by inference. Only a
 * file an install hook or the entry names directly (the explicit install/import
 * sets) keeps its reach: an install script that runs `node test/setup.js` is real
 * install-time code.
 */
export function isTestPath(path: string): boolean {
  return TEST_DIR_RE.test(path) || TEST_FILE_RE.test(path);
}

/** Paths that never count as reachable in the unbounded case (section 5.2). */
export function isUnreachablePath(path: string): boolean {
  if (UNREACHABLE_DIR_RE.test(path) || TEST_FILE_RE.test(path)) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^Dockerfile/i.test(base)) return true;
  if (/\.(md|markdown|mdx|rst)$/i.test(base)) return true;
  return false;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function join(dir: string, rel: string): string | null {
  const stack = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(seg);
  }
  return stack.join("/");
}

/** Remove block comments and whole-line `//` comments (strings are left alone). */
function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
}

export interface JsSpecifiers {
  literal: string[];
  nonLiteral: boolean;
}

/** Extract module specifiers from JS/TS source. */
export function jsSpecifiers(source: string): JsSpecifiers {
  const src = stripJsComments(source);
  const literal = new Set<string>();
  let nonLiteral = false;
  const callRe = /(?<![\w$.])(require|import)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 512);
    const lit = /^\s*(['"`])([^'"`\n]*)\1\s*[),]/.exec(rest);
    if (lit && !(lit[1] === "`" && lit[2]!.includes("${"))) literal.add(lit[2]!);
    else nonLiteral = true;
  }
  const staticRe = /(?:^|[;\n}])\s*(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/g;
  while ((m = staticRe.exec(src)) !== null) literal.add(m[2]!);
  return { literal: [...literal], nonLiteral };
}

export interface PySpecifiers {
  /** Absolute dotted module names. */
  absolute: string[];
  /** Relative imports: level (number of dots), module path, imported names. */
  relative: Array<{ level: number; module: string; names: string[] }>;
  nonLiteral: boolean;
}

export function pySpecifiers(source: string): PySpecifiers {
  const absolute = new Set<string>();
  const relative: PySpecifiers["relative"] = [];
  let nonLiteral = false;
  const lines = source.split("\n").filter((l) => !/^\s*#/.test(l));
  const text = lines.join("\n");
  const importRe = /^[ \t]*import[ \t]+([\w. \t,]+?)[ \t]*(?:#.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text)) !== null) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[\w.]+$/.test(name)) absolute.add(name);
    }
  }
  const fromRe = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w*, \t]+))/gm;
  while ((m = fromRe.exec(text)) !== null) {
    const level = m[1]!.length;
    const mod = m[2]!;
    const names = (m[3] ?? m[4] ?? "")
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((n) => /^[\w*]+$/.test(n));
    if (level === 0) {
      if (mod) {
        absolute.add(mod);
        for (const n of names) if (n !== "*") absolute.add(`${mod}.${n}`);
      }
    } else relative.push({ level, module: mod, names });
  }
  const dyn = /\b(?:importlib\.import_module|__import__)\s*\(\s*([^)]{0,200})/g;
  while ((m = dyn.exec(text)) !== null) {
    if (!/^(['"])[\w.]+\1\s*(?:,|$)/.test(m[1]!.trim())) nonLiteral = true;
  }
  return { absolute: [...absolute], relative, nonLiteral };
}

interface PackageJson {
  name?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  bin?: unknown;
  scripts?: unknown;
}

function collectExportTargets(node: unknown, out: string[]): void {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const n of node) collectExportTargets(n, out);
  else if (node && typeof node === "object") for (const v of Object.values(node)) collectExportTargets(v, out);
}

/** Files an install-hook command names (`node x`, `sh x`, `bash x`, `python x`). */
export function scriptFiles(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;&|(])(?:node|sh|bash|python3?|tsx|ts-node)\s+(?:-[-\w=]+\s+)*([^\s;&|)'"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const f = m[1]!;
    if (!f.startsWith("-")) out.push(f.replace(/^\.\//, ""));
  }
  return out;
}

/** Split a shell command into simple commands on unquoted `&&`, `||`, `;`, `|` and newlines, tokenized with quotes removed. */
export function shellSegments(command: string): string[][] {
  const segs: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  const pushTok = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  const pushSeg = () => {
    pushTok();
    if (tokens.length > 0) segs.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      pushSeg();
    } else if (ch === " " || ch === "\t") pushTok();
    else {
      cur += ch;
      has = true;
    }
  }
  pushSeg();
  return segs;
}

/** Hook commands that never execute a file of the package itself. */
const NO_PACKAGE_FILE_COMMANDS = new Set([
  "echo", "printf", "exit", "true", "false", ":", "test", "[", "mkdir", "rm", "cp", "mv", "chmod", "ln", "touch", "cat",
  "node-gyp", "node-gyp-build", "prebuild-install", "husky", "tsc", "rimraf", "is-ci", "curl", "wget",
]);
const NODE_RUNNERS = new Set(["node", "nodejs", "tsx", "ts-node", "bun"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const PYTHONS = new Set(["python", "python3"]);
const PKG_MANAGERS = new Set(["npm", "yarn", "pnpm"]);

export function buildReachGraph(files: Map<string, Uint8Array>): ReachGraph {
  const has = (p: string) => files.has(p);
  const textCache = new Map<string, string | null>();
  const text = (p: string): string | null => {
    if (!textCache.has(p)) textCache.set(p, textOf(files.get(p)));
    return textCache.get(p) ?? null;
  };
  const entries: ReachEntry[] = [];
  const inlineInstallCommands: ReachGraph["inlineInstallCommands"] = [];
  const unboundedFrom = new Set<string>();
  const ecosystems: ReachGraph["ecosystems"] = [];

  let pkg: PackageJson | null = null;
  if (has("package.json")) {
    ecosystems.push("npm");
    try {
      pkg = JSON.parse(text("package.json") ?? "") as PackageJson;
    } catch {
      pkg = null;
    }
  }
  const isPython = has("setup.py") || has("pyproject.toml") || has("setup.cfg");
  if (isPython) ecosystems.push("python");
  const ownName = pkg && typeof pkg.name === "string" ? pkg.name : null;

  const resolveJsFile = (base: string): string | null => {
    if (has(base) && !base.endsWith("/")) return base;
    for (const ext of JS_EXT) if (has(base + ext)) return base + ext;
    const pj = base ? `${base}/package.json` : "package.json";
    if (base && has(pj)) {
      try {
        const sub = JSON.parse(text(pj) ?? "") as PackageJson;
        if (typeof sub.main === "string") {
          const t = join(base, sub.main);
          if (t !== null) {
            const r = resolveJsFile(t);
            if (r) return r;
          }
        }
      } catch {
        // fall through to index resolution
      }
    }
    for (const ext of JS_EXT) {
      const idx = base ? `${base}/index${ext}` : `index${ext}`;
      if (has(idx)) return idx;
    }
    return null;
  };

  const resolveJs = (from: string, spec: string): string | null => {
    if (spec.startsWith("node:")) return null;
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      const t = join(dirname(from), spec);
      return t === null ? null : resolveJsFile(t);
    }
    if (spec.startsWith("/")) return null;
    if (ownName && (spec === ownName || spec.startsWith(ownName + "/"))) {
      return resolveJsFile(spec.slice(ownName.length + 1));
    }
    // Bundled dependency at the archive root.
    const t = join("node_modules", spec);
    return t === null ? null : resolveJsFile(t);
  };

  const resolvePyModule = (dotted: string, roots: string[]): string[] => {
    const parts = dotted.split(".").filter(Boolean);
    for (const root of roots) {
      const found: string[] = [];
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const dir = [root, ...parts.slice(0, i + 1)].filter(Boolean).join("/");
        const init = `${dir}/__init__.py`;
        if (has(init)) found.push(init);
        else if (i === parts.length - 1 && has(`${dir}.py`)) found.push(`${dir}.py`);
        else {
          if (i === 0) ok = false;
          break;
        }
      }
      if (ok && found.length > 0) return found;
    }
    return [];
  };

  const edgesOf = (file: string): string[] => {
    const src = text(file);
    if (src === null) return [];
    const out: string[] = [];
    if (JS_CODE_RE.test(file)) {
      const s = jsSpecifiers(src);
      if (s.nonLiteral) unboundedFrom.add(file);
      for (const spec of s.literal) {
        const r = resolveJs(file, spec);
        if (r) out.push(r);
      }
    } else if (file.endsWith(".py")) {
      const s = pySpecifiers(src);
      if (s.nonLiteral) unboundedFrom.add(file);
      const fileDir = dirname(file);
      for (const mod of s.absolute) out.push(...resolvePyModule(mod, [fileDir, ...PY_ROOTS]));
      for (const rel of s.relative) {
        let base: string | null = fileDir;
        for (let i = 1; i < rel.level && base !== null; i++) base = base === "" ? null : dirname(base);
        if (base === null) continue;
        if (rel.module) out.push(...resolvePyModule(rel.module, [base]));
        for (const n of rel.names) {
          if (n === "*") continue;
          const dotted = rel.module ? `${rel.module}.${n}` : n;
          out.push(...resolvePyModule(dotted, [base]));
        }
        if (!rel.module && has(base ? `${base}/__init__.py` : "__init__.py")) {
          out.push(base ? `${base}/__init__.py` : "__init__.py");
        }
      }
    }
    return out;
  };

  const addEntry = (path: string | null, kind: "install" | "import", why: string) => {
    if (path && has(path) && !entries.some((e) => e.path === path && e.kind === kind)) {
      entries.push({ path, kind, why });
    }
  };

  // npm entries
  const unresolvedHooks: string[] = [];
  if (pkg) {
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
    for (const hook of NPM_INSTALL_HOOKS) {
      const cmd = scripts[hook];
      if (typeof cmd !== "string") continue;
      const r = resolveHook(cmd, scripts, has, text, resolveJsFile, resolveJs, resolvePyModule);
      for (const f of r.files) addEntry(f, "install", `scripts.${hook}`);
      if (r.files.length === 0 || r.inline) inlineInstallCommands.push({ hook, command: cmd });
      if (r.unresolved) unresolvedHooks.push(`package.json scripts.${hook}`);
    }
    if (has("binding.gyp")) {
      addEntry("binding.gyp", "install", "node-gyp runs binding.gyp on install");
      const gyp = text("binding.gyp") ?? "";
      for (const m of gyp.matchAll(/['"]([^'"]+\.(?:c|cc|cpp|cxx|h|hpp|gypi|js|py))['"]/g)) {
        const t = join("", m[1]!);
        if (t) addEntry(t, "install", "binding.gyp source");
      }
    }
    if (typeof pkg.main === "string") {
      const t = join("", pkg.main);
      addEntry(t === null ? null : resolveJsFile(t), "import", "main");
    } else {
      addEntry(resolveJsFile(""), "import", "default index");
    }
    if (typeof pkg.module === "string") {
      const t = join("", pkg.module);
      addEntry(t === null ? null : resolveJsFile(t), "import", "module");
    }
    const exp: string[] = [];
    collectExportTargets(pkg.exports, exp);
    for (const e of exp) {
      if (e.includes("*")) {
        // Subpath pattern: every file matching the pattern is importable.
        const [pre, post] = e.replace(/^\.\//, "").split("*") as [string, string];
        for (const p of files.keys()) if (p.startsWith(pre) && p.endsWith(post ?? "")) addEntry(p, "import", "exports pattern");
      } else {
        const t = join("", e);
        addEntry(t === null ? null : resolveJsFile(t), "import", "exports");
      }
    }
    const bins: string[] = [];
    if (typeof pkg.bin === "string") bins.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === "object") {
      for (const v of Object.values(pkg.bin)) if (typeof v === "string") bins.push(v);
    }
    for (const b of bins) {
      const t = join("", b);
      addEntry(t === null ? null : resolveJsFile(t) ?? t, "import", "bin");
    }
  }

  // Python entries
  if (isPython) {
    addEntry("setup.py", "install", "setup.py runs at build/install");
    const pyproject = text("pyproject.toml") ?? "";
    const backendPath = /backend-path\s*=\s*\[([^\]]*)\]/.exec(pyproject);
    const backend = /build-backend\s*=\s*['"]([\w.:]+)['"]/.exec(pyproject);
    if (backendPath && backend) {
      const dirs = [...backendPath[1]!.matchAll(/['"]([^'"]*)['"]/g)].map((m) => join("", m[1]!) ?? "");
      const mod = backend[1]!.split(":")[0]!;
      for (const f of resolvePyModule(mod, dirs)) addEntry(f, "install", "in-tree build backend");
    }
    for (const p of files.keys()) if (p.endsWith(".pth")) addEntry(p, "install", ".pth runs at interpreter start");
    for (const root of PY_ROOTS) {
      for (const p of files.keys()) {
        const rel = root ? (p.startsWith(root + "/") ? p.slice(root.length + 1) : null) : p;
        if (rel && /^[A-Za-z_][\w]*\/__init__\.py$/.test(rel) && !isUnreachablePath(p)) {
          addEntry(p, "import", "top-level package");
        }
      }
    }
    const setupPy = text("setup.py") ?? "";
    const declared = [
      ...[...`${setupPy}\n${pyproject}`.matchAll(/py[_-]modules\s*=\s*\[([^\]]*)\]/g)].flatMap((m) =>
        [...m[1]!.matchAll(/['"]([\w.]+)['"]/g)].map((x) => x[1]!),
      ),
    ];
    for (const mod of declared) for (const f of resolvePyModule(mod, PY_ROOTS)) addEntry(f, "import", "py_modules");
    const scriptsSection = /\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/.exec(pyproject)?.[1] ?? "";
    const consoleTargets = [
      ...[...scriptsSection.matchAll(/=\s*['"]([\w.]+):[\w.]+['"]/g)].map((m) => m[1]!),
      ...[...setupPy.matchAll(/['"][\w.-]+\s*=\s*([\w.]+):[\w.]+['"]/g)].map((m) => m[1]!),
    ];
    for (const mod of consoleTargets) for (const f of resolvePyModule(mod, PY_ROOTS)) addEntry(f, "import", "console script");
  }

  const walk = (kind: "install" | "import"): Set<string> => {
    const seen = new Set<string>();
    const stack = entries.filter((e) => e.kind === kind).map((e) => e.path);
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const next of edgesOf(f)) if (!seen.has(next)) stack.push(next);
    }
    return seen;
  };
  const install = walk("install");
  const importSet = walk("import");
  for (const f of install) importSet.delete(f);
  // No root manifest after stripping: nothing tells us what runs, so every non-test file counts as reachable.
  const noManifest = !pkg && !isPython && !has("package.json");
  const hookUnbounded = unresolvedHooks.length > 0;
  // Text an unknown install hook can run at the root: the manifest and root build
  // files. A test-path file named there (a Makefile running `node test/x.js`) is
  // install-time code; any other test-path file is not reachable by inference.
  const hookText = hookUnbounded
    ? [...files.keys()]
        .filter((f) => !f.includes("/") && (f === "package.json" || /^(GNU)?makefile$|\.mk$|^justfile$|\.sh$/i.test(f)))
        .map((f) => text(f) ?? "")
        .join("\n")
    : "";
  const namedByHook = (path: string) => hookText.includes(path);
  for (const h of unresolvedHooks) unboundedFrom.add(h);
  if (noManifest) unboundedFrom.add("(no root manifest)");
  const unbounded = unboundedFrom.size > 0;
  const unboundedInstall = hookUnbounded || [...unboundedFrom].some((f) => install.has(f));
  // In the unbounded case a file counts only if an installer or entry point in the VM can
  // run it: JS/TS, shell, Python, a shebang script, a native addon, or C/C++ that node-gyp
  // builds (binding.gyp). Swift, Rust, Kotlin, Go and the like have no toolchain there.
  const gyp = has("binding.gyp");
  const runnable = (path: string): boolean => {
    if (RUNNABLE_RE.test(path)) return true;
    if (gyp && NATIVE_SRC_RE.test(path)) return true;
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (!base.includes(".")) return (text(path) ?? "").startsWith("#!");
    return false;
  };

  const workspace = planWorkspace(files, text);
  // Under a workspace plan, files inside workspace packages that are not installed
  // never run at install: reach follows the plan.
  const notInstalled = (path: string): boolean => {
    if (!workspace) return false;
    const inPkg = workspace.allDirs.find((d) => path === d || path.startsWith(d + "/"));
    return Boolean(inPkg) && !workspace.selectedDirs.includes(inPkg!);
  };
  return {
    install,
    import: importSet,
    entries,
    inlineInstallCommands,
    unbounded,
    unboundedFrom: [...unboundedFrom].sort(),
    ecosystems,
    workspace,
    classify(path: string): Reach {
      if (install.has(path) || INSTALL_MANIFESTS.has(path)) return "install";
      if (importSet.has(path)) return "import";
      if (notInstalled(path)) return "unreachable";
      // An install hook that runs files we cannot name: every file but documentation can run at install.
      if (hookUnbounded && files.has(path) && !isDocPath(path) && (!isTestPath(path) || namedByHook(path)) && runnable(path)) return "install";
      if (unbounded && files.has(path) && !isUnreachablePath(path) && runnable(path)) return unboundedInstall ? "install" : "import";
      return "unreachable";
    },
  };
}

/** Documentation only: markdown, reStructuredText, plain text, and docs/ trees. */
export function isDocPath(path: string): boolean {
  if (/(^|\/)docs?\//i.test(path)) return true;
  return /\.(md|markdown|mdx|rst|txt)$/i.test(path.slice(path.lastIndexOf("/") + 1));
}

interface HookResolution {
  /** Package files the command runs at install. */
  files: string[];
  /** True when the command runs something we could not resolve to package files. */
  unresolved: boolean;
  /** True when the command carries inline code (node -e, sh -c, python -c, curl | sh). */
  inline: boolean;
}

/**
 * Resolve an install-hook command to the package files it runs: `npm run X`
 * chains (recursively), `node -r/--require/--import <f>`, string literals in
 * `node -e`, `python -c` imports, `python -m`, `sh -c` bodies, shell scripts
 * that call other scripts, and `cd dir &&` prefixes. Anything that runs an
 * unknown program sets `unresolved`, which makes the install set unbounded.
 */
function resolveHook(
  command: string,
  scripts: Record<string, unknown>,
  has: (p: string) => boolean,
  text: (p: string) => string | null,
  resolveJsFile: (base: string) => string | null,
  resolveJs: (from: string, spec: string) => string | null,
  resolvePyModule: (dotted: string, roots: string[]) => string[],
): HookResolution {
  const out = new Set<string>();
  let unresolved = false;
  let inline = false;
  const seenScripts = new Set<string>();
  const seenFiles = new Set<string>();

  const fileAt = (cwd: string, rel: string): string | null => {
    const t = join(cwd, rel.replace(/^\.\//, ""));
    if (t === null) return null;
    return resolveJsFile(t) ?? (has(t) ? t : null);
  };
  const runFile = (f: string, depth: number) => {
    out.add(f);
    // A shell script (no JS/Python extension) runs further commands: follow them.
    if (!JS_CODE_RE.test(f) && !f.endsWith(".py") && !f.endsWith(".json") && !seenFiles.has(f) && depth < 6) {
      seenFiles.add(f);
      const body = text(f);
      if (body !== null && (/^#!.*\b(?:ba|z|da)?sh\b/.test(body) || f.endsWith(".sh"))) walk(body.replace(/^#!.*\n/, ""), dirname(f), depth + 1);
    }
  };
  const jsCode = (code: string, cwd: string) => {
    inline = true;
    const sp = jsSpecifiers(code);
    if (sp.nonLiteral) unresolved = true;
    for (const spec of sp.literal) {
      const r = resolveJs(cwd ? `${cwd}/__hook__.js` : "__hook__.js", spec);
      if (r) out.add(r);
    }
  };

  function walk(cmd: string, base: string, depth: number): void {
    if (depth > 6) {
      unresolved = true;
      return;
    }
    let cwd = base;
    for (const seg of shellSegments(cmd)) {
      let i = 0;
      while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]!)) i++;
      if (i >= seg.length) continue;
      const prog = seg[i]!;
      const name = prog.slice(prog.lastIndexOf("/") + 1);
      const args = seg.slice(i + 1);
      if (name === "cd") {
        const t = args[0] ? join(cwd, args[0]) : "";
        cwd = t ?? cwd;
        continue;
      }
      if (name === "npx" || name === "exec") {
        // `npx <bin>` runs a dependency or a package bin: resolve a local path, otherwise unknown.
        const target = args.find((a) => !a.startsWith("-"));
        const f = target ? fileAt(cwd, target) : null;
        if (f) runFile(f, depth);
        else unresolved = true;
        continue;
      }
      if (PKG_MANAGERS.has(name)) {
        const sub = args[0] ?? "";
        const scriptName = sub === "run" || sub === "run-script" ? args.find((a, k) => k > 0 && !a.startsWith("-")) : name !== "npm" && typeof scripts[sub] === "string" ? sub : undefined;
        if (scriptName !== undefined) {
          const body = scripts[scriptName];
          if (typeof body === "string" && !seenScripts.has(scriptName)) {
            seenScripts.add(scriptName);
            walk(body, "", depth + 1);
          }
          for (const pre of [`pre${scriptName}`, `post${scriptName}`]) {
            const b = scripts[pre];
            if (typeof b === "string" && !seenScripts.has(pre)) {
              seenScripts.add(pre);
              walk(b, "", depth + 1);
            }
          }
          continue;
        }
        if (["install", "i", "ci", "rebuild", "add"].includes(sub)) continue;
        unresolved = true;
        continue;
      }
      if (NODE_RUNNERS.has(name)) {
        let ran = false;
        for (let k = 0; k < args.length; k++) {
          const a = args[k]!;
          if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") {
            jsCode(args[k + 1] ?? "", cwd);
            ran = true;
            k++;
          } else if (a === "-r" || a === "--require" || a === "--import" || a === "--loader" || a === "--experimental-loader") {
            const spec = args[k + 1] ?? "";
            const f = spec.startsWith(".") || spec.startsWith("/") ? fileAt(cwd, spec) : resolveJs(cwd ? `${cwd}/__hook__.js` : "__hook__.js", spec);
            if (f) out.add(f);
            k++;
          } else if (/^--(?:require|import|loader|experimental-loader|eval|print)=/.test(a)) {
            const v = a.slice(a.indexOf("=") + 1);
            if (/^--(?:eval|print)=/.test(a)) {
              jsCode(v, cwd);
              ran = true;
            } else {
              const f = fileAt(cwd, v);
              if (f) out.add(f);
            }
          } else if (a.startsWith("-")) {
            continue;
          } else {
            const f = fileAt(cwd, a);
            if (f) runFile(f, depth);
            else unresolved = true;
            ran = true;
            break;
          }
        }
        if (!ran) inline = true;
        continue;
      }
      if (SHELLS.has(name)) {
        const c = args.indexOf("-c");
        if (c !== -1) {
          inline = true;
          walk(args[c + 1] ?? "", cwd, depth + 1);
          continue;
        }
        const script = args.find((a) => !a.startsWith("-"));
        if (!script) {
          inline = true; // reads its program from stdin (`curl ... | sh`)
          continue;
        }
        const f = fileAt(cwd, script);
        if (f) runFile(f, depth);
        else unresolved = true;
        continue;
      }
      if (PYTHONS.has(name)) {
        let done = false;
        for (let k = 0; k < args.length && !done; k++) {
          const a = args[k]!;
          if (a === "-c") {
            inline = true;
            const sp = pySpecifiers(args[k + 1] ?? "");
            if (sp.nonLiteral) unresolved = true;
            for (const mod of sp.absolute) for (const f of resolvePyModule(mod, [cwd, ...PY_ROOTS])) out.add(f);
            done = true;
          } else if (a === "-m") {
            const found = resolvePyModule(args[k + 1] ?? "", [cwd, ...PY_ROOTS]);
            if (found.length > 0) for (const f of found) out.add(f);
            else unresolved = true;
            done = true;
          } else if (!a.startsWith("-")) {
            const f = fileAt(cwd, a);
            if (f) runFile(f, depth);
            else unresolved = true;
            done = true;
          }
        }
        continue;
      }
      if (NO_PACKAGE_FILE_COMMANDS.has(name)) {
        if (name === "curl" || name === "wget") inline = true;
        continue;
      }
      // A path to a package file (`./install.sh`, `bin/setup`).
      const direct = fileAt(cwd, prog);
      if (direct) {
        runFile(direct, depth);
        continue;
      }
      unresolved = true;
    }
  }

  walk(command, "", 0);
  return { files: [...out].sort(), unresolved, inline };
}
