import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCause } from "../../lib/engine/build-cause.ts";
import { partialReasonFor } from "../../lib/engine/score.ts";
import type { ForgedCallData } from "../../lib/engine/types.ts";

const call = (host: string, path = "/"): ForgedCallData => ({ phase: "install", proto: "https", host, port: 443, method: "GET", path, req_bytes: 0, forged_kind: "http", canary_hits: [] }) as unknown as ForgedCallData;

test("a build download the forge answered names the line's URL and host", () => {
  const stderr = "npm error gyp http GET https://electronjs.org/headers/v43.8.3/node-v43.8.3-headers.tar.gz\nnpm error gyp ERR! stack Error: TAR_BAD_ARCHIVE: Unrecognized archive format";
  const cause = buildCause({ install: "failed", checks: [], installStderr: stderr, forgedCalls: [call("registry.npmjs.org"), call("electronjs.org", "/headers/v43.8.3/node-v43.8.3-headers.tar.gz")] });
  assert.equal(cause, "the build downloaded https://electronjs.org/headers/v43.8.3/node-v43.8.3-headers.tar.gz, and the sandbox forge answers electronjs.org with a stand-in, so the download was not usable");
  assert.equal(partialReasonFor("failed", "skipped", false, cause), `Build failed (${cause}), so the program never ran`);
});

test("a full disk, the install limit with no answer, and a registry URL", () => {
  assert.equal(buildCause({ install: "failed", checks: [], installStderr: "failed to copy file: No space left on device (os error 28)", forgedCalls: [] }), "the sandbox disk filled up during the install");
  assert.equal(buildCause({ install: "timeout", checks: [{ name: "install_limit", ok: false, detail: "the install reached the 60 s install limit and nobody chose to keep installing" }], installStderr: "", forgedCalls: [] }), "the install reached the 60 s install limit and nobody chose to keep installing");
  assert.equal(buildCause({ install: "failed", checks: [], installStderr: "GET https://registry.npmjs.org/x 404", forgedCalls: [call("registry.npmjs.org")] }), null);
  assert.equal(buildCause({ install: "completed", checks: [], installStderr: "No space left on device", forgedCalls: [] }), null);
  assert.equal(partialReasonFor("failed", "skipped", false), "Build failed, so the program never ran");
});
