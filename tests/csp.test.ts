import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONTENT_SECURITY_POLICY, makeNonce, pageContentSecurityPolicy } from "../lib/csp.ts";

const ROOT = join(import.meta.dirname, "..");

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

/**
 * How a CSP3 browser decides whether a script may run under this policy:
 * 'strict-dynamic' present means host and scheme sources and 'unsafe-inline'
 * are ignored, so only a matching nonce (or a script created by a trusted
 * script) runs.
 */
function csp3AllowsParserInsertedScript(script: string[], nonceAttr: string | null): boolean {
  const nonces = script.filter((s) => s.startsWith("'nonce-")).map((s) => s.slice(7, -1));
  if (nonceAttr !== null && nonces.includes(nonceAttr)) return true;
  if (script.includes("'strict-dynamic'")) return false;
  return script.includes("'unsafe-inline'");
}

// Hosts the GPT rewarded overlay and the AdSense unit used on the 2.0 preview (key day steps 5 and 8).
const AD_FRAME_AND_BEACON_HOSTS = [
  "https://securepubads.g.doubleclick.net",
  "https://cm.g.doubleclick.net",
  "https://googleads.g.doubleclick.net",
  "https://pagead2.googlesyndication.com",
  "https://tpc.googlesyndication.com",
  "https://35e88bb3103f27cb0cd09da6f8a3afda.safeframe.googlesyndication.com",
  "https://www.google.com",
  "https://fundingchoicesmessages.google.com",
  "https://ep1.adtrafficquality.google",
  "https://ep2.adtrafficquality.google",
];

test("nonces are 128-bit, base64, and different every time", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const n = makeNonce();
    assert.match(n, /^[A-Za-z0-9+/]{22}==$/);
    seen.add(n);
  }
  assert.equal(seen.size, 200);
  assert.throws(() => pageContentSecurityPolicy("bad nonce'; script-src *"), /invalid CSP nonce/);
});

test("page policy is Google's supported strict form: nonce + strict-dynamic, https: and unsafe-inline only as CSP2 fallbacks", () => {
  const nonce = makeNonce();
  const csp = pageContentSecurityPolicy(nonce);
  const script = directive(csp, "script-src");
  assert.deepEqual(script, [`'nonce-${nonce}'`, "'strict-dynamic'", "https:", "'unsafe-inline'"]);
  assert.ok(!script.includes("'unsafe-eval'"), "no eval in production");
  assert.ok(!script.includes("'self'"), "no host allowlist for scripts");
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
  assert.deepEqual(directive(csp, "base-uri"), ["'none'"]);
  assert.deepEqual(directive(csp, "default-src"), ["'self'"]);
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(csp, "form-action"), ["'self'"]);
  // CSP3 semantics: the nonced Next.js scripts run; an injected inline script without it does not,
  // even though 'unsafe-inline' and https: are present (strict-dynamic voids them).
  assert.equal(csp3AllowsParserInsertedScript(script, nonce), true);
  assert.equal(csp3AllowsParserInsertedScript(script, null), false);
  assert.equal(csp3AllowsParserInsertedScript(script, makeNonce()), false);
  const dev = directive(pageContentSecurityPolicy(nonce, { dev: true }), "script-src");
  assert.ok(dev.includes("'unsafe-eval'"), "React dev tooling needs eval in development only");
});

