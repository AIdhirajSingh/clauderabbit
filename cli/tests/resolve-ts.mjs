/**
 * Minimal ESM resolver hook for `node --test`.
 *
 * cli/ is compiled with TS's NodeNext convention: source imports use an
 * explicit `.js` extension (e.g. `import { scanRepo } from "../lib/client.js"`)
 * even though the real file on disk is `client.ts` — `tsc` resolves that at
 * build time, but running a `.test.ts` file directly (no build step) hits
 * Node's native loader, which tries to load the literal `.js` path and fails
 * (`ERR_MODULE_NOT_FOUND`, since only `client.ts` exists pre-build). This hook
 * fills exactly that gap: when a relative `.js` specifier doesn't resolve,
 * retry it as `.ts`. Node 22+/24 strips the TypeScript types itself.
 *
 * Wired in via `node --import ./tests/resolve-ts.mjs --test ...` (see the
 * package.json `test` script).
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(import.meta.filename ?? import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative && specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
      const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
      return nextResolve(tsSpecifier, context);
    }
  }
  return nextResolve(specifier, context);
}
