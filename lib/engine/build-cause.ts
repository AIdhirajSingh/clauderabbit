/**
 * Why a build did not finish, in one plain clause, read from the run's own record: the harness checks, the install's
 * stderr and the forge's calls. Appended to the partial-scan line ("Build failed, so the program never ran: …").
 * Null when the record shows no specific cause. Nothing here changes what the forge answers.
 */

import type { ForgedCallData } from "./types";

export interface BuildRecord {
  install: string;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  installStderr: string;
  forgedCalls: ForgedCallData[];
}

/** Package registries the forge passes through; a call to one is never the cause. */
const REGISTRY_HOST = /(^|\.)(registry\.npmjs\.org|registry\.yarnpkg\.com|npmjs\.com|pypi\.org|files\.pythonhosted\.org|proxy\.golang\.org|sum\.golang\.org|crates\.io|static\.crates\.io|index\.crates\.io)$/i;

export function buildCause(r: BuildRecord): string | null {
  if (r.install !== "failed" && r.install !== "timeout") return null;
  const limit = r.checks.find((c) => c.name === "install_limit" && !c.ok);
  if (limit?.detail) return limit.detail;
  if (/No space left on device/i.test(r.installStderr)) return "the sandbox disk filled up during the install";
  // A build that downloaded a file from a host the forge answers (not a registry) got the forge's stand-in reply.
  const forgedHosts = new Set(r.forgedCalls.filter((c) => c.phase === "install" && !REGISTRY_HOST.test(c.host)).map((c) => c.host.toLowerCase()));
  for (const m of r.installStderr.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(\/[^\s"'<>)]*)?/g)) {
    const host = m[1]!.toLowerCase();
    if (forgedHosts.has(host)) {
      const url = `https://${host}${(m[2] ?? "").slice(0, 120)}`;
      return `the build downloaded ${url}, and the sandbox forge answers ${host} with a stand-in, so the download was not usable`;
    }
  }
  return null;
}
