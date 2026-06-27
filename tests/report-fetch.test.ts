import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideReportFetch,
  fetchLatestReport,
  fetchLatestReportRest,
} from "../lib/report-fetch.ts";

// ── decideReportFetch — the pure fetch-or-not decision (BUG-16 never-blank) ──

test("decideReportFetch: already-loaded id is a no-op (loaded)", () => {
  assert.equal(decideReportFetch("a/b", true, null, null).kind, "loaded");
});

test("decideReportFetch: an in-flight id is not re-fetched", () => {
  assert.equal(decideReportFetch("a/b", false, "a/b", null).kind, "in-flight");
});

test("decideReportFetch: a known-failed id is NOT auto-retried (negative cache)", () => {
  // The critical loop-prevention: errored id with no loaded report still skips.
  assert.equal(decideReportFetch("a/b", false, null, "a/b").kind, "cached-error");
});

test("decideReportFetch: a clean owner/repo slug yields fetch(owner, repo)", () => {
  const d = decideReportFetch("AmrDab/clawdcursor", false, null, null);
  assert.equal(d.kind, "fetch");
  assert.deepEqual(
    d.kind === "fetch" ? [d.owner, d.repo] : null,
    ["AmrDab", "clawdcursor"],
  );
});

test("decideReportFetch: names with dots/dashes/underscores parse correctly", () => {
  const d = decideReportFetch("sindre.sorhus/p-map_v2", false, null, null);
  assert.deepEqual(
    d.kind === "fetch" ? [d.owner, d.repo] : null,
    ["sindre.sorhus", "p-map_v2"],
  );
});

test("decideReportFetch: null / malformed ids are bad-id (graceful error, never fetch)", () => {
  assert.equal(decideReportFetch(null, false, null, null).kind, "bad-id");
  assert.equal(decideReportFetch("", false, null, null).kind, "bad-id");
  assert.equal(decideReportFetch("noslash", false, null, null).kind, "bad-id");
  assert.equal(decideReportFetch("a/", false, null, null).kind, "bad-id");
  assert.equal(decideReportFetch("/b", false, null, null).kind, "bad-id");
  assert.equal(decideReportFetch("a/b/c", false, null, null).kind, "bad-id");
});

test("decideReportFetch: loaded takes priority over an error flag for the same id", () => {
  assert.equal(decideReportFetch("a/b", true, null, "a/b").kind, "loaded");
});

// ── fetchLatestReport — the shared query + reshape (SSR == SPA parity) ──

function mockClient(result: { data: unknown; error: unknown }): SupabaseClient {
  const qb: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) qb[m] = () => qb;
  qb.maybeSingle = async () => result;
  return { from: () => qb } as unknown as SupabaseClient;
}

const ROW = {
  owner_login: "AmrDab",
  repo_name: "clawdcursor",
  commit_sha: "abc123",
  score: 25,
  verdict: "Malicious",
  cached: false,
  deep: true,
  summary: "A summary.",
  confidence: 90,
  scan_path: "deep",
  stats_json: { loc: "7.2k", packages: 23, stars: "391", created: "2 yr" },
  packages_json: [],
  risky_json: [],
  logs_json: [],
  forensics_json: null,
};

test("fetchLatestReport: reshapes a row into a normalized Report keyed owner/repo", async () => {
  const r = await fetchLatestReport(
    mockClient({ data: ROW, error: null }),
    "AmrDab",
    "clawdcursor",
  );
  assert.ok(r, "expected a Report");
  assert.equal(r!.id, "AmrDab/clawdcursor");
  assert.equal(r!.owner, "AmrDab");
  assert.equal(r!.name, "clawdcursor");
  assert.equal(r!.score, 25);
  assert.equal(r!.verdict, "Malicious");
  assert.equal(r!.deep, true);
  // normalizeReport guarantees array shapes (so the persist validator keeps it).
  assert.ok(Array.isArray(r!.logs));
  assert.ok(Array.isArray(r!.risky));
  assert.ok(Array.isArray(r!.packages));
});

test("fetchLatestReport: normalizes a joined owners ARRAY to a single owner", async () => {
  const row = {
    ...ROW,
    owners: [{ github_login: "AmrDab", display_name: "Amr", established: true }],
  };
  const r = await fetchLatestReport(
    mockClient({ data: row, error: null }),
    "AmrDab",
    "clawdcursor",
  );
  assert.ok(r);
  assert.equal(r!.ownerHistory.handle, "AmrDab");
  assert.equal(r!.ownerHistory.name, "Amr");
});

test("fetchLatestReport: returns null on error, on no-row, and on a thrown client", async () => {
  assert.equal(
    await fetchLatestReport(mockClient({ data: null, error: { message: "boom" } }), "a", "b"),
    null,
  );
  assert.equal(
    await fetchLatestReport(mockClient({ data: null, error: null }), "a", "b"),
    null,
  );
  const throwing = {
    from: () => {
      throw new Error("down");
    },
  } as unknown as SupabaseClient;
  assert.equal(await fetchLatestReport(throwing, "a", "b"), null);
});

// ── fetchLatestReportRest — the SPA's anonymous REST read (never hangs) ──

test("fetchLatestReportRest: reshapes the first row of a successful response", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => [ROW] })) as unknown as typeof fetch;
  try {
    const r = await fetchLatestReportRest("https://x.supabase.co", "anon", "AmrDab", "clawdcursor");
    assert.ok(r);
    assert.equal(r!.id, "AmrDab/clawdcursor");
    assert.equal(r!.score, 25);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchLatestReportRest: non-ok response and empty array both yield null", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: false, json: async () => [] })) as unknown as typeof fetch;
    assert.equal(await fetchLatestReportRest("u", "k", "a", "b"), null);
    globalThis.fetch = (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
    assert.equal(await fetchLatestReportRest("u", "k", "a", "b"), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchLatestReportRest: a thrown/aborted fetch yields null (never hangs the caller)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  try {
    assert.equal(await fetchLatestReportRest("u", "k", "a", "b"), null);
  } finally {
    globalThis.fetch = orig;
  }
});
