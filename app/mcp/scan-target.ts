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
import { parseScanTarget } from "../../lib/parse-repo";

export interface McpScanInput {
  owner?: string;
  repo?: string;
  ref?: string;
  package?: string;
  version?: string;
}

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
