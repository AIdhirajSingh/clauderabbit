import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  GAM_SAMPLE_REWARDED_UNIT,
  GPT_SRC,
  resetRewardedAdState,
  rewardedAdUnit,
  startScanRewardedAd,
  type GoogleTag,
  type RewardedAdEvent,
  type RewardedHost,
} from "../lib/ads/gpt-rewarded.ts";

type Listener = (e: Record<string, unknown>) => void;

function fakeHost(opts: { supported?: boolean } = {}) {
  const appended: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Listener>();
  const calls: string[] = [];
  const slot = { addService: () => slot };
  const pubads = {
    addEventListener(name: string, fn: Listener) {
      listeners.set(name, fn);
      return pubads;
    },
  };
  const tag: GoogleTag = {
    cmd: { push: (fn: () => void) => (fn(), 1) },
    enums: { OutOfPageFormat: { REWARDED: 4 } },
    defineOutOfPageSlot: (unit, format) => {
      calls.push(`define ${unit} ${format}`);
      return opts.supported === false ? null : slot;
    },
    pubads: () => pubads as never,
    enableServices: () => void calls.push("enableServices"),
    display: () => void calls.push("display"),
    destroySlots: () => (calls.push("destroySlots"), true),
    setConfig: (c: { safeFrame?: { forceSafeFrame?: boolean } }) => void calls.push(`setConfig forceSafeFrame=${c.safeFrame?.forceSafeFrame}`),
  };
  const host: RewardedHost = {
    googletag: tag,
    document: {
      getElementById: (id: string) => (appended.some((a) => a.id === id) ? ({} as HTMLElement) : null),
      createElement: () => ({}) as HTMLScriptElement,
      querySelector: ((sel: string) => (sel === "script[nonce]" ? ({ nonce: "bm9uY2Utb2YtdGhlLXBhZ2U=" } as HTMLScriptElement) : null)) as Document["querySelector"],
      head: { appendChild: (n: Record<string, unknown>) => (appended.push(n), n) } as unknown as HTMLHeadElement,
    } as RewardedHost["document"],
  };
  const fire = (name: string, extra: Record<string, unknown> = {}) => listeners.get(name)?.({ slot, ...extra });
  return { host, appended, calls, fire };
}

function recorder() {
  const events: RewardedAdEvent[] = [];
  return { events, log: (e: RewardedAdEvent) => void events.push(e) };
}

beforeEach(() => resetRewardedAdState());

test("rewarded: loads gpt.js once, defines the REWARDED out-of-page slot with Google's sample unit, shows it when ready", () => {
  const h = fakeHost();
  const r = recorder();
  let shown = 0;
  startScanRewardedAd({ host: h.host, log: r.log, unit: rewardedAdUnit(undefined) });
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0]!.src, GPT_SRC);
  assert.equal(h.appended[0]!.async, true);
  assert.equal(h.appended[0]!.nonce, "bm9uY2Utb2YtdGhlLXBhZ2U=", "gpt.js carries the page nonce so GPT can pass it to the scripts it inserts");
  assert.deepEqual(h.calls, ["setConfig forceSafeFrame=true", `define ${GAM_SAMPLE_REWARDED_UNIT} 4`, "enableServices", "display"], "creative in a cross-origin SafeFrame, outside the page CSP");
  h.fire("rewardedSlotReady", { makeRewardedVisible: () => void shown++ });
  assert.equal(shown, 1);
  h.fire("rewardedSlotGranted", { payload: { amount: 1, type: "coins" } });
  h.fire("rewardedSlotClosed");
  assert.deepEqual(r.events, ["requested", "ready", "visible", "granted", "closed"]);
  assert.equal(h.calls.at(-1), "destroySlots");
  // A second scan after close requests a fresh slot and reuses the loaded script.
  startScanRewardedAd({ host: h.host, log: r.log, unit: GAM_SAMPLE_REWARDED_UNIT });
  assert.equal(h.appended.length, 1);
  assert.equal(r.events.at(-1), "requested");
});

test("rewarded: no fill, unsupported page and a blocked script only log; a scan never waits on the ad", () => {
  const h = fakeHost();
  const r = recorder();
  startScanRewardedAd({ host: h.host, log: r.log, unit: GAM_SAMPLE_REWARDED_UNIT });
  startScanRewardedAd({ host: h.host, log: r.log, unit: GAM_SAMPLE_REWARDED_UNIT });
  assert.equal(r.events.at(-1), "already_active");
  h.fire("slotRenderEnded", { isEmpty: true });
  assert.equal(r.events.at(-1), "empty");
  assert.equal(h.calls.at(-1), "destroySlots");

  resetRewardedAdState();
  const u = fakeHost({ supported: false });
  const ru = recorder();
  startScanRewardedAd({ host: u.host, log: ru.log, unit: GAM_SAMPLE_REWARDED_UNIT });
  assert.deepEqual(ru.events, ["unsupported"]);

  resetRewardedAdState();
  const b = fakeHost();
  b.host.googletag = undefined;
  const rb = recorder();
  startScanRewardedAd({ host: b.host, log: rb.log, unit: GAM_SAMPLE_REWARDED_UNIT });
  (b.appended[0]!.onerror as () => void)();
  startScanRewardedAd({ host: b.host, log: rb.log, unit: GAM_SAMPLE_REWARDED_UNIT });
  assert.deepEqual(rb.events, ["load_error", "load_error"]);

  resetRewardedAdState();
  const t = fakeHost();
  t.host.googletag!.defineOutOfPageSlot = () => {
    throw new Error("gpt broke");
  };
  const rt = recorder();
  assert.doesNotThrow(() => startScanRewardedAd({ host: t.host, log: rt.log, unit: GAM_SAMPLE_REWARDED_UNIT }));
  assert.deepEqual(rt.events, ["error"]);
});

test("rewarded: the unit is Google's sample unless a valid unit path overrides it", () => {
  assert.equal(GAM_SAMPLE_REWARDED_UNIT, "/22639388115/rewarded_web_example");
  assert.equal(rewardedAdUnit(undefined), GAM_SAMPLE_REWARDED_UNIT);
  assert.equal(rewardedAdUnit("  "), GAM_SAMPLE_REWARDED_UNIT);
  assert.equal(rewardedAdUnit("javascript:alert(1)"), GAM_SAMPLE_REWARDED_UNIT);
  assert.equal(rewardedAdUnit("/1234567/site/rewarded_scan"), "/1234567/site/rewarded_scan");
});
