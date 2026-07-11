/**
 * Resolve the remote `/mcp` `scan` tool's structured args into a GitHub or an
 * npm target. Pure + exported so the npm-support contract is unit-tested on its
 * own (see scan-target.test.ts), independently of the route's server/MCP deps —
 * this is the rail that keeps npm scanning from silently falling out of the
 * remote connector's schema again (it once shipped with owner/repo only, so a
 * claude.ai custom connector could not scan npm packages at all).
 *
 * An npm `package` takes precedence; otherwise a GitHub owner+repo is required —
 * mirroring the web app and the stdio MCP surface. The `package` string is parsed
 * by reusing the app's OWN `parseScanTarget`, so the bare / scoped / `npm:` /
 * npmjs-URL / trailing-@version forms and the name validation match the website
 * exactly rather than duplicating a third npm parser here. `parseScanTarget`
 * already classifies every VALID npm form as npm (a valid npm name is either an
 * unscoped name with no slash or a scoped `@scope/name`, both recognized as npm),
 * and only a slashed-non-scoped `owner/repo` string as github — which is never a
 * valid npm name — so requiring `kind === "npm"` accepts exactly the real npm
 * targets and rejects the rest.
 */
import { z } from "zod";
import { parseScanTarget } from "../../lib/parse-repo";

/**
 * The remote `scan` tool's input shape — co-located with the resolver it feeds so
 * the two can't drift, and EXPORTED so a test can assert directly at the schema
 * layer that `package`/`version` are declared. That is the real regression rail:
 * the MCP SDK validates + strips incoming args against this shape before the
 * handler runs, so if `package` were dropped here, a `{package:"x"}` call would be
 * silently stripped to `{}` and npm scanning would break again — and a test that
 * only exercised the resolver would NOT catch it. scan-target.test.ts asserts on
 * this shape for exactly that reason.
 */
export const scanInputShape = {
  owner: z
    .string()
    .min(1)
    .optional()
    .describe('GitHub repository owner or org, e.g. "sindresorhus". Provide together with `repo` to scan a GitHub repository. Omit when scanning an npm package via `package`.'),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe('GitHub repository name, e.g. "is". Required together with `owner` for a GitHub scan.'),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe("Optional git ref (branch, tag, or commit SHA) to scan instead of the default branch. GitHub scans only."),
  package: z
    .string()
    .min(1)
    .optional()
    .describe('npm package to scan the REAL published registry artifact for (the tarball `npm install` actually fetches, not the repo its package.json links to). Provide this INSTEAD of owner/repo. Accepts a bare name ("left-pad"), a scoped name ("@scope/name"), an explicit "npm:left-pad@1.3.0", or an npmjs.com package URL. A plain "owner/repo" is a GitHub target, not npm — use the owner and repo arguments for that.'),
  version: z
    .string()
    .min(1)
    .optional()
    .describe('Optional npm version or dist-tag (e.g. "1.3.0" or "latest") for the `package` scan; defaults to the latest published version. Ignored for GitHub scans. If `package` already carries a trailing @version, that wins.'),
};

export type McpScanInput = z.infer<z.ZodObject<typeof scanInputShape>>;

export type ResolvedScanTarget =
  | { kind: "github"; owner: string; repo: string; ref?: string; reportPath: string; label: string }
  | { kind: "npm"; package: string; version?: string; reportPath: string; label: string };

export type ResolveResult =
  | { ok: true; target: ResolvedScanTarget }
  | { ok: false; error: string };

export function resolveMcpScanTarget(args: McpScanInput): ResolveResult {
  const pkgRaw = args.package?.trim();
  if (pkgRaw) {
    // Reuse the app parser (handles bare / scoped / npm: / URL / @version) and
    // require an npm classification — a slashed-non-scoped `owner/repo` string is
    // never a valid npm name and is correctly rejected here.
    const parsed = parseScanTarget(pkgRaw);
    if (!parsed || parsed.kind !== "npm") {
      return {
        ok: false,
        error: `"${pkgRaw}" is not a valid npm package name. Pass a bare name ("left-pad"), a scoped name ("@scope/name"), "npm:left-pad@1.3.0", or an npmjs.com package URL.`,
      };
    }
    // A trailing @version embedded in the package string wins; otherwise the
    // explicit `version` argument (matching the stdio surface's precedence).
    const version = parsed.version ?? (args.version?.trim() || undefined);
    return {
      ok: true,
      target: {
        kind: "npm",
        package: parsed.package,
        ...(version ? { version } : {}),
        reportPath: `npm/${parsed.package}`,
        label: `npm package ${parsed.package}`,
      },
    };
  }

  const owner = args.owner?.trim();
  const repo = args.repo?.trim();
  if (!owner || !repo) {
    return {
      ok: false,
      error:
        "No scan target. Pass a GitHub repo as `owner` + `repo` (optionally `ref`), or an npm package as `package` (optionally `version`).",
    };
  }
  const ref = args.ref?.trim() || undefined;
  return {
    ok: true,
    target: {
      kind: "github",
      owner,
      repo,
      ...(ref ? { ref } : {}),
      reportPath: `${owner}/${repo}`,
      label: `${owner}/${repo}`,
    },
  };
}
