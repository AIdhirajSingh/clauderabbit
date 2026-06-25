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
    ignores: ["design-source/**", "supabase/functions/**", ".next/**"],
  },
];

export default eslintConfig;
