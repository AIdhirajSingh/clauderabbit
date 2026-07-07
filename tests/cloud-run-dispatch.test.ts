/**
 * Unit tests for the pure/config parts of lib/cloud-run-dispatch.ts — the
 * Vercel-native Cloud Run Jobs REST dispatch. The token-minting + HTTP calls need
 * real credentials/network and are proven end-to-end by a real detonation (see the
 * session's run notes); here we lock in the URL shape, the env-override request
 * body, target resolution, and the "is dispatch configured" gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRunBody,
  buildRunUrl,
  cloudRunDispatchConfigured,
  resolveJobTarget,
} from "../lib/cloud-run-dispatch.ts";

test("buildRunUrl targets the Cloud Run Admin v2 :run endpoint", () => {
  const url = buildRunUrl({ project: "my-proj", region: "us-central1", job: "cr-detonation" });
  assert.equal(
    url,
    "https://run.googleapis.com/v2/projects/my-proj/locations/us-central1/jobs/cr-detonation:run",
  );
});

test("buildRunBody overrides only the container env, preserving the job template", () => {
  const body = buildRunBody({
    CR_OWNER: "AmrDab",
    CR_REPO: "clawdcursor",
    CR_COMMIT_SHA: "abc123",
    CR_SCAN_ID: "amrdab-clawdcursor-xyz",
  });
  assert.deepEqual(body, {
    overrides: {
      containerOverrides: [
        {
          env: [
            { name: "CR_OWNER", value: "AmrDab" },
            { name: "CR_REPO", value: "clawdcursor" },
            { name: "CR_COMMIT_SHA", value: "abc123" },
            { name: "CR_SCAN_ID", value: "amrdab-clawdcursor-xyz" },
          ],
        },
      ],
    },
  });
});

test("buildRunBody handles an empty override set (no env)", () => {
  assert.deepEqual(buildRunBody({}), {
    overrides: { containerOverrides: [{ env: [] }] },
  });
});

test("cloudRunDispatchConfigured reflects CR_RUN_SA_JSON presence", () => {
  const prev = process.env.CR_RUN_SA_JSON;
  try {
    delete process.env.CR_RUN_SA_JSON;
    assert.equal(cloudRunDispatchConfigured(), false);
    process.env.CR_RUN_SA_JSON = '{"client_email":"x@y.iam.gserviceaccount.com","private_key":"k"}';
    assert.equal(cloudRunDispatchConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.CR_RUN_SA_JSON;
    else process.env.CR_RUN_SA_JSON = prev;
  }
});

test("resolveJobTarget reads project from the SA JSON and region/job from env with defaults", () => {
  const prev = {
    sa: process.env.CR_RUN_SA_JSON,
    region: process.env.CR_RUN_REGION,
    job: process.env.CR_RUN_JOB_NAME,
    proj: process.env.CR_RUN_PROJECT,
  };
  try {
    delete process.env.CR_RUN_REGION;
    delete process.env.CR_RUN_JOB_NAME;
    delete process.env.CR_RUN_PROJECT;
    process.env.CR_RUN_SA_JSON = JSON.stringify({
      client_email: "cr-dispatch@proj-from-sa.iam.gserviceaccount.com",
      private_key: "fake-not-validated-here",
      project_id: "proj-from-sa",
    });
    const t = resolveJobTarget();
    assert.equal(t.project, "proj-from-sa");
    assert.equal(t.region, "us-central1"); // default
    assert.equal(t.job, "cr-detonation"); // default
  } finally {
    if (prev.sa === undefined) delete process.env.CR_RUN_SA_JSON;
    else process.env.CR_RUN_SA_JSON = prev.sa;
    if (prev.region !== undefined) process.env.CR_RUN_REGION = prev.region;
    if (prev.job !== undefined) process.env.CR_RUN_JOB_NAME = prev.job;
    if (prev.proj !== undefined) process.env.CR_RUN_PROJECT = prev.proj;
  }
});
