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
import { analyzeOnSession, type AnalysisResult } from "./analyze";

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
        // git reads only the first block, so gzip may die of SIGPIPE on a large tarball:
        // the pipeline status is not used, only the commit id it prints.
        `c=$( { gzip -dc '${dest}' 2>/dev/null || true; } | git get-tar-commit-id || true); [ "$c" = '${gh.sha}' ] || { echo "commit id mismatch: '$c'" >&2; exit 3; }; stat -c %s '${dest}'`,
      { timeoutMs: timeoutMs + 5_000 },
    );
  } finally {
    await s.setEgress(restoreAllowOut);
  }
  if (r.exitCode !== 0) throw new EngineError("upstream", `the VM could not fetch ${gh.owner}/${gh.repo}@${gh.sha.slice(0, 12)} from codeload (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return { bytes: Number(r.stdout.trim()) || 0, ms: Date.now() - t0 };
}

/** The fence after the fetch: the template containment check passes and root cannot reach codeload. */
export async function proveFenceInVm(s: SandboxSession): Promise<{ ok: boolean; detail: string }> {
  const r = await s.run(
    // Wait until the harness finished bringing the forge up and ran its own probes (it
    // renames capture.jsonl to capture.probe.jsonl right before waiting for inputs): on a
    // 1 vCPU VM a small repo's fetch can finish first.
    // Then wait (at most 30 s) for the forge itself: its process and its listening port.
    // The pattern's bracket keeps pgrep from matching this shell, whose own command line
    // holds the pattern (a fresh VM's forge was not up yet, and the oldest match was this shell).
    `set -uo pipefail; for _ in $(seq 1 150); do [ -f /root/out/capture.probe.jsonl ] && break; sleep 0.2; done; ` +
      `pid=""; for _ in $(seq 1 150); do pid=$(pgrep -o -f 'mitmdum[p] --mode transparent' || true); [ -n "$pid" ] && ss -ltn 'sport = :8080' | grep -q LISTEN && break; pid=""; sleep 0.2; done; ` +
      `[ -n "$pid" ] || { echo "no forge process listening within 30 s"; exit 2; }; ` +
      `timeout 40 /opt/cr/bin/cr-proof.sh "$pid" /root/proof-after-fetch.txt; p=$?; ` +
      `if curl -sS --max-time 4 -o /dev/null https://${CODELOAD_HOST}/ 2>/dev/null; then c=OPEN; else c=CLOSED; fi; ` +
      // The proof's own test datagrams (uid 1001 UDP, ICMP) are counted by the fence's
      // drop rules, which the harness later reads as repo behaviour: zero those counters
      // (the rules themselves are untouched) and require every one to read 0 again.
      `echo "proof_exit=$p codeload=$c pass=$(grep -c '^PASS' /root/proof-after-fetch.txt) fail=$(grep -c '^FAIL' /root/proof-after-fetch.txt)"; grep '^FAIL' /root/proof-after-fetch.txt | head -5; ` +
      `[ "$p" = 0 ] && [ "$c" = CLOSED ]`,
    { timeoutMs: 50_000 },
  );
  return { ok: r.exitCode === 0, detail: (r.stdout + r.stderr).trim().slice(0, 600) };
}

/**
 * The fence's drop counters right before the go file. Between the containment proof
 * and this moment only root works in the VM (fetch, map, scanners: the fence covers
 * uid 1001 only), so every count so far, including a late-counted proof datagram, is
 * harness traffic. cr-detonate.sh subtracts this baseline when it reads the drops.
 */
