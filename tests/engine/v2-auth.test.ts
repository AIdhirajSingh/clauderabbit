/**
 * Server account actions and report reads on schema v2, against PGlite with
 * every migration applied and each statement run as cr_v2_server: CLI token
 * issue, the remote MCP OAuth register / code / redeem round trip including
 * the PKCE grant check, and the v2 report read the public pages use.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { verifyCliToken } from "../../lib/engine/auth.ts";
import { V2Store, type ReportRecord } from "../../lib/engine/store.ts";
import type { ReportPayload } from "../../lib/engine/types.ts";
import { base64Url, codeGrantError } from "../../lib/server/oauth.ts";
import { fetchV2Report, fetchV2Score, fetchV2Slugs } from "../../lib/server/report-v2.ts";
import { createOAuthCode, issueCliToken, redeemOAuthCode, registerOAuthClient, sessionUser } from "../../lib/server/v2-auth.ts";
import { openV2Database, type V2Database } from "../support/pglite-v2.ts";

let v2: V2Database;
let userId: string;

before(async () => {
  v2 = await openV2Database();
  userId = (await v2.pg.query<{ id: string }>("insert into auth.users (email) values ('dev@example.test') returning id::text as id")).rows[0]!.id;
});

after(async () => {
  await v2.close();
});

test("issueCliToken mints a token that verifies; unknown users are refused", async () => {
  const token = await issueCliToken(v2.server, userId);
  assert.match(token, /^cr_cli_[0-9a-f]{64}$/);
  assert.equal(await verifyCliToken(v2.server, token), userId);
  await assert.rejects(issueCliToken(v2.server, "00000000-0000-4000-8000-000000000000"), /unknown user/);
  await assert.rejects(issueCliToken(v2.server, "not-a-uuid"), /not a uuid/);
});

test("OAuth: register, code, redeem once, PKCE grant check, then a token", async () => {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  assert.equal(await registerOAuthClient(v2.server, ["http://evil.example/cb"]), null);
  assert.equal(await registerOAuthClient(v2.server, []), null);
  const clientId = await registerOAuthClient(v2.server, [redirect]);
  assert.match(clientId ?? "", /^cr_client_[0-9a-f]{32}$/);

  const verifier = "v".repeat(64);
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  assert.equal(await createOAuthCode(v2.server, userId, { clientId: clientId!, redirectUri: "https://other.example/cb", codeChallenge: challenge, resource: null }), null);
  assert.equal(await createOAuthCode(v2.server, userId, { clientId: clientId!, redirectUri: redirect, codeChallenge: "short", resource: null }), null);
  const code = await createOAuthCode(v2.server, userId, { clientId: clientId!, redirectUri: redirect, codeChallenge: challenge, resource: "https://clauderabbit.in/mcp" });
  assert.match(code ?? "", /^cr_code_[0-9a-f]{48}$/);

  const row = await redeemOAuthCode(v2.server, code!);
  assert.ok(row);
  assert.equal(row.user_id, userId);
  assert.equal(codeGrantError(row, { clientId: clientId!, redirectUri: redirect, verifier }, Date.now()), null);
  assert.equal(codeGrantError(row, { clientId: clientId!, redirectUri: redirect, verifier: "w".repeat(64) }, Date.now()), "invalid_grant");
  assert.equal(codeGrantError(row, { clientId: clientId!, redirectUri: redirect, verifier }, Date.now() + 6 * 60_000), "invalid_grant");
  assert.equal(await redeemOAuthCode(v2.server, code!), null, "single use");
  assert.equal(await redeemOAuthCode(v2.server, "cr_code_bad"), null);

  const token = await issueCliToken(v2.server, row.user_id);
  assert.equal(await verifyCliToken(v2.server, token), userId);
});

test("sessionUser: no bearer, a CLI token, or no Auth server configured is no session", async () => {
  const cfg = { supabaseUrl: null, supabasePublishableKey: null };
  assert.equal(await sessionUser(v2.server, cfg, null), null);
  assert.equal(await sessionUser(v2.server, cfg, `Bearer cr_cli_${"a".repeat(64)}`), null);
  assert.equal(await sessionUser(v2.server, cfg, "Bearer a.b.c"), null);
});

test("report pages read the v2 report row through the shared reshape", async () => {
  const runId = "55555555-5555-4555-8555-555555555555";
  const payload: ReportPayload = {
    run_id: runId,
    target: "acme/widget",
    commit_sha: "b".repeat(40),
    score: 74,
    verdict: "Low risk",
    band: "blue",
    summary: "No malicious behaviour observed while installing and running the entry point.",
    headline: "Installs cleanly; owner account is new",
    evidence: { behaviour: ["no network calls left the VM"], code: [], reputation: ["owner account is 20 days old"] },
    breakdown: [],
    not_verified: ["Behaviour outside the observed install and entry windows."],
    forensics: null,
    packages: null,
    model_id: "gpt-6-luna",
    template: "clauderabbit-detonate",
    timings: {},
    writer: "deterministic",
  };
  const record: ReportRecord = { runId, targetKind: "github", subject: "acme/widget", ownerLogin: "acme", repoName: "widget", commitSha: payload.commit_sha, report: payload, packages: null, risky: [], logs: [], stats: {} };
  const store = new V2Store(v2.server);
  await store.claimRun({ runId, targetKind: "github", subject: "acme/widget", commitSha: payload.commit_sha, modelId: "gpt-6-luna", template: "t" });
  await store.saveReport(record);
  await store.ownerCache.put({ login: "acme", type: "User", createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), publicRepos: 1 });

  const report = await fetchV2Report(v2.server, "acme", "widget");
  assert.ok(report);
  assert.equal(report.score, 74);
  assert.doesNotMatch(JSON.stringify(report), /"Safe"/, "never a bare Safe");
  assert.equal(await fetchV2Score(v2.server, "acme", "widget"), 74);
  assert.equal(await fetchV2Report(v2.server, "acme", "missing"), null);
  const slugs = await fetchV2Slugs(v2.server);
  assert.equal(slugs[0]?.owner, "acme");
  assert.equal(slugs[0]?.repo, "widget");
  assert.match(slugs[0]?.lastmod ?? "", /^\d{4}-\d{2}-\d{2}T/);
});
