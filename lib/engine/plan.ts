/**
 * The install plan, made on the server before the sandbox from registry metadata only
 * (names, versions, dependency ranges and the `hasInstallScript` flag of the abbreviated
 * packument; no package code is fetched). It finds which dev packages have an install
 * script, for npm lockfiles v1, v2 and v3 and for a repo with no lockfile (the dev tree
 * is resolved from package.json ranges). The sandbox then installs the production tree
 * plus only those dev packages; every install-time script still runs.
 */

import semver from "semver";

export interface InstallPlan {
  /** name@version of every dev package with an install script. */
  devScripts: string[];
  /** Dev packages in the tree (with and without scripts). */
  devTotal: number;
  /** Where the dev tree came from. */
  source: "lockfile-v2" | "lockfile-v1" | "resolved";
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type Abbrev = { versions?: Record<string, { dependencies?: Record<string, string>; hasInstallScript?: boolean }>; "dist-tags"?: Record<string, string> };

const REGISTRY = "https://registry.npmjs.org";
const NAME_RE = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;
const MAX_PACKAGES = 3000;
const CONCURRENCY = 48;

async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

function packumentFetcher(fetchFn: FetchFn, signal?: AbortSignal) {
  const cache = new Map<string, Promise<Abbrev | null>>();
  return (name: string): Promise<Abbrev | null> => {
    if (!NAME_RE.test(name)) return Promise.resolve(null);
    let p = cache.get(name);
    if (!p) {
      p = fetchFn(`${REGISTRY}/${name.replace("/", "%2f")}`, { headers: { Accept: "application/vnd.npm.install-v1+json" }, signal })
        .then((r) => (r.ok ? (r.json() as Promise<Abbrev>) : null))
        .catch(() => null);
      cache.set(name, p);
    }
    return p;
  };
}

/** The plan, or null when no npm manifest exists or the lockfile is pnpm/yarn (the sandbox then plans itself). */
export async function planInstall(files: Map<string, Uint8Array>, fetchFn: FetchFn, signal?: AbortSignal): Promise<InstallPlan | null> {
  const text = (p: string) => (files.has(p) ? new TextDecoder().decode(files.get(p)) : null);
  const pkgText = text("package.json");
  if (!pkgText) return null;
  let pkg: { devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return null;
  }
  const get = packumentFetcher(fetchFn, signal);
  const lockText = text("package-lock.json") ?? text("npm-shrinkwrap.json");
  if (lockText) {
    let lock: { packages?: Record<string, { version?: string; dev?: boolean; hasInstallScript?: boolean; name?: string }>; dependencies?: Record<string, unknown> };
    try {
      lock = JSON.parse(lockText);
    } catch {
      return null;
    }
    if (lock.packages) {
      const dev = Object.entries(lock.packages).filter(([k, v]) => k !== "" && v.dev === true && typeof v.version === "string");
      const nameOf = (k: string, v: { name?: string }) => v.name ?? k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);
      const devScripts = [...new Set(dev.filter(([, v]) => v.hasInstallScript === true).map(([k, v]) => `${nameOf(k, v)}@${v.version}`))].sort();
      return { devScripts, devTotal: new Set(dev.map(([k, v]) => `${nameOf(k, v)}@${v.version}`)).size, source: "lockfile-v2" };
    }
    // v1: a nested dependencies tree with dev flags and no install-script flag: read it per version.
    const dev = new Map<string, { name: string; version: string }>();
    const walk = (deps: Record<string, unknown> | undefined) => {
      for (const [name, raw] of Object.entries(deps ?? {})) {
        const v = raw as { version?: string; dev?: boolean; dependencies?: Record<string, unknown> };
        if (v?.dev === true && typeof v.version === "string" && semver.valid(v.version)) dev.set(`${name}@${v.version}`, { name, version: v.version });
        walk(v?.dependencies);
      }
    };
    walk(lock.dependencies);
    const list = [...dev.values()].slice(0, MAX_PACKAGES);
    const flags = await pool(list, async (d) => (await get(d.name))?.versions?.[d.version]?.hasInstallScript === true);
    return { devScripts: list.filter((_, i) => flags[i]).map((d) => `${d.name}@${d.version}`).sort(), devTotal: dev.size, source: "lockfile-v1" };
  }
  if (text("pnpm-lock.yaml") || text("yarn.lock")) return null;
  // No lockfile: resolve the dev tree from package.json ranges, level by level, in parallel.
  const seen = new Map<string, boolean>();
  let level: Array<[string, string]> = Object.entries(pkg.devDependencies ?? {});
  while (level.length > 0 && seen.size < MAX_PACKAGES) {
    const resolved = await pool(level, async ([name, range]) => {
      const p = await get(name);
      const versions = Object.keys(p?.versions ?? {});
      const tag = p?.["dist-tags"]?.[range];
      const v = tag ?? semver.maxSatisfying(versions, range);
      return v ? { name, v, meta: p!.versions![v]! } : null;
    });
    const next: Array<[string, string]> = [];
    for (const r of resolved) {
      if (!r || seen.has(`${r.name}@${r.v}`)) continue;
      seen.set(`${r.name}@${r.v}`, r.meta.hasInstallScript === true);
      for (const [n, rg] of Object.entries(r.meta.dependencies ?? {})) next.push([n, rg]);
    }
    level = next.filter(([n, rg]) => ![...seen.keys()].some((k) => k.startsWith(`${n}@`) && semver.satisfies(k.slice(n.length + 1), rg)));
  }
  return { devScripts: [...seen].filter(([, s]) => s).map(([k]) => k).sort(), devTotal: seen.size, source: "resolved" };
}
