import { test } from "node:test";
import assert from "node:assert/strict";
import { contentSecurityPolicy } from "../lib/csp.ts";

function directive(csp: string, name: string): string[] {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  return d ? d.split(/\s+/).slice(1) : [];
}

test("CSP lets the AdSense loader, ad iframes and reporting calls through, and Supabase Realtime over wss", () => {
  const csp = contentSecurityPolicy();
  const script = directive(csp, "script-src");
  assert.ok(script.includes("https://pagead2.googlesyndication.com"), "AdSense loader script");
  assert.ok(script.includes("https://*.googlesyndication.com"));
  const frame = directive(csp, "frame-src");
  for (const o of ["https://googleads.g.doubleclick.net", "https://tpc.googlesyndication.com", "https://*.google.com"]) assert.ok(frame.includes(o), o);
  const connect = directive(csp, "connect-src");
  for (const o of ["https://pagead2.googlesyndication.com", "https://*.google.com", "https://*.doubleclick.net", "wss://*.supabase.co", "https://*.supabase.co"]) assert.ok(connect.includes(o), o);
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
  assert.ok(directive(csp, "img-src").includes("https:"));
});
