/**
 * Unit tests for summary reconciliation (summary.ts): the report summary must never
 * contradict the computed score/verdict.
 *
 * Run: `deno test supabase/functions/_shared/summary.test.ts`
 */
import { reconcileSummary } from "./summary.ts";
import type { ScoreDelta } from "./scoring.ts";

function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

const fixtureBreakdown: ScoreDelta[] = [
  { factor: "credential_access", delta: -40, detail: "Code references credential paths (SSH keys, cloud credentials, .npmrc, or bulk env read).", group: "code" },
  { factor: "install_time_network", delta: -35, detail: "Network/shell activity wired into an install-time hook (runs on install, before import).", group: "code" },
  { factor: "new_owner", delta: -5, detail: "Owner account is new.", group: "reputation" },
];

// The exact contradiction reported on AIdhirajSingh/cr-exfil-test-fixture (0/100 Malicious).
const fixtureModel = "This repository is a transparently documented security test fixture designed to validate sandbox containment. " +
  "The flagged behaviors (postinstall network activity and credential file access) are explicitly disclosed in the README and are consistent with the project's stated purpose as a synthetic test case. " +
  "No malicious intent is observed; however, users should exercise caution as this code is intentionally designed to simulate exfiltration behavior.";

Deno.test("Malicious: denial of malice is removed, test-fixture context and reasons stay", () => {
  const s = reconcileSummary(fixtureModel, "Malicious", 0, fixtureBreakdown);
  assert(!/no malicious/i.test(s), s);
  assert(s.startsWith("Scored 0/100 (Malicious)."), s);
  assert(/credential paths/.test(s) && /install-time hook/.test(s), "reasons missing: " + s);
  assert(/test fixture/.test(s), "fixture context dropped: " + s);
  assert(!/Owner account is new/.test(s), "reputation must not be listed as what the code does");
});

Deno.test("High risk: 'appears safe' and 'no malicious' are removed", () => {
  const s = reconcileSummary("The tool appears safe. No malicious behavior was found. It installs a daemon.", "High risk", 33, fixtureBreakdown);
  assert(!/appears safe/i.test(s) && !/no malicious/i.test(s), s);
  assert(/installs a daemon/.test(s), s);
});

Deno.test("Caution: safety claims removed, honest 'no malicious behavior observed' kept", () => {
  const s = reconcileSummary("No malicious behavior was observed in the static read. It is perfectly safe to use.", "Caution", 64, fixtureBreakdown);
  assert(/No malicious behavior was observed/.test(s), s);
  assert(!/safe to use/i.test(s), s);
});

Deno.test("Trusted: un-negated malice claims removed, negated ones kept", () => {
  const s = reconcileSummary("A well-known utility. It is malicious. It does not exfiltrate data and contains no malware.", "Trusted", 100, []);
  assert(!/It is malicious\./.test(s), s);
  assert(/contains no malware/.test(s), s);
  assert(s.startsWith("Scored 100/100 (Trusted). No code signals were flagged"), s);
});

Deno.test("every band: a consistent summary keeps all its sentences", () => {
  for (const [v, sc] of [["Trusted", 95], ["Likely safe", 85], ["Caution", 70], ["High risk", 40], ["Malicious", 10]] as const) {
    const s = reconcileSummary("It parses JSON files. It reads a config file.", v, sc, []);
    assert(/parses JSON files/.test(s) && /reads a config file/.test(s), `${v}: ${s}`);
  }
});

Deno.test("Malicious: 'allows for a higher trust score' is removed; 'do not trust' kept", () => {
  const m = "This repository is a self-declared security test fixture. " +
    "While the owner is not established and the code performs high-risk actions, the context of a security-tooling test fixture allows for a higher trust score than a standard application. " +
    "Do not trust this code outside a sandbox.";
  const s = reconcileSummary(m, "Malicious", 0, fixtureBreakdown);
  assert(!/higher trust score/.test(s), s);
  assert(/Do not trust this code/.test(s) && /test fixture/.test(s), s);
});
