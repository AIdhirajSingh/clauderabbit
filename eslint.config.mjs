import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * Flat config for Next.js 16.
 *
 * eslint-config-next@16 ships native flat-config arrays at its
 * `./core-web-vitals` and `./typescript` entry points, so we spread them
 * directly. We deliberately do NOT use the FlatCompat bridge: it round-trips
 * the legacy shareable config through JSON and breaks under ESLint 10's
 * stricter schema validation.
 *
 * We pin `settings.react.version` to "19" (the installed React major). The
 * eslint-plugin-react bundled with eslint-config-next defaults this to
 * "detect", and its auto-detection path calls `context.getFilename()` — a
 * method ESLint 10 removed — which throws on every file. Naming a concrete
 * version skips detection entirely. This is an accurate setting, not a
 * weakening of any rule.
 */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    settings: {
      react: {
        version: "19",
      },
    },
  },
  {
    // The Next.js app lint scope is the TypeScript web layer only. The other trees
    // are different runtimes/artifacts and are not linted here: design-source is the
    // raw design export, and sandbox/e2b is the E2B template plus the in-VM guest
    // harness (Python and bash that run inside the detonation sandbox).
    // `.claude/**` is the (gitignored) Claude Code harness dir — it can contain
    // sibling worktree checkouts of this very repo (each with its own nested
    // sandbox/), so it must be ignored too or ESLint recurses into their fixtures.
    ignores: [
      "design-source/**",
      "sandbox/**",
      // Fixture packages the keyless e2e test installs and runs (CommonJS on purpose).
      "tests/fixtures/**",
      ".claude/**",
      ".next/**",
      // `vercel build` writes bundled third-party output under .vercel; never lint it.
      ".vercel/**",
    ],
  },
];

export default eslintConfig;
