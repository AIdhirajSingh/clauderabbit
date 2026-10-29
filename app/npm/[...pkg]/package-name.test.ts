import { test } from "node:test";
import assert from "node:assert/strict";
import { packageName } from "./package-name.ts";

test("scoped report URLs resolve to the scoped package name", () => {
  assert.equal(packageName(["%40isaacs", "string-locale-compare"]), "@isaacs/string-locale-compare");
  assert.equal(packageName(["@isaacs", "string-locale-compare"]), "@isaacs/string-locale-compare");
  assert.equal(packageName(["%40isaacs%2Fstring-locale-compare"]), "@isaacs/string-locale-compare");
  assert.equal(packageName(["left-pad"]), "left-pad");
  assert.equal(packageName(["bad%E0"]), "bad%E0");
  assert.equal(packageName(undefined), "");
});
