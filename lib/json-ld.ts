/**
 * Safe serialization of JSON-LD for embedding inside an inline `<script>` tag.
 *
 * The report page emits a schema.org `Review` block as
 * `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ... }} />`.
 * Its `reviewBody` is the report summary — LLM-generated text that can echo
 * attacker-influenced content: a repo owner/name/README read during a static
 * scan, or (worse) a sandbox-captured hostname from a detonated repo's own
 * network attempt (`attempting to reach <capturedHost>`), threaded through the
 * attach-forensics edge function into the `reports.summary` column with no
 * HTML-level filtering.
 *
 * `JSON.stringify` escapes JS/JSON string syntax but does NOT escape `<`, `>`,
 * or `/`. Inside a `<script>` element the browser's HTML tokenizer treats the
 * script body as raw text and scans for the literal byte sequence `</script`
 * to end the element — it does not care that those bytes sit inside a JSON
 * string. So a summary containing `</script><script>alert(1)</script>` would
 * close the legitimate JSON-LD script early and inject live, executing markup
 * onto a public, unauthenticated, SEO-indexed, ISR-cached page. CSP allows
 * `'unsafe-inline'`, so it is no backstop. This is stored XSS.
 *
 * The fix is the well-established pattern used by Next.js itself and libraries
 * like `serialize-javascript`: after `JSON.stringify`, replace the characters
 * that could form an HTML control sequence with their `\uXXXX` escapes:
 *   - `<`      -> `<`  (neutralizes `</script` and `<!--`)
 *   - `>`      -> `>`  (defense in depth: never leaves a bare `>`)
 *   - `&`      -> `&`  (defense in depth vs. entity/sniffing edge cases)
 *   - U+2028   -> ` `  (line separator)
 *   - U+2029   -> ` `  (paragraph separator) — both are valid JSON but a
 *     RAW U+2028/U+2029 byte is a syntax error inside a JS string literal, and
 *     some consumers evaluate JSON-LD as JavaScript
 *
 * These are Unicode escape sequences *inside a JSON string literal*: any JSON
 * parser (Google's structured-data parser, screen readers, `JSON.parse`)
 * decodes `<` back to `<`, so the JSON-LD data is byte-for-byte preserved
 * for legitimate consumers. Only the raw bytes served in the HTML change — the
 * literal `<` never appears where an HTML tokenizer could act on it.
 */

/**
 * Characters that must never appear literally in text embedded in a `<script>`
 * body, mapped to their JSON `\uXXXX` escape. The regex uses `\u` escapes (not
 * raw literals) so the two invisible line/paragraph separators stay legible in
 * source; the replacer looks each matched char up by code point.
 */
const JSON_LD_UNSAFE = /[<>&\u2028\u2029]/g;

const JSON_LD_ESCAPES: Record<string, string> = {
  "<": "\\u003c", // <
  ">": "\\u003e", // >
  "&": "\\u0026", // &
  ["\u2028"]: "\\u2028", // line separator
  ["\u2029"]: "\\u2029", // paragraph separator
};

/**
 * Serialize an object to a JSON string that is safe to place directly inside an
 * inline `<script>` tag via `dangerouslySetInnerHTML`.
 *
 * The output is valid JSON (and valid JSON-LD): every substituted character is
 * a `\uXXXX` escape that decodes back to the original on parse. It is impossible
 * for the returned string to contain a literal `<`, `>`, or `&`, so no
 * `</script>` (or `<!--`) breakout can survive HTML tokenization.
 */
export function safeJsonLd(obj: unknown): string {
  // Every char the regex matches is a key in JSON_LD_ESCAPES, so the lookup is
  // always defined; the `?? ch` keeps this total under `noUncheckedIndexedAccess`
  // and is a safe no-op even if the two ever drift apart.
  return JSON.stringify(obj).replace(JSON_LD_UNSAFE, (ch) => JSON_LD_ESCAPES[ch] ?? ch);
}