export async function writeDropBaseline(s: SandboxSession): Promise<string> {
  const r = await s.run(
    `set -euo pipefail; sleep 0.3; u=$(/opt/cr/bin/cr-drops.sh cr_udp_drop); i=$(/opt/cr/bin/cr-drops.sh cr_icmp_drop); o=$(/opt/cr/bin/cr-drops.sh cr_other_drop); ` +
      `printf '{"udp":%s,"icmp":%s,"other":%s}\\n' "$u" "$i" "$o" > /root/in/drop-baseline.json; cat /root/in/drop-baseline.json`,
    { timeoutMs: 10_000 },
  );
  if (r.exitCode !== 0) throw new EngineError("internal", `recording the fence baseline failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return r.stdout.trim();
}

function toolSource(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/**
 * One extraction of the whole repo, then the map (reach graph + heuristics) and the
 * static scanners at the same time on that tree, all before any repo code runs.
 * Returns the view the models read, the graph, the heuristics, the scanner result.
 */
export async function mapAndScanInVm(
  s: SandboxSession,
  tarball: string,
  timeoutMs: number,
  scannerTimeoutMs: number,
  onLine?: (tool: "semgrep" | "guarddog" | "yara", stream: "stdout" | "stderr", text: string) => void,
): Promise<{ view: Uint8Array; stats: VmMapStats; graph: unknown; heur: unknown; analysis: AnalysisResult; ms: { extract: number; map: number; scan: number } }> {
  const t0 = Date.now();
  const [, , , , ex] = await Promise.all([
    s.writeFile("/root/map-tool/vm-map.mjs", toolSource("lib/engine/sandbox/vm-map.mjs")),
    s.writeFile("/root/map-tool/graph.ts", toolSource("lib/engine/reach/graph.ts").replace('from "../archive"', 'from "./archive.ts"')),
    s.writeFile("/root/map-tool/heuristics.ts", toolSource("lib/engine/static/heuristics.ts").replace('from "../archive"', 'from "./archive.ts"')),
    s.writeFile("/root/map-tool/archive.ts", toolSource("lib/engine/archive.ts")),
    s.run(
      `set -euo pipefail; rm -rf /root/map /root/view.tgz /root/view.list; mkdir -p /root/map; ` +
        `tar --no-same-owner --no-same-permissions --strip-components=1 -xzf '${tarball}' -C /root/map; ` +
        `e=""; [ -f /root/map/package.json ] && e="npm"; { [ -f /root/map/pyproject.toml ] || [ -f /root/map/setup.py ] || [ -f /root/map/requirements.txt ]; } && e="$e python"; echo "$e"`,
      { timeoutMs },
    ),
  ]);
  if (ex.exitCode !== 0) throw new EngineError("internal", `extracting the repo in the VM failed: ${(ex.stderr || ex.stdout).trim().slice(0, 300)}`);
  const ecosystems = ex.stdout.trim().split(/\s+/).filter((x): x is "npm" | "python" => x === "npm" || x === "python");
  const tExtract = Date.now() - t0;
  const tMap0 = Date.now();
  const mapP = s
    .run(
      `set -euo pipefail; cd /root/map-tool && /opt/cr/node/bin/node --max-old-space-size=1400 vm-map.mjs /root/map /root/view.list /root/map.json; ` +
        `tar -C /root/map --null -T /root/view.list --transform 's,^,view/,' -czf /root/view.tgz`,
      { timeoutMs },
    )
    .then((r) => ({ r, ms: Date.now() - tMap0 }));
  const tScan0 = Date.now();
  const scanP = analyzeOnSession(s, { ecosystems: ecosystems.length > 0 ? ecosystems : ["npm"], commandTimeoutMs: scannerTimeoutMs, srcDir: "/root/map", outDir: "/root/aout" }, { onLine }).then((a) => ({ a, ms: Date.now() - tScan0 }));
  const [{ r, ms: mapMs }, { a, ms: scanMs }] = await Promise.all([mapP, scanP]);
  await s.run("rm -rf /root/map /root/aout", { timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new EngineError("internal", `mapping the repo in the VM failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  const [view, json] = await Promise.all([s.readFile("/root/view.tgz"), s.readFile("/root/map.json")]);
  const out = JSON.parse(new TextDecoder().decode(json)) as { stats: VmMapStats; graph: unknown; heur: unknown };
  return { view, stats: out.stats, graph: out.graph, heur: out.heur, analysis: a, ms: { extract: tExtract, map: mapMs, scan: scanMs } };
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
