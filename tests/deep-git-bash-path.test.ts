/**
 * Unit test for `deriveGitUsrBin` (lib/git-bash-path.ts) — a real, live-
 * diagnosed bug fix, not a hypothetical one: dispatching a genuine Cloud Run
 * detonation through the local sandbox controller failed with "readlink:
 * command not found" / "dirname: command not found" from inside gcloud's OWN
 * bash-script launcher, then gcloud misresolving its own install path
 * entirely — even though `command -v gcloud` (hasGcloud()) reported gcloud as
 * present. Spawning bash non-interactively does not source the Git-for-
 * Windows profile setup that would put its `usr\bin` coreutils on PATH, and
 * CR_SANDBOX_PATH_PREPEND only added the Cloud SDK's own bin dir, not Git's.
 *
 * Fixed by deriving Git's `usr\bin` directly from whichever bash.exe path was
 * actually resolved (an explicit CR_BASH override, or one of the two probed
 * Windows install locations) and adding it to the child's PATH alongside the
 * Cloud SDK dir. Verified live: the exact same real detonation that failed
 * with this error before the fix completed successfully after it — a real
 * Cloud Run Job execution ran AIdhirajSingh/clauderabbit end to end and
 * attached real forensics (score 25/100, "Malicious", a genuine sandbox run).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveGitUsrBin } from "../lib/git-bash-path.ts";

test("deriveGitUsrBin: usr/bin/bash.exe resolves to its own directory (already the coreutils dir)", () => {
  assert.equal(
    deriveGitUsrBin("C:\\Program Files\\Git\\usr\\bin\\bash.exe"),
    "C:\\Program Files\\Git\\usr\\bin",
  );
});

test("deriveGitUsrBin: bin/bash.exe (the other real WIN32_BASH_CANDIDATES entry) resolves to the sibling usr/bin", () => {
  assert.equal(
    deriveGitUsrBin("C:\\Program Files\\Git\\bin\\bash.exe"),
    "C:\\Program Files\\Git\\usr\\bin",
  );
});

test("deriveGitUsrBin: an explicit CR_BASH override pointing at a custom Git install still resolves correctly", () => {
  assert.equal(
    deriveGitUsrBin("D:\\Tools\\Git\\usr\\bin\\bash.exe"),
    "D:\\Tools\\Git\\usr\\bin",
  );
});

test("deriveGitUsrBin: a non-Git bash path (e.g. WSL) yields null rather than a guess", () => {
  assert.equal(deriveGitUsrBin("/usr/bin/bash"), null);
  assert.equal(deriveGitUsrBin("bash"), null);
});

test("deriveGitUsrBin: is case-insensitive on the path suffix (Windows paths)", () => {
  assert.equal(
    deriveGitUsrBin("C:\\Program Files\\Git\\Usr\\Bin\\Bash.exe"),
    "C:\\Program Files\\Git\\Usr\\Bin",
  );
});
