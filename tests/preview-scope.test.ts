import { test } from "node:test";
import assert from "node:assert/strict";
import { hidesLegacyRoutes, plainNotFound } from "../lib/server/preview-scope";

test("the 1.0-style report routes are hidden on a Preview only", () => {
  assert.equal(hidesLegacyRoutes({ VERCEL_ENV: "preview" }), true);
  assert.equal(hidesLegacyRoutes({ VERCEL_ENV: "production" }), false);
  assert.equal(hidesLegacyRoutes({}), false);
});

test("the hidden routes answer a plain 404", async () => {
  const res = plainNotFound();
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await res.text(), "Not Found");
});
