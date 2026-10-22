import { test } from "node:test";
import assert from "node:assert/strict";
import { depsFromNameVersionList } from "../../lib/engine/static/osv.ts";
import { isRegistryCall } from "../../lib/engine/forensics/capture.ts";
import type { ForgedCallData } from "../../lib/engine/types.ts";

test("Go modules and Cargo crates the harness lists become OSV queries in their ecosystems", () => {
  assert.deepEqual(depsFromNameVersionList('[{"name":"github.com/google/uuid","version":"1.6.0"},{"name":"x","version":7},"bad"]', "Go"), [
    { ecosystem: "Go", name: "github.com/google/uuid", version: "1.6.0" },
  ]);
  assert.deepEqual(depsFromNameVersionList('[{"name":"serde","version":"1.0.200"}]', "crates.io"), [{ ecosystem: "crates.io", name: "serde", version: "1.0.200" }]);
  assert.deepEqual(depsFromNameVersionList("not json", "Go"), []);
});

test("Go and crates.io registry traffic is registry traffic; the same hosts with a canary are not", () => {
  const call = (host: string, extra: Partial<ForgedCallData> = {}) =>
    ({ host, proto: "https", forged_kind: "registry", canary_hits: [], tls: "intercepted", ...extra }) as unknown as ForgedCallData;
  for (const h of ["proxy.golang.org", "sum.golang.org", "index.crates.io", "static.crates.io"]) {
    assert.equal(isRegistryCall(call(h)), true, h);
    assert.equal(isRegistryCall(call(h, { canary_hits: ["GITHUB_TOKEN"] } as Partial<ForgedCallData>)), false, h);
  }
  assert.equal(isRegistryCall(call("crates.io")), false);
});
