/**
 * Whole-repo fetch inside the VMs (docs/runs/2.0-keyday.md step 12). A GitHub repo
 * of any size is downloaded by the VMs themselves, never by the Vercel function:
 *
 *  1. Egress opens to exactly `codeload.github.com` on top of the VM's own allow list
 *     (registries for the detonation VM, nothing for the analysis VM), root downloads
 *     the commit's tarball and checks its embedded commit id against the pinned SHA,
 *     and egress is restored to the previous list in `finally`. No repo code exists
 *     yet. Repo traffic from uid 1001 is redirected to the forge by the inner fence
 *     whatever the outer list says; the outer list only ever opened for root.
 *  2. Before any input reaches the harness, the fence is proven again in the
 *     detonation VM: the template's own containment check (`cr-proof.sh`, which makes
 *     forged non-registry calls as uid 1001 and asserts the drop counters) must pass,
 *     and a root request to codeload must fail. Failing either stops the scan.
 *  3. The detonation VM maps the whole repo with the engine's reach graph
 *     (`vm-map.mjs` + `reach/graph.ts`) and returns only what the models and the
 *     scorers read: every reachable text file plus manifests, lockfiles and READMEs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../types";
import type { SandboxSession } from "./provider";

export const CODELOAD_HOST = "codeload.github.com";
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface VmFetchResult {
  bytes: number;
  ms: number;
}

export interface VmMapStats {
  files: number;
  bytes: number;
  binary: number;
  links: number;
  big_reachable: string[];
  big_reachable_count: number;
  reach: { install: number; import: number; unreachable: number };
  unbounded: boolean;
  ecosystems: string[];
  view_files: number;
  view_bytes: number;
  view_over_budget: number;
  heuristic_findings: number;
  capabilities: number;
}

export function codeloadUrlFor(owner: string, repo: string, sha: string): string {
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || !SHA_RE.test(sha)) throw new EngineError("invalid_target", "owner, repo or SHA has an unexpected shape");
  return `https://${CODELOAD_HOST}/${owner}/${repo}/tar.gz/${sha}`;
}

/** Download the commit tarball as root with egress opened to codeload only, then restore it. */
export async function fetchRepoInVm(
  s: SandboxSession,
  gh: { owner: string; repo: string; sha: string },
  restoreAllowOut: readonly string[],
  dest: string,
  timeoutMs: number,
): Promise<VmFetchResult> {
  if (!s.setEgress) throw new EngineError("internal", "this sandbox provider cannot change egress, so the VM cannot fetch the repo");
  const url = codeloadUrlFor(gh.owner, gh.repo, gh.sha);
  const t0 = Date.now();
  await s.setEgress([...restoreAllowOut, CODELOAD_HOST]);
  let r;
  try {
    r = await s.run(
      `set -euo pipefail; mkdir -p "$(dirname '${dest}')"; curl -fsS --proto '=https' --max-time ${Math.ceil(timeoutMs / 1000)} -o '${dest}' '${url}'; ` +
        `c=$(gzip -dc '${dest}' | git get-tar-commit-id); [ "$c" = '${gh.sha}' ] || { echo "commit id $c" >&2; exit 3; }; stat -c %s '${dest}'`,
      { timeoutMs: timeoutMs + 5_000 },
    );
  } finally {
    await s.setEgress(restoreAllowOut);
  }
  if (r.exitCode !== 0) throw new EngineError("upstream", `the VM could not fetch ${gh.owner}/${gh.repo}@${gh.sha.slice(0, 12)} from codeload: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return { bytes: Number(r.stdout.trim()) || 0, ms: Date.now() - t0 };
}

/** The fence after the fetch: the template containment check passes and root cannot reach codeload. */
export async function proveFenceInVm(s: SandboxSession): Promise<{ ok: boolean; detail: string }> {
  const r = await s.run(
    `set -uo pipefail; pid=$(pgrep -o -f mitmdump || true); [ -n "$pid" ] || { echo "no forge process"; exit 2; }; ` +
      `timeout 40 /opt/cr/bin/cr-proof.sh "$pid" /root/proof-after-fetch.txt; p=$?; ` +
      `if curl -sS --max-time 4 -o /dev/null https://${CODELOAD_HOST}/ 2>/dev/null; then c=OPEN; else c=CLOSED; fi; ` +
      `echo "proof_exit=$p codeload=$c pass=$(grep -c '^PASS' /root/proof-after-fetch.txt) fail=$(grep -c '^FAIL' /root/proof-after-fetch.txt)"; grep '^FAIL' /root/proof-after-fetch.txt | head -5; ` +
      `[ "$p" = 0 ] && [ "$c" = CLOSED ]`,
    { timeoutMs: 50_000 },
  );
  return { ok: r.exitCode === 0, detail: (r.stdout + r.stderr).trim().slice(0, 600) };
}

function toolSource(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Upload the map tool, map the whole extracted repo, and return the view tarball, graph, heuristics and stats. */
export async function mapRepoInVm(s: SandboxSession, tarball: string, timeoutMs: number): Promise<{ view: Uint8Array; stats: VmMapStats; graph: unknown; heur: unknown }> {
  await Promise.all([
    s.writeFile("/root/map-tool/vm-map.mjs", toolSource("lib/engine/sandbox/vm-map.mjs")),
    s.writeFile("/root/map-tool/graph.ts", toolSource("lib/engine/reach/graph.ts").replace('from "../archive"', 'from "./archive.ts"')),
    s.writeFile("/root/map-tool/heuristics.ts", toolSource("lib/engine/static/heuristics.ts").replace('from "../archive"', 'from "./archive.ts"')),
    s.writeFile("/root/map-tool/archive.ts", toolSource("lib/engine/archive.ts")),
  ]);
  const r = await s.run(
    `set -euo pipefail; rm -rf /root/map /root/view.tgz /root/view.list; mkdir -p /root/map; ` +
      `tar --no-same-owner --no-same-permissions --strip-components=1 -xzf '${tarball}' -C /root/map; ` +
      `cd /root/map-tool && /opt/cr/node/bin/node --max-old-space-size=1400 vm-map.mjs /root/map /root/view.list /root/map.json; ` +
      `tar -C /root/map --null -T /root/view.list --transform 's,^,view/,' -czf /root/view.tgz; rm -rf /root/map`,
    { timeoutMs },
  );
  if (r.exitCode !== 0) throw new EngineError("internal", `mapping the repo in the VM failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  const [view, json] = await Promise.all([s.readFile("/root/view.tgz"), s.readFile("/root/map.json")]);
  const out = JSON.parse(new TextDecoder().decode(json)) as { stats: VmMapStats; graph: unknown; heur: unknown };
  return { view, stats: out.stats, graph: out.graph, heur: out.heur };
}

/** The analysis VM's copy, repacked without the codeload top directory (cr-analyze.sh extracts src.tgz as is). */
export async function repackForAnalysis(s: SandboxSession, from: string, timeoutMs: number): Promise<void> {
  const r = await s.run(
    `set -euo pipefail; rm -rf /root/full && mkdir -p /root/full; tar --no-same-owner --no-same-permissions --strip-components=1 -xzf '${from}' -C /root/full; ` +
      `tar -C /root/full -czf /root/in/src.tgz .; rm -rf /root/full '${from}'`,
    { timeoutMs },
  );
  if (r.exitCode !== 0) throw new EngineError("internal", `preparing the analysis copy failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
}
