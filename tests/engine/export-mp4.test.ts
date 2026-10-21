import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AD_CARD_FRAMES,
  adCardHtml,
  exportCost,
  exportUsdPerSecond,
  guestJob,
  isRunId,
  objectName,
  parseProgressLine,
  progressFor,
  replayUrl,
} from "../../lib/server/export-mp4/plan";
import { storageConfigFrom } from "../../lib/server/export-mp4/storage";
import { ADS } from "../../lib/ads-config";

const RUN = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

test("run ids are UUIDs only", () => {
  assert.equal(isRunId(RUN), true);
  assert.equal(isRunId("../etc/passwd"), false);
  assert.equal(isRunId(`${RUN}x`), false);
  assert.equal(objectName(RUN.toUpperCase()), `${RUN}.mp4`);
  assert.throws(() => objectName("nope"));
});

test("replay URL stays on our own origin with replay, export and speed", () => {
  const u = new URL(replayUrl("https://clauderabbit.in", RUN, 4));
  assert.equal(u.origin, "https://clauderabbit.in");
  assert.equal(u.pathname, `/app/scan/${RUN}`);
  assert.equal(u.searchParams.get("replay"), "1");
  assert.equal(u.searchParams.get("export"), "1");
  assert.equal(u.searchParams.get("speed"), "4");
  assert.throws(() => replayUrl("https://clauderabbit.in", "x/../../y"));
});

test("cost is E2B per-second price at 2 vCPU / 2 GiB, in INR at the pinned rate", () => {
  assert.equal(exportUsdPerSecond(), 0.000037);
  const c = exportCost(100, { usd_inr: 94.96, source: "t", as_of: "t" });
  assert.equal(c.usd, 0.0037);
  assert.equal(c.inr, 0.351352);
  assert.equal(exportCost(-5).usd, 0);
});

test("progress is monotonic over phases and capped", () => {
  const seq = [progressFor({ phase: "boot" }), progressFor({ phase: "capture", frames: 0 }), progressFor({ phase: "capture", frames: 900 }), progressFor({ phase: "capture", frames: 1e6 }), progressFor({ phase: "encode" }), progressFor({ phase: "upload" }), progressFor({ phase: "done" })];
  for (let i = 1; i < seq.length; i++) assert.ok((seq[i] as number) >= (seq[i - 1] as number), `step ${i}`);
  assert.equal(seq.at(-1), 100);
  assert.equal(progressFor({ phase: "capture", frames: 1e6 }), 85);
});

test("progress lines parse strictly", () => {
  assert.equal(parseProgressLine("CR_PROGRESS 45"), 45);
  assert.equal(parseProgressLine("CR_PROGRESS -1"), null);
  assert.equal(parseProgressLine("noise"), null);
});

test("ad card is labelled, escaped, swappable and self-contained", () => {
  const html = adCardHtml({ label: "Advertisement", headline: "<b>x</b>", body: "a & b", url: "https://example.com/p" });
  assert.match(html, /Advertisement/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /example\.com/);
  assert.match(html, /ClaudeRabbit/);
  assert.doesNotMatch(html, /<(script|link|img)\b/);
  assert.match(adCardHtml(), new RegExp(ADS.exportSponsor.headline));
});

test("guest job: 1280x720 at 30 fps with 2-second cards", () => {
  const j = guestJob("https://clauderabbit.in/app/scan/x", "/o.mp4");
  assert.equal(j.width, 1280);
  assert.equal(j.height, 720);
  assert.equal(j.fps, 30);
  assert.equal(j.ad_frames, AD_CARD_FRAMES);
  assert.equal(AD_CARD_FRAMES, 60);
  assert.equal(j.require_done, true);
});

test("storage config reads key names only and reports missing names", () => {
  assert.deepEqual(storageConfigFrom({}), { missing: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY"] });
  const c = storageConfigFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co/", SUPABASE_SECRET_KEY: "k" });
  assert.deepEqual(c, { supabaseUrl: "https://p.supabase.co", key: "k" });
});

test("the export page URL: production uses the site origin; a Preview uses its own host with the automation bypass", async () => {
  const { exportPageUrl } = await import("../../lib/server/export-mp4/plan");
  const id = "3d84e8a3-d741-4d80-847f-0deccd00d1ed";
  const prod = new URL(exportPageUrl("https://clauderabbit.in", id, { VERCEL_ENV: "production", VERCEL_URL: "x.vercel.app" }));
  assert.equal(prod.origin, "https://clauderabbit.in");
  assert.equal(prod.searchParams.get("x-vercel-protection-bypass"), null);
  const prev = new URL(exportPageUrl("https://clauderabbit.in", id, { VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "cr-git-20.vercel.app", VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret" }));
  assert.equal(prev.origin, "https://cr-git-20.vercel.app");
  assert.equal(prev.pathname, `/app/scan/${id}`);
  assert.equal(prev.searchParams.get("replay"), "1");
  assert.equal(prev.searchParams.get("export"), "1");
  assert.equal(prev.searchParams.get("x-vercel-protection-bypass"), "s3cret");
  assert.equal(prev.searchParams.get("x-vercel-set-bypass-cookie"), "true");
});

test("the cr-export template is built at the size the export cost assumes", async () => {
  const plan = await import("../../lib/server/export-mp4/plan");
  const build = await import("../../sandbox/e2b/export/build-export.ts");
  assert.equal(build.EXPORT_TEMPLATE_NAME, plan.EXPORT_TEMPLATE_DEFAULT);
  assert.equal(build.EXPORT_TEMPLATE_VCPU, plan.EXPORT_VCPU);
  assert.equal(build.EXPORT_TEMPLATE_MEMORY_MB, plan.EXPORT_MEMORY_MB);
});
