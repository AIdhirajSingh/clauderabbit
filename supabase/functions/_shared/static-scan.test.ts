/**
 * Unit tests for the static-scan heuristics — focused on the obfuscation-signal
 * PRECISION fix: legitimate dynamic-code (`new Function('…')`) must NOT trip the
 * binary `obfuscation` signal (which auto-escalates and weighs -42), while real
 * obfuscation (eval-of-decoded, long base64 blobs) still must.
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
