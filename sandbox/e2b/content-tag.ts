/**
 * Content tag of the scan template (sandbox/e2b/build.ts). A sha256 over every
 * file that defines the image (template definition, guest scripts, rules, mirror
 * seed) and the VM size, so an unchanged template is never rebuilt and a changed
 * one always is.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_CPU_COUNT, SANDBOX_MEMORY_MB } from "../../lib/engine/sandbox/resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Files whose bytes define the template image and its size. */
export function templateInputFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "__pycache__" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(join(here, "guest"));
  walk(join(here, "rules"));
  out.push(
    join(here, "template.ts"),
    join(here, "mirror-seed.json"),
    join(repoRoot, "lib", "engine", "sandbox", "resources.ts"),
    join(repoRoot, "lib", "engine", "sandbox", "scanner-versions.ts"),
  );
  return out.sort();
}

/** `c-<16 hex>`: sha256 over each input's repo-relative path and bytes, plus the VM size. */
export function templateContentTag(): string {
  const h = createHash("sha256");
  for (const f of templateInputFiles()) {
    h.update(relative(repoRoot, f));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  h.update(`cpu=${SANDBOX_CPU_COUNT} mem=${SANDBOX_MEMORY_MB}`);
  return `c-${h.digest("hex").slice(0, 16)}`;
}
