/**
 * Given a resolved bash.exe path, derive the Git-for-Windows install's own
 * `usr\bin` — where `readlink`/`dirname` (and other coreutils) actually live.
 *
 * Real, live-diagnosed bug (not hypothetical): dispatching a genuine Cloud Run
 * detonation through app/api/deep/route.ts's local sandbox controller failed
 * with "readlink: command not found" / "dirname: command not found" from
 * INSIDE gcloud's own bash-script launcher, then gcloud misresolving its own
 * install path entirely — even though `command -v gcloud` (hasGcloud() in
 * that route) reported gcloud as present. Spawning bash non-interactively
 * (`bash -c`, not a login shell) does not source the Git-for-Windows profile
 * setup that would put its `usr\bin` coreutils on PATH, and the route's own
 * CR_SANDBOX_PATH_PREPEND only added the Cloud SDK's own bin dir, not Git's —
 * both are needed. Fixed by deriving this directory straight from whichever
 * bash.exe path was actually resolved (an explicit CR_BASH override, or one of
 * the two probed Windows install locations), rather than assuming a fixed
 * install path — verified live: the exact same real detonation that failed
 * with this error before the fix completed successfully after it.
 */
export function deriveGitUsrBin(bashPath: string): string | null {
  const USR_BIN_BASH = "\\usr\\bin\\bash.exe";
  const BIN_BASH = "\\bin\\bash.exe";
  const lower = bashPath.toLowerCase();
  if (lower.endsWith(USR_BIN_BASH.toLowerCase())) {
    return bashPath.slice(0, -"\\bash.exe".length); // …\Git\usr\bin
  }
  if (lower.endsWith(BIN_BASH.toLowerCase())) {
    return `${bashPath.slice(0, -BIN_BASH.length)}\\usr\\bin`; // …\Git\bin\bash.exe -> …\Git\usr\bin
  }
  return null;
}
