/**
 * npmReputationView (npm.ts): only real registry signals; unavailable ones absent.
 * Run: `deno test supabase/functions/_shared/npm-reputation.test.ts`
 */
import { type NpmMetadata, npmReputationView } from "./npm.ts";

function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

const base: NpmMetadata = {
  name: "left-pad", version: "1.3.0", description: null, publishedAt: null,
  firstPublishedAt: "2014-03-17T20:45:00.000Z", license: "WTFPL", maintainerCount: 1,
  lastMonthDownloads: 4_000_000, publisher: "stevemao", maintainers: ["stevemao"],
  versionCount: 13, weeklyDownloads: 1_000_000, tarballUrl: "", integrityVerified: true,
  integrityAlgo: "sha512", linkedRepo: null, hasInstallHook: false,
};

Deno.test("full registry data -> publisher, maintainers, age, downloads, versions", () => {
  const v = npmReputationView(base, new Date("2026-10-04T00:00:00Z"));
  assert(v.publisher === "stevemao", JSON.stringify(v));
  assert(v.maintainers?.[0] === "stevemao", JSON.stringify(v));
  assert(v.ageLabel === "12 yr 6 mo", String(v.ageLabel));
  assert(v.weeklyDownloads === 1_000_000 && v.versionCount === 13, JSON.stringify(v));
});

Deno.test("missing registry data -> fields absent, never 'unknown'/'new'/0", () => {
  const v = npmReputationView({
    ...base, firstPublishedAt: null, publisher: null, maintainers: [], versionCount: null,
    weeklyDownloads: null, lastMonthDownloads: null, license: null,
  });
  const keys = Object.keys(v).sort().join(",");
  assert(keys === "package,version", keys);
  assert(!/unknown|new/.test(JSON.stringify(v)), JSON.stringify(v));
});
