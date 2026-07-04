import { test } from "node:test";
import assert from "node:assert/strict";
import { safeJsonLd } from "../lib/json-ld.ts";

// The stored-XSS payload an attacker controls: name a repo (or craft a captured
// network hostname) so the LLM summary echoes this, and it lands in `reviewBody`
// of the JSON-LD `<script>` on the public /owner/repo report page.
const BREAKOUT = `</script><script>alert(document.domain)</script>`;

/**
 * Un-escape ONLY the `\uXXXX` sequences `safeJsonLd` introduces, mirroring what
 * a real browser/JSON parser does automatically when it reads the raw script
 * text. This lets a test parse the served bytes exactly as a consumer would.
 */
function unescapeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

test("EXPLOIT NEUTRALIZED: a </script> breakout in reviewBody never survives serialization", () => {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Review",
    reviewBody: `Repo looks fine. ${BREAKOUT}`,
  };
  const out = safeJsonLd(ld);

  // The core assertion: the literal byte sequence the HTML tokenizer scans for
  // (`</script`, case-insensitive) MUST NOT appear in the served string. If it
  // did, the browser would close the JSON-LD <script> early and run the payload.
  assert.ok(
    !/<\/script/i.test(out),
    "served JSON-LD must contain no literal </script sequence: " + out,
  );
  // Belt and suspenders: no bare `<` at all (so `<!--` and any `<tag` are dead too).
  assert.ok(!out.includes("<"), "no literal < may reach the HTML: " + out);
  assert.ok(!out.includes(">"), "no literal > may reach the HTML: " + out);
  // The dangerous bytes are present, but only in their inert escaped form.
  assert.ok(out.includes("\\u003c") && out.includes("\\u003e"), out);
});

test("naked JSON.stringify (the OLD vulnerable path) DOES leak the breakout — proves the test is real", () => {
  const ld = { reviewBody: BREAKOUT };
  // This is exactly what the page did before the fix. It MUST still contain the
  // breakout, confirming the payload is genuinely dangerous and our fix is what
  // removes it (not a payload that was harmless to begin with).
  assert.ok(
    /<\/script/i.test(JSON.stringify(ld)),
    "sanity: the pre-fix path is supposed to be vulnerable",
  );
});

test("DATA INTEGRITY: escaped output parses back to the ORIGINAL object for legitimate consumers", () => {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Review",
    reviewBody: `Attempting to reach </script><script>evil</script> & other hosts`,
    reviewRating: { ratingValue: 25, bestRating: 100 },
  };
  const out = safeJsonLd(ld);

  // A browser/crawler unescapes the \uXXXX sequences as part of normal JSON
  // parsing, then parses. Emulate exactly that: unescape, then JSON.parse.
  const roundTripped = JSON.parse(unescapeUnicode(out));

  // The reconstructed object is byte-for-byte the original — the literal
  // `</script>` and `&` are intact for Google's structured-data parser, screen
  // readers, etc. We escaped the WIRE bytes, not the DATA.
  assert.deepEqual(roundTripped, ld);
  assert.equal(
    roundTripped.reviewBody,
    `Attempting to reach </script><script>evil</script> & other hosts`,
    "the literal </script> is preserved for legitimate JSON-LD consumers",
  );

  // And parsing the ESCAPED string directly (JSON.parse decodes \uXXXX itself,
  // exactly like any conforming parser) also yields the original — the escapes
  // are valid JSON, not a corruption of the payload.
  assert.deepEqual(JSON.parse(out), ld);
});

test("U+2028 / U+2029 line separators are escaped (valid JSON, but unsafe raw in a script that may be eval'd)", () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const ld = { reviewBody: `line${LS}sep${PS}here` };
  const out = safeJsonLd(ld);

  assert.ok(!out.includes(LS) && !out.includes(PS), "no raw U+2028/U+2029 in output: " + out);
  assert.ok(out.includes("\\u2028") && out.includes("\\u2029"), out);
  // Still round-trips to the original.
  assert.deepEqual(JSON.parse(out), ld);
});

test("ampersand is escaped for defense in depth but preserved as data", () => {
  const ld = { reviewBody: "Tom & Jerry <3" };
  const out = safeJsonLd(ld);
  assert.ok(!out.includes("&"), "no literal & in output: " + out);
  assert.ok(!out.includes("<"), "no literal < in output: " + out);
  assert.equal((JSON.parse(out) as { reviewBody: string }).reviewBody, "Tom & Jerry <3");
});

test("benign JSON-LD is unchanged apart from having no unsafe chars to escape", () => {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Review",
    name: "owner/repo ClaudeRabbit safety report",
    reviewBody: "No malicious behavior observed in our tests. Owner account is new.",
  };
  const out = safeJsonLd(ld);
  // Nothing to escape here, so it equals plain JSON.stringify — no gratuitous change.
  assert.equal(out, JSON.stringify(ld));
  assert.deepEqual(JSON.parse(out), ld);
});
