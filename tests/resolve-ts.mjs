/**
 * Minimal ESM resolver hook for `node --test`.
 *
 * Production code uses the project's bundler module resolution, so internal
 * imports are written WITHOUT a file extension (e.g. `import { band } from
 * "./score"`). Node's native ESM loader does not add `.ts` for extensionless
 * relative specifiers, so a test that imports a module which in turn imports its
 * siblings extensionlessly would fail to resolve. This hook fills exactly that
 * gap: when a relative specifier has no extension and does not resolve as-is, it
 * retries with `.ts` (then `.tsx`). It changes nothing about production builds;
 * it only teaches the test runner the same resolution the bundler already does.
 *
 * Wired in via `node --import ./tests/resolve-ts.mjs --test ...` (see the
 * package.json `test` script). Node 22+/24 strips the TypeScript types itself.
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(import.meta.filename ?? import.meta.url));

const EXT_CANDIDATES = [".ts", ".tsx"];

/** Does this specifier already end in a resolvable file extension? */
function hasExtension(specifier) {
  return /\.[cm]?[jt]sx?$/.test(specifier) || /\.json$/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative && !hasExtension(specifier)) {
    for (const ext of EXT_CANDIDATES) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        // Try the next candidate extension.
      }
    }
  }
  return nextResolve(specifier, context);
}
