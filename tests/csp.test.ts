import { test } from "node:test";
import assert from "node:assert/strict";
import { contentSecurityPolicy } from "../lib/csp.ts";

function directive(csp: string, name: string): string[] {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  return d ? d.split(/\s+/).slice(1) : [];
}

/** CSP source-list matching for scheme and host sources (CSP3 section 6.7.2.5 subset). */
function allows(sources: string[], url: string): boolean {
  const u = new URL(url);
  return sources.some((src) => {
    if (src === `${u.protocol}`) return true;
    const m = /^(https?:|wss?:)\/\/(\*\.)?([^/:]+)$/.exec(src);
    if (!m) return false;
    if (m[1] !== u.protocol) return false;
    return m[2] ? u.hostname.endsWith(`.${m[3]}`) : u.hostname === m[3];
  });
}

// Origins the GPT rewarded ad and the AdSense unit contact (Google's tags, their
// ad iframes and their beacons); Google documents no fixed list, see lib/csp.ts.
const GPT_SCRIPT = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
const ADSENSE_SCRIPT = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456";
const AD_HOSTS = [
  "https://securepubads.g.doubleclick.net",
  "https://pagead2.googlesyndication.com",
  "https://tpc.googlesyndication.com",
  "https://googleads.g.doubleclick.net",
  "https://www.google.com",
  "https://fundingchoicesmessages.google.com",
  "https://ep1.adtrafficquality.google",
  "https://ep2.adtrafficquality.google",
  "https://www.googletagservices.com",
  "https://s0.2mdn.net",
];

test("CSP admits the GPT and AdSense loaders, their ad iframes and beacons, in Google's supported no-nonce form", () => {
  const csp = contentSecurityPolicy();
  const script = directive(csp, "script-src");
  assert.ok(allows(script, GPT_SCRIPT), "gpt.js");
  assert.ok(allows(script, ADSENSE_SCRIPT), "adsbygoogle.js");
  for (const k of ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:"]) assert.ok(script.includes(k), k);
  assert.ok(!script.includes("http:"), "no cleartext script source");
  const frame = directive(csp, "frame-src");
  const connect = directive(csp, "connect-src");
  const img = directive(csp, "img-src");
  for (const o of AD_HOSTS) {
    assert.ok(allows(frame, `${o}/x`), `frame ${o}`);
    assert.ok(allows(connect, `${o}/x`), `connect ${o}`);
    assert.ok(allows(img, `${o}/x`), `img ${o}`);
  }
  assert.ok(!allows(script, "http://securepubads.g.doubleclick.net/tag/js/gpt.js"), "cleartext gpt.js refused");
});

test("CSP keeps Supabase https and wss, and the hardening directives", () => {
  const csp = contentSecurityPolicy();
  const connect = directive(csp, "connect-src");
  for (const o of ["wss://*.supabase.co", "https://*.supabase.co", "wss://*.supabase.in"]) assert.ok(connect.includes(o), o);
  assert.ok(allows(connect, "wss://abc.supabase.co/realtime/v1"));
  assert.ok(!allows(connect, "wss://evil.example/socket"), "no arbitrary websocket");
  assert.deepEqual(directive(csp, "default-src"), ["'self'"]);
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
  assert.deepEqual(directive(csp, "base-uri"), ["'self'"]);
  assert.deepEqual(directive(csp, "form-action"), ["'self'"]);
});
