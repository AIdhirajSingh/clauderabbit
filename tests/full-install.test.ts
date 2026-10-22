import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_DEADLINES, deadlineViolations, fullInstallDeadlines } from "../lib/engine/config";
import { parseScanBody } from "../lib/server/scan-service";
import { ADS } from "../lib/ads-config";

test("full-install deadlines give the install 180 s; the command and VM cover it; the scan deadline stays", () => {
  const d = fullInstallDeadlines(DEFAULT_DEADLINES);
  assert.equal(d.installMs, 180_000);
  assert.equal(d.scanMs, DEFAULT_DEADLINES.scanMs, "the scan deadline does not grow past the route's 300 s");
  // Only the serial-path rule is knowingly broken: the scan deadline is the real bound.
  assert.deepEqual(deadlineViolations(d).filter((v) => !v.startsWith("scanMs")), []);
});

test("the scan body carries full only when it is exactly true", () => {
  const yes = parseScanBody({ target: "npm:left-pad", full: true });
  const no = parseScanBody({ target: "npm:left-pad", full: "true" });
  assert.ok(yes.ok && yes.full === true);
  assert.ok(no.ok && no.full === false);
});

test("ads go through GPT test units; no IMA in the scan screen", () => {
  assert.match(ADS.gpt, /^https:\/\/securepubads\.g\.doubleclick\.net\/tag\/js\/gpt\.js$/);
  assert.ok(ADS.unit.startsWith("/6355419/"), "Google's published GPT sample network");
  assert.ok(ADS.interstitial.startsWith("/6355419/"));
  const ads = readFileSync(new URL("../components/cr/app/Ads.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ads, /imasdk|google\.ima|ima3/);
  assert.match(ads, /OutOfPageFormat\.INTERSTITIAL/);
  const card = readFileSync(new URL("../components/cr/app/ContinueCard.tsx", import.meta.url), "utf8");
  assert.match(card, /This is a very large repo\. Keep installing to scan it fully\?/);
  assert.match(card, /href=\{`\/app\/scan\/\$\{runId\}\/full`\}/);
  assert.match(card, /ANSWER_MS = 15_000/);
});

test("full scans run on heartbeat-kept VMs: 30 s without a heartbeat stops them", () => {
  const e2b = readFileSync(new URL("../lib/engine/sandbox/e2b.ts", import.meta.url), "utf8");
  assert.match(e2b, /timeoutMs: HEARTBEAT_GRACE_MS, metadata: \{ \.\.\.base\.metadata, heartbeat: "1" \}/);
  assert.match(e2b, /Sandbox\.setTimeout\(s\.sandboxId, graceMs, \{ apiKey \}\)/);
  const view = readFileSync(new URL("../components/cr/app/ScanView.tsx", import.meta.url), "utf8");
  assert.match(view, /setInterval\(beat, 10_000\)/);
  assert.match(view, /NEXT_PUBLIC_VERCEL_ENV !== "production"/, "the test card flag never works in production");
  const svc = readFileSync(new URL("../lib/server/scan-service.ts", import.meta.url), "utf8");
  assert.match(svc, /heartbeatSandboxes: true/);
});

test("the scan slot respects Google's 30 s refresh floor and declares refreshes", () => {
  assert.ok(ADS.refreshMs >= 30_000);
  assert.equal(ADS.refreshKey, "refresh");
  const ads = readFileSync(new URL("../components/cr/app/Ads.tsx", import.meta.url), "utf8");
  assert.match(ads, /aspectRatio: "16 \/ 9"/, "the design's video slot");
  assert.match(ads, /export function Interstitial\(\{ runId \}/);
});

test("enough staggered slots to earn 1 paisa a second at ₹100 eCPM, each counted on its own", () => {
  assert.ok(ADS.slotCount >= 4);
  // One impression per slot every refreshMs, 10 paise each at ₹100 eCPM.
  const paisePerSecond = (ADS.slotCount * (100 / 10)) / (ADS.refreshMs / 1000);
  assert.ok(paisePerSecond >= 1, `${paisePerSecond} paise a second`);
  assert.ok(ADS.bannerSizes.phone.every(([, h]) => h <= 50), "phone banners stay small for the 30 % density limit");
  const ads = readFileSync(new URL("../components/cr/app/Ads.tsx", import.meta.url), "utf8");
  assert.match(ads, /n \* FIRST_GAP_MS, n \* STAGGER_MS/, "first ads within seconds, refreshes staggered evenly");
  assert.match(ads, /reportImpression\(runIdRef\.current, "interstitial"\)/);
});

test("Yes continues the running install: the harness holds at the limit and reads the server's flag", () => {
  const sh = readFileSync(new URL("../sandbox/e2b/guest/cr-detonate.sh", import.meta.url), "utf8");
  assert.match(sh, /log "install-at-limit/);
  assert.match(sh, /if \[ -f "\$IN\/keep-installing" \]; then/);
  assert.match(sh, /exec timeout --kill-after=2 "\$INSTALL_MAX"/);
  const e2b = readFileSync(new URL("../lib/engine/sandbox/e2b.ts", import.meta.url), "utf8");
  assert.match(e2b, /files\.write\("\/root\/in\/keep-installing", "1", \{ user: "root" \}\)/);
  const view = readFileSync(new URL("../components/cr/app/ScanView.tsx", import.meta.url), "utf8");
  assert.match(view, /\/api\/scan\/\$\{runId\}\/continue/);
});

test("the test install limit is parsed only in range, and the route honours it on a Preview only", () => {
  const ok = parseScanBody({ target: "npm:left-pad", test_install_limit_s: 15 });
  const no = parseScanBody({ target: "npm:left-pad", test_install_limit_s: 600 });
  assert.ok(ok.ok && ok.testInstallLimitS === 15);
  assert.ok(no.ok && no.testInstallLimitS === undefined);
  const route = readFileSync(new URL("../app/api/scan/route.ts", import.meta.url), "utf8");
  assert.match(route, /process\.env\.VERCEL_ENV === "preview" && parsed\.testInstallLimitS/);
});

test("a pinned package manager is fetched on the real clock before the install, from a folder holding only the pin", () => {
  const sh = readFileSync(new URL("../sandbox/e2b/guest/cr-detonate.sh", import.meta.url), "utf8");
  const prep = sh.indexOf("# ---- 6b. pinned package manager");
  assert.ok(prep > 0 && prep < sh.indexOf("# ---- 7-8. install phase"), "before the install phase");
  const block = sh.slice(prep, sh.indexOf("# ---- 7-8. install phase"));
  assert.match(block, /\^\(npm\|pnpm\|yarn\)@\[0-9\]\+/, "plain registry versions only, never a URL");
  assert.match(block, /LD_PRELOAD=\*\|FAKETIME\*/, "the fake clock is stripped");
  assert.match(block, /AWS_\*\|NPM_TOKEN=\*\|GITHUB_TOKEN=\*\|OPENAI_API_KEY=\*/, "no canaries in its environment");
  assert.match(block, /mktemp -d \/tmp\/cr-pm\./, "an empty folder, not the repo");
  assert.match(block, /check package_manager_ready/);
});
