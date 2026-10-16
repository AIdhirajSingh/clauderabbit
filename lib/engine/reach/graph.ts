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
  classify(path: string): Reach;
}

const JS_EXT = [".js", ".mjs", ".cjs", ".json", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".node"];
const JS_CODE_RE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const NPM_INSTALL_HOOKS = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
const PY_ROOTS = ["", "src"];
/** Root manifests the package manager itself processes during install. */
const INSTALL_MANIFESTS = new Set(["package.json", "setup.py", "setup.cfg", "pyproject.toml", "binding.gyp"]);

const UNREACHABLE_DIR_RE =
  /(^|\/)(tests?|__tests__|specs?|docs?|examples?|benchmarks?|fixtures?|\.github|terraform|k8s)\//i;

/** Paths that never count as reachable in the unbounded case (section 5.2). */
export function isUnreachablePath(path: string): boolean {
  if (UNREACHABLE_DIR_RE.test(path)) return true;
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
  if (pkg) {
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
    for (const hook of NPM_INSTALL_HOOKS) {
      const cmd = scripts[hook];
      if (typeof cmd !== "string") continue;
      const named = scriptFiles(cmd);
      let resolvedAny = false;
      for (const f of named) {
        const t = join("", f);
        const r = t === null ? null : resolveJsFile(t) ?? (has(t) ? t : null);
        if (r) {
          addEntry(r, "install", `scripts.${hook}`);
          resolvedAny = true;
        }
      }
      if (!resolvedAny) inlineInstallCommands.push({ hook, command: cmd });
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
  const unbounded = unboundedFrom.size > 0;
  const unboundedInstall = [...unboundedFrom].some((f) => install.has(f));

  return {
    install,
    import: importSet,
    entries,
    inlineInstallCommands,
    unbounded,
    unboundedFrom: [...unboundedFrom].sort(),
    ecosystems,
    classify(path: string): Reach {
      if (install.has(path) || INSTALL_MANIFESTS.has(path)) return "install";
      if (importSet.has(path)) return "import";
      if (unbounded && files.has(path) && !isUnreachablePath(path)) return unboundedInstall ? "install" : "import";
      return "unreachable";
    },
  };
}
