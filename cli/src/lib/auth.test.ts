import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "./auth.ts";

// The sign-in callback page is in the site's v4 design (black, Figtree, the white logo
// tile with the rabbit mark), not the retired warm-dark serif page.
test("the callback page uses the v4 design and declares UTF-8", () => {
  for (const ok of [true, false]) {
    const html = renderPage(ok);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /background:#000/);
    assert.match(html, /family=Figtree/);
    assert.match(html, /class="mark"[^>]*><svg[^>]*viewBox="-340\.4 -340\.4 680\.8 680\.8"/);
    assert.doesNotMatch(html, /Instrument\+Serif|#16130f/);
  }
  assert.match(renderPage(true), /<h1>Connected<\/h1>/);
  assert.match(renderPage(false), /<code>clauderabbit login<\/code>/);
});
