/**
 * What the public lists (the danger board, the sitemap) leave out: our own test
 * fixture repos, which exist to be scanned by tests (cr-fixture-phone-home,
 * cr-exfil-test-fixture and any later `cr-…fixture` repo). Their reports stay in
 * the database and their pages stay reachable by direct link.
 */

/** Postgres regex for a test fixture repo name. */
export const TEST_FIXTURE_REPO_RE = "^cr-([a-z0-9._-]*-)?fixture";

/** The same rule in JS. */
export function isTestFixtureRepo(repo: string): boolean {
  return new RegExp(TEST_FIXTURE_REPO_RE, "i").test(repo);
}