test("page policy admits the ad frames, beacons, overlay fonts and video, and nothing broader than https hosts it names", () => {
  const csp = pageContentSecurityPolicy(makeNonce());
  const frame = directive(csp, "frame-src");
  const connect = directive(csp, "connect-src");
  for (const o of AD_FRAME_AND_BEACON_HOSTS) {
    assert.ok(allows(frame, `${o}/x`), `frame ${o}`);
    assert.ok(allows(connect, `${o}/x`), `connect ${o}`);
  }
  assert.ok(!frame.includes("https:"), "frame-src is a host list");
  assert.ok(!connect.includes("https:"), "connect-src is a host list");
  assert.ok(!allows(frame, "https://evil.example/x"));
  assert.ok(!allows(connect, "https://evil.example/x"));
  assert.ok(allows(directive(csp, "style-src"), "https://fonts.googleapis.com/css?family=Roboto"), "overlay stylesheet");
  assert.ok(!allows(directive(csp, "style-src"), "https://evil.example/x.css"));
  assert.ok(allows(directive(csp, "font-src"), "https://fonts.gstatic.com/s/roboto/v1/x.woff2"), "overlay font");
  const media = directive(csp, "media-src");
  assert.ok(allows(media, "https://redirector.gvt1.com/videoplayback/file.mp4"), "video creative");
  assert.ok(allows(media, "https://rr3---sn-a5mekn6s.googlevideo.com/videoplayback"), "video creative after redirect");
  assert.ok(media.includes("blob:"), "MSE video");
  assert.ok(!media.includes("https:"), "media-src is a host list");
  // The app shows avatars from arbitrary OAuth CDNs; images cannot run script.
  assert.ok(allows(directive(csp, "img-src"), "https://avatars.githubusercontent.com/u/1"));
});

test("page policy keeps Supabase https and wss and no other websocket", () => {
  const connect = directive(pageContentSecurityPolicy(makeNonce()), "connect-src");
  for (const o of ["wss://*.supabase.co", "https://*.supabase.co", "wss://*.supabase.in"]) assert.ok(connect.includes(o), o);
  assert.ok(allows(connect, "wss://abc.supabase.co/realtime/v1"));
  assert.ok(!allows(connect, "wss://evil.example/socket"), "no arbitrary websocket");
});

test("JSON and protocol routes get a load-nothing policy; the proxy and next.config split the routes without overlap", () => {
  assert.deepEqual(directive(API_CONTENT_SECURITY_POLICY, "default-src"), ["'none'"]);
  assert.deepEqual(directive(API_CONTENT_SECURITY_POLICY, "frame-ancestors"), ["'none'"]);
  const proxySrc = readFileSync(join(ROOT, "proxy.ts"), "utf8");
  const m = /source:\s*\n?\s*"([^"]+)"/.exec(proxySrc);
  assert.ok(m, "proxy matcher source");
  const matcher = new RegExp(`^${m[1]!.replace(/\\\\/g, "\\")}$`);
  const pages = ["/", "/expressjs/express", "/npm/left-pad", "/npm/@scope/name", "/privacy", "/terms", "/cli-auth", "/oauth/authorize", "/auth/callback"];
  for (const p of pages) assert.ok(matcher.test(p), `proxy runs on page ${p}`);
  const apis = ["/api/scan", "/api/report", "/api/ops/smoke", "/mcp", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/badge/o/r", "/_next/static/chunks/x.js", "/icon.png"];
  for (const p of apis) assert.ok(!matcher.test(p), `proxy skips ${p}`);
  const cfg = readFileSync(join(ROOT, "next.config.ts"), "utf8");
  for (const src of ["/api/:path*", "/mcp", "/oauth/token", "/oauth/register", "/.well-known/:path*"]) assert.ok(cfg.includes(`"${src}"`), `next.config API CSP for ${src}`);
  assert.ok(!/contentSecurityPolicy\(\)/.test(cfg), "no static page CSP in next.config (it would stack with the nonce policy)");
});

test("the root layout reads the nonce and stamps the inline theme script", () => {
  const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
  assert.match(layout, /\(await headers\(\)\)\.get\("x-nonce"\)/);
  assert.match(layout, /<script nonce=\{nonce\} dangerouslySetInnerHTML=\{\{ __html: themeInitScript \}\} \/>/);
  const proxySrc = readFileSync(join(ROOT, "proxy.ts"), "utf8");
  assert.match(proxySrc, /headers\.set\("x-nonce", nonce\)/);
  assert.match(proxySrc, /headers\.set\("content-security-policy", csp\)/, "Next.js reads the nonce from the request CSP header");
  assert.match(proxySrc, /res\.headers\.set\("Content-Security-Policy", csp\)/);
});
